import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { PluginInput } from '@opencode-ai/plugin';
import { syncLocalToRepo, syncRepoToLocal } from './apply.js';
import { generateCommitMessage } from './commit.js';
import type { NormalizedSyncConfig } from './config.js';
import {
  canCommitMcpSecrets,
  hasSecretsBackend,
  isTursoSessionBackend,
  loadOverrides,
  loadState,
  loadSyncConfig,
  normalizeSyncConfig,
  updateState,
  writeSyncConfig,
} from './config.js';
import { SyncCommandError, SyncConfigMissingError } from './errors.js';
import type { SyncLockInfo } from './lock.js';
import { withSyncLock } from './lock.js';
import { buildSyncPlan, resolveRepoRoot, resolveSyncLocations } from './paths.js';
import {
  commitAll,
  ensureRepoCloned,
  ensureRepoPrivate,
  fetchAndFastForward,
  findSyncRepo,
  getAuthenticatedUser,
  getRepoStatus,
  hasLocalChanges,
  isRepoCloned,
  parseRepoReference,
  pushBranch,
  repoExists,
  resolveRepoBranch,
  resolveRepoIdentifier,
} from './repo.js';
import {
  computeSecretsHash,
  createSecretsBackend,
  resolveRepoAuthPaths,
  resolveSecretsBackendConfig,
  type SecretsBackend,
} from './secrets-backend.js';
import {
  createTursoSessionBackend,
  isRetryableTursoError,
  type TursoSyncPreference,
} from './turso.js';
import {
  createLogger,
  extractTextFromResponse,
  resolveSmallModel,
  showToast,
  unwrapData,
} from './utils.js';

type SyncServiceContext = Pick<PluginInput, 'client' | '$'>;
type Logger = ReturnType<typeof createLogger>;
type Shell = PluginInput['$'];

interface InitOptions {
  repo?: string;
  owner?: string;
  name?: string;
  url?: string;
  branch?: string;
  includeSecrets?: boolean;
  includeMcpSecrets?: boolean;
  includeSessions?: boolean;
  sessionBackend?: 'git' | 'turso';
  includePromptStash?: boolean;
  includeModelFavorites?: boolean;
  setupTurso?: boolean;
  migrateSessions?: boolean;
  includeOpencodeSkills?: boolean;
  includeAgentsDir?: boolean;
  create?: boolean;
  private?: boolean;
  extraSecretPaths?: string[];
  extraConfigPaths?: string[];
  localRepoPath?: string;
}

interface LinkOptions {
  repo?: string;
}

export interface SyncService {
  startupSync: () => Promise<void>;
  handleEvent: (_event: unknown) => Promise<void>;
  status: () => Promise<string>;
  init: (_options: InitOptions) => Promise<string>;
  link: (_options: LinkOptions) => Promise<string>;
  pull: () => Promise<string>;
  push: () => Promise<string>;
  secretsPull: () => Promise<string>;
  secretsPush: () => Promise<string>;
  secretsStatus: () => Promise<string>;
  enableSecrets: (_options?: {
    extraSecretPaths?: string[];
    includeMcpSecrets?: boolean;
  }) => Promise<string>;
  sessionsBackend: (_options: {
    backend?: 'git' | 'turso';
    setupTurso?: boolean;
    migrateSessions?: boolean;
  }) => Promise<string>;
  sessionsSetupTurso: (_options?: { forceTokenRefresh?: boolean }) => Promise<string>;
  sessionsMigrateTurso: (_options?: { setupTurso?: boolean }) => Promise<string>;
  sessionsCleanupGit: () => Promise<string>;
  resolve: () => Promise<string>;
}

export function createSyncService(ctx: SyncServiceContext): SyncService {
  const locations = resolveSyncLocations();
  const log = createLogger(ctx.client);
  const lockPath = path.join(path.dirname(locations.statePath), 'sync.lock');
  const strictLinkRepo = resolveStrictLinkRepo(process.env.OPENCODE_SYNC_E2E_STRICT_LINK_REPO);
  const disableAutoRepoDiscovery =
    process.env.OPENCODE_SYNC_E2E_DISABLE_AUTO_REPO_DISCOVERY === '1' || strictLinkRepo !== null;
  let tursoSyncTimer: ReturnType<typeof setInterval> | null = null;
  let tursoSyncIntervalSec = 15;
  const activeSessionIds = new Set<string>();
  const pendingTursoSyncReasons = new Set<string>();
  let tursoIdleFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let tursoFlushInFlight = false;

  const formatLockInfo = (info: SyncLockInfo | null): string => {
    if (!info) return 'Another sync is already in progress.';
    return `Another sync is already in progress (pid ${info.pid} on ${info.hostname}, started ${info.startedAt}).`;
  };

  const runExclusive = <T>(fn: () => Promise<T>): Promise<T> =>
    withSyncLock(
      lockPath,
      {
        onBusy: (info) => {
          throw new SyncCommandError(formatLockInfo(info));
        },
      },
      fn
    );

  const skipIfBusy = (fn: () => Promise<void>): Promise<void> =>
    withSyncLock(
      lockPath,
      {
        onBusy: (info) => {
          log.debug('Sync already running, skipping', {
            pid: info?.pid,
            hostname: info?.hostname,
            startedAt: info?.startedAt,
          });
          return;
        },
      },
      fn
    );

  const resolveSecretsBackend = (config: NormalizedSyncConfig): SecretsBackend | null => {
    const resolution = resolveSecretsBackendConfig(config);
    if (resolution.state === 'none') {
      return null;
    }

    if (resolution.state === 'invalid') {
      throw new SyncCommandError(resolution.error);
    }

    return createSecretsBackend({ $: ctx.$, locations, config: resolution.config });
  };

  const ensureAuthFilesNotTracked = async (
    repoRoot: string,
    config: NormalizedSyncConfig
  ): Promise<void> => {
    if (!hasSecretsBackend(config)) return;

    const { authRepoPath, mcpAuthRepoPath } = resolveRepoAuthPaths(repoRoot);
    const tracked: string[] = [];
    const authRelPath = toRepoRelativePath(repoRoot, authRepoPath);
    const mcpRelPath = toRepoRelativePath(repoRoot, mcpAuthRepoPath);

    if (await isRepoPathTracked(ctx.$, repoRoot, authRelPath)) {
      tracked.push(authRelPath);
    }
    if (await isRepoPathTracked(ctx.$, repoRoot, mcpRelPath)) {
      tracked.push(mcpRelPath);
    }

    if (tracked.length === 0) return;

    const trackedList = tracked.join(', ');
    throw new SyncCommandError(
      `Sync repo already tracks secret auth files (${trackedList}). ` +
        'Remove them and rewrite history before enabling a secrets backend.'
    );
  };

  const computeSecretsHashSafe = async (): Promise<string | null> => {
    try {
      return await computeSecretsHash(locations);
    } catch (error) {
      log.warn('Failed to compute secrets hash', { error: formatError(error) });
      return null;
    }
  };

  const updateSecretsHashState = async (): Promise<void> => {
    const hash = await computeSecretsHashSafe();
    if (!hash) return;
    await updateState(locations, { lastSecretsHash: hash });
  };

  const pushSecretsWithBackend = async (backend: SecretsBackend): Promise<'skipped' | 'pushed'> => {
    const hash = await computeSecretsHashSafe();
    if (hash) {
      const state = await loadState(locations);
      if (state.lastSecretsHash === hash) {
        log.debug('Secrets unchanged; skipping secrets push');
        return 'skipped';
      }
    }

    await backend.push();
    if (hash) {
      await updateState(locations, { lastSecretsHash: hash });
    }
    return 'pushed';
  };

  const runSecretsPullIfConfigured = async (config: NormalizedSyncConfig): Promise<void> => {
    const backend = resolveSecretsBackend(config);
    if (!backend) return;
    await backend.pull();
    await updateSecretsHashState();
  };

  const runSecretsPushIfConfigured = async (
    config: NormalizedSyncConfig
  ): Promise<'not_configured' | 'skipped' | 'pushed'> => {
    const backend = resolveSecretsBackend(config);
    if (!backend) return 'not_configured';
    return await pushSecretsWithBackend(backend);
  };

  const secretsBackendNotConfiguredMessage =
    'Secrets backend not configured. Add secretsBackend to opencode-synced.jsonc.';

  const resolveSecretsBackendForCommand = async (): Promise<
    { backend: SecretsBackend } | { message: string }
  > => {
    const config = await getConfigOrThrow(locations);
    const resolution = resolveSecretsBackendConfig(config);
    if (resolution.state === 'none') {
      return {
        message: secretsBackendNotConfiguredMessage,
      };
    }
    if (resolution.state === 'invalid') {
      throw new SyncCommandError(resolution.error);
    }
    return {
      backend: createSecretsBackend({
        $: ctx.$,
        locations,
        config: resolution.config,
      }),
    };
  };

  const runSecretsCommand = async (
    action: (backend: SecretsBackend) => Promise<string>
  ): Promise<string> => {
    const resolved = await resolveSecretsBackendForCommand();
    if ('message' in resolved) {
      return resolved.message;
    }
    return await action(resolved.backend);
  };

  const stopTursoSyncLoop = (): void => {
    if (!tursoSyncTimer) return;
    clearInterval(tursoSyncTimer);
    tursoSyncTimer = null;
    if (tursoIdleFlushTimer) {
      clearTimeout(tursoIdleFlushTimer);
      tursoIdleFlushTimer = null;
    }
  };

  const sleep = async (ms: number): Promise<void> =>
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  const formatTursoCycleSummary = (cycle: {
    pullBefore: { status: string };
    push: { status: string };
    pullAfter: { status: string };
  }): string => {
    return `Turso sessions cycle: pull=${cycle.pullBefore.status}, push=${cycle.push.status}, pull=${cycle.pullAfter.status}`;
  };

  const resolveTursoPreferenceFromReasons = (
    reasons: string[],
    trigger: string
  ): TursoSyncPreference => {
    const values = [trigger, ...reasons].map((entry) => entry.toLowerCase());
    const hasPush = values.some((entry) => entry.includes('push') || entry.includes('migrate'));
    const hasPull = values.some(
      (entry) => entry.includes('pull') || entry.includes('startup') || entry.includes('link')
    );
    if (hasPush) return 'push';
    if (hasPull) return 'pull';
    return 'auto';
  };

  const runTursoSetup = async (
    config: NormalizedSyncConfig,
    options: { allowLogin: boolean; forceTokenRefresh?: boolean; allowAutoInstall?: boolean }
  ) => {
    const backend = createTursoSessionBackend({ locations, config, log });
    return await backend.ensureSetup({
      allowLogin: options.allowLogin,
      forceTokenRefresh: options.forceTokenRefresh,
      allowAutoInstall: options.allowAutoInstall ?? config.sessionBackend.turso.autoSetup,
    });
  };

  const runTursoCycleWithRetry = async (
    config: NormalizedSyncConfig,
    reason: string,
    options: { attempts?: number; preference?: TursoSyncPreference; allowLocalPull?: boolean } = {}
  ): Promise<{ summary: string }> => {
    const backend = createTursoSessionBackend({ locations, config, log });
    const attempts = options.attempts ?? 3;
    const preference = options.preference ?? 'auto';
    const allowLocalPull = options.allowLocalPull ?? true;
    let backoffMs = 500;
    let attempt = 1;

    while (attempt <= attempts) {
      try {
        const cycle = await backend.syncCycle({ preference, allowLocalPull });
        const now = new Date().toISOString();
        const stateUpdate: { lastSessionPull?: string; lastSessionPush?: string } = {};
        if (cycle.pullBefore.status !== 'skipped' || cycle.pullAfter.status !== 'skipped') {
          stateUpdate.lastSessionPull = now;
        }
        if (cycle.push.status !== 'skipped') {
          stateUpdate.lastSessionPush = now;
        }
        if (stateUpdate.lastSessionPull || stateUpdate.lastSessionPush) {
          await updateState(locations, stateUpdate);
        }

        return { summary: formatTursoCycleSummary(cycle) };
      } catch (error) {
        const retryable = isRetryableTursoError(error);
        if (attempt < attempts && retryable) {
          log.warn('Retrying Turso session sync cycle', {
            reason,
            attempt,
            preference,
            allowLocalPull,
            error: formatError(error),
            backoffMs,
          });
          await sleep(backoffMs);
          backoffMs *= 2;
          attempt += 1;
          continue;
        }
        throw error;
      }
    }

    throw new SyncCommandError(`Turso session sync failed after ${attempts} attempts (${reason}).`);
  };

  const refreshActiveSessionsFromServer = async (): Promise<boolean> => {
    try {
      const response = await ctx.client.session.status({});
      const statusMap = unwrapData<Record<string, unknown>>(response);
      if (!isRecord(statusMap)) {
        return false;
      }

      activeSessionIds.clear();
      for (const [sessionId, status] of Object.entries(statusMap)) {
        if (isBusySessionStatus(status)) {
          activeSessionIds.add(sessionId);
        }
      }
      return true;
    } catch (error) {
      log.warn('Failed to query session activity state', { error: formatError(error) });
      return false;
    }
  };

  const areAllSessionsIdle = async (): Promise<boolean> => {
    const first = await refreshActiveSessionsFromServer();
    if (!first || activeSessionIds.size > 0) {
      return false;
    }
    await sleep(200);

    const second = await refreshActiveSessionsFromServer();
    if (!second) {
      return false;
    }
    return activeSessionIds.size === 0;
  };

  const queueTursoSync = (reason: string): void => {
    pendingTursoSyncReasons.add(reason);
  };

  const flushQueuedTursoSync = async (
    trigger: string,
    latestConfig?: NormalizedSyncConfig | null
  ): Promise<{ summary?: string; warning?: string; deferred: boolean }> => {
    if (pendingTursoSyncReasons.size === 0) {
      return { deferred: false };
    }
    if (tursoFlushInFlight) {
      return { deferred: true };
    }

    tursoFlushInFlight = true;
    try {
      const latest = latestConfig ?? (await loadSyncConfig(locations));
      if (!latest || !isTursoSessionBackend(latest)) {
        pendingTursoSyncReasons.clear();
        stopTursoSyncLoop();
        return { deferred: false };
      }

      const idle = await areAllSessionsIdle();
      if (!idle) {
        return { deferred: true };
      }

      const reasons = [...pendingTursoSyncReasons];
      pendingTursoSyncReasons.clear();
      const preference = resolveTursoPreferenceFromReasons(reasons, trigger);
      const allowLocalPull = trigger === 'startup';

      try {
        const cycle = await runTursoCycleWithRetry(latest, `${trigger}:${reasons.join(',')}`, {
          preference,
          allowLocalPull,
        });
        return { summary: cycle.summary, deferred: false };
      } catch (error) {
        for (const reason of reasons) {
          pendingTursoSyncReasons.add(reason);
        }
        const warning = `Turso session sync warning: ${formatError(error)}`;
        log.warn(warning, { trigger, reasons });
        return { warning, deferred: false };
      }
    } finally {
      tursoFlushInFlight = false;
    }
  };

  const scheduleTursoIdleFlush = (): void => {
    if (tursoIdleFlushTimer) {
      return;
    }
    tursoIdleFlushTimer = setTimeout(() => {
      tursoIdleFlushTimer = null;
      void skipIfBusy(async () => {
        await flushQueuedTursoSync('idle-event');
      });
    }, 250);
  };

  const runForegroundTursoCycle = async (
    config: NormalizedSyncConfig,
    reason: string
  ): Promise<string | null> => {
    if (!isTursoSessionBackend(config)) return null;
    queueTursoSync(reason);
    scheduleTursoIdleFlush();
    return 'Turso sessions sync queued; runtime local pull is deferred until startup.';
  };

  const runTursoStartupPull = async (config: NormalizedSyncConfig): Promise<string | null> => {
    if (!isTursoSessionBackend(config)) return null;
    const setup = await runTursoSetup(config, { allowLogin: false });
    if (!setup.ready) {
      return `Turso session setup pending: ${setup.message}`;
    }

    queueTursoSync('startup');
    const result = await flushQueuedTursoSync('startup', config);
    if (result.deferred) {
      scheduleTursoIdleFlush();
      return 'Turso startup sync deferred until all sessions are idle.';
    }
    if (result.warning) {
      return result.warning;
    }
    if (result.summary) {
      return `Turso startup sync: ${result.summary}`;
    }
    return null;
  };

  const ensureTursoSyncLoop = (config: NormalizedSyncConfig): void => {
    if (!isTursoSessionBackend(config)) {
      stopTursoSyncLoop();
      return;
    }

    const nextInterval = config.sessionBackend.turso.syncIntervalSec;
    if (tursoSyncTimer && tursoSyncIntervalSec === nextInterval) {
      return;
    }

    stopTursoSyncLoop();
    tursoSyncIntervalSec = nextInterval;
    tursoSyncTimer = setInterval(() => {
      void skipIfBusy(async () => {
        const latest = await loadSyncConfig(locations);
        if (!latest || !isTursoSessionBackend(latest)) {
          stopTursoSyncLoop();
          return;
        }

        queueTursoSync('background');
        const result = await flushQueuedTursoSync('background', latest);
        if (result.deferred) {
          return;
        }
        if (result.warning) {
          log.warn(result.warning, { reason: 'background' });
        }
      });
    }, nextInterval * 1000);
  };

  const onEvent = async (event: unknown): Promise<void> => {
    if (!isRecord(event)) {
      return;
    }

    const eventType = typeof event.type === 'string' ? event.type : '';
    const properties = isRecord(event.properties) ? event.properties : null;
    if (!properties) {
      return;
    }

    let idleSignal = false;
    if (eventType === 'session.status') {
      const sessionId = typeof properties.sessionID === 'string' ? properties.sessionID : null;
      const status = isRecord(properties.status) ? properties.status : null;
      const statusType = status && typeof status.type === 'string' ? status.type : null;
      if (sessionId && statusType === 'idle') {
        activeSessionIds.delete(sessionId);
        idleSignal = true;
      } else if (sessionId) {
        activeSessionIds.add(sessionId);
      }
    } else if (eventType === 'session.idle') {
      const sessionId = typeof properties.sessionID === 'string' ? properties.sessionID : null;
      if (sessionId) {
        activeSessionIds.delete(sessionId);
        idleSignal = true;
      }
    } else if (eventType === 'session.deleted') {
      const info = isRecord(properties.info) ? properties.info : null;
      const sessionId = info && typeof info.id === 'string' ? info.id : null;
      if (sessionId) {
        activeSessionIds.delete(sessionId);
        idleSignal = true;
      }
    }

    if (idleSignal && pendingTursoSyncReasons.size > 0) {
      scheduleTursoIdleFlush();
    }
  };

  return {
    handleEvent: async (event: unknown) => {
      await onEvent(event);
    },
    startupSync: () =>
      skipIfBusy(async () => {
        let config: ReturnType<typeof normalizeSyncConfig> | null = null;
        try {
          config = await loadSyncConfig(locations);
        } catch (error) {
          const message = `Failed to load opencode-synced config: ${formatError(error)}`;
          log.error(message, { path: locations.syncConfigPath });
          await showToast(
            ctx.client,
            `Failed to load opencode-synced config. Check ${locations.syncConfigPath} for JSON errors.`,
            'error'
          );
          return;
        }
        if (!config) {
          stopTursoSyncLoop();
          await showToast(
            ctx.client,
            'Configure opencode-synced with /sync-init or link to an existing repo with /sync-link',
            'info'
          );
          return;
        }
        try {
          assertValidSecretsBackend(config);
          let tursoWarning: string | null = null;
          if (isTursoSessionBackend(config)) {
            try {
              tursoWarning = await runTursoStartupPull(config);
            } catch (error) {
              tursoWarning = `Turso session startup pull failed: ${formatError(error)}`;
            }
          }

          await runStartup(ctx, locations, config, log, {
            ensureAuthFilesNotTracked,
            runSecretsPullIfConfigured,
          });
          ensureTursoSyncLoop(config);
          if (tursoWarning) {
            log.warn(tursoWarning);
            await showToast(ctx.client, tursoWarning, 'warning');
          }
        } catch (error) {
          log.error('Startup sync failed', { error: formatError(error) });
          await showToast(ctx.client, formatError(error), 'error');
        }
      }),
    status: async () => {
      const config = await loadSyncConfig(locations);
      if (!config) {
        return 'opencode-synced is not configured. Run /sync-init to set it up.';
      }

      assertValidSecretsBackend(config);

      const repoRoot = resolveRepoRoot(config, locations);
      const state = await loadState(locations);
      let repoStatus: string[] = [];
      let branch = resolveRepoBranch(config);

      const cloned = await isRepoCloned(repoRoot);
      if (!cloned) {
        repoStatus = ['Repo not cloned'];
      } else {
        try {
          const status = await getRepoStatus(ctx.$, repoRoot);
          repoStatus = status.changes;
          branch = status.branch;
        } catch {
          repoStatus = ['Repo status unavailable'];
        }
      }

      const repoIdentifier = resolveRepoIdentifier(config);
      const includeSecrets = config.includeSecrets ? 'enabled' : 'disabled';
      const includeMcpSecrets = config.includeMcpSecrets ? 'enabled' : 'disabled';
      const includeSessions = config.includeSessions ? 'enabled' : 'disabled';
      const sessionBackendType = config.sessionBackend.type;
      const sessionBackendLabel = !config.includeSessions
        ? `${sessionBackendType} (inactive; includeSessions disabled)`
        : sessionBackendType === 'turso'
          ? 'turso (concurrent-safe backend enabled)'
          : 'git (best effort, may conflict with concurrent writers)';
      const includePromptStash = config.includePromptStash ? 'enabled' : 'disabled';
      const includeModelFavorites = config.includeModelFavorites ? 'enabled' : 'disabled';
      const includeOpencodeSkills = config.includeOpencodeSkills ? 'enabled' : 'disabled';
      const includeAgentsDir = config.includeAgentsDir ? 'enabled' : 'disabled';
      const secretsBackend = config.secretsBackend?.type ?? 'none';
      const lastPull = state.lastPull ?? 'never';
      const lastPush = state.lastPush ?? 'never';
      const lastSessionPull = state.lastSessionPull ?? 'never';
      const lastSessionPush = state.lastSessionPush ?? 'never';
      let tursoStatusLine: string | null = null;
      if (config.includeSessions && sessionBackendType === 'turso') {
        try {
          const tursoStatus = await createTursoSessionBackend({ locations, config, log }).status();
          tursoStatusLine = `Turso status: ${tursoStatus}`;
        } catch (error) {
          tursoStatusLine = `Turso status: unavailable (${formatError(error)})`;
        }
      }

      let changesLabel = 'clean';
      if (!cloned) {
        changesLabel = 'not cloned';
      } else if (repoStatus.length > 0) {
        if (repoStatus[0] === 'Repo status unavailable') {
          changesLabel = 'unknown';
        } else {
          changesLabel = `${repoStatus.length} pending`;
        }
      }
      const statusLines = [
        `Repo: ${repoIdentifier}`,
        `Branch: ${branch}`,
        `Secrets: ${includeSecrets}`,
        `Secrets backend: ${secretsBackend}`,
        `MCP secrets: ${includeMcpSecrets}`,
        `Sessions: ${includeSessions}`,
        `Session backend: ${sessionBackendLabel}`,
        `Last session pull: ${lastSessionPull}`,
        `Last session push: ${lastSessionPush}`,
        `Prompt stash: ${includePromptStash}`,
        `Model favorites: ${includeModelFavorites}`,
        `Skills: ${includeOpencodeSkills}`,
        `Home .agents: ${includeAgentsDir}`,
        `Last pull: ${lastPull}`,
        `Last push: ${lastPush}`,
        `Working tree: ${changesLabel}`,
      ];
      if (tursoStatusLine) {
        statusLines.push(tursoStatusLine);
      }

      return statusLines.join('\n');
    },
    init: (options: InitOptions) =>
      runExclusive(async () => {
        const config = await buildConfigFromInit(ctx.$, options);

        const repoIdentifier = resolveRepoIdentifier(config);
        const isPrivate = options.private ?? true;

        const exists = await repoExists(ctx.$, repoIdentifier);
        let created = false;
        if (!exists) {
          await createRepo(ctx.$, config, isPrivate);
          created = true;
        }

        await writeSyncConfig(locations, config);
        const repoRoot = resolveRepoRoot(config, locations);
        await ensureRepoCloned(ctx.$, config, repoRoot);
        await ensureSecretsPolicy(ctx, config);

        const initNotes: string[] = [];
        if (isTursoSessionBackend(config) && options.setupTurso !== false) {
          const setup = await runTursoSetup(config, { allowLogin: true });
          initNotes.push(setup.message);
          if (setup.loginUrl) {
            initNotes.push(`Complete Turso login at: ${setup.loginUrl}`);
          }
          if (setup.loginCode) {
            initNotes.push(`Login code: ${setup.loginCode}`);
          }
        }

        if (isTursoSessionBackend(config) && options.migrateSessions) {
          const cycle = await runTursoCycleWithRetry(config, 'init-migrate', {
            preference: 'push',
          });
          initNotes.push(`Session bootstrap: ${cycle.summary}`);
        }

        if (created) {
          const overrides = await loadOverrides(locations);
          const plan = buildSyncPlan(config, locations, repoRoot);
          await syncLocalToRepo(plan, overrides, {
            overridesPath: locations.overridesPath,
            allowMcpSecrets: canCommitMcpSecrets(config),
          });

          const dirty = await hasLocalChanges(ctx.$, repoRoot);
          if (dirty) {
            const branch = resolveRepoBranch(config);
            await commitAll(ctx.$, repoRoot, 'Initial sync from opencode-synced');
            await pushBranch(ctx.$, repoRoot, branch);
            await updateState(locations, { lastPush: new Date().toISOString() });
          }
        }

        const lines = [
          'opencode-synced configured.',
          `Repo: ${repoIdentifier}${created ? ' (created)' : ''}`,
          `Branch: ${resolveRepoBranch(config)}`,
          `Local repo: ${repoRoot}`,
        ];
        if (initNotes.length > 0) {
          lines.push('', ...initNotes);
        }
        ensureTursoSyncLoop(config);

        return lines.join('\n');
      }),
    link: (options: LinkOptions) =>
      runExclusive(async () => {
        if (disableAutoRepoDiscovery && !options.repo) {
          const expectation = strictLinkRepo
            ? ` Provide the exact repo: ${strictLinkRepo.owner}/${strictLinkRepo.name}.`
            : '';
          throw new SyncCommandError(
            'Repo auto-discovery is disabled in this environment. ' +
              'Run /sync-link with an explicit repo argument.' +
              expectation
          );
        }

        const found = await findSyncRepo(ctx.$, options.repo, {
          disableAutoDiscovery: disableAutoRepoDiscovery,
        });

        if (!found) {
          const searchedFor = options.repo
            ? `"${options.repo}"`
            : disableAutoRepoDiscovery
              ? '(none; auto-discovery disabled)'
              : 'common sync repo names (my-opencode-config, opencode-config, etc.)';

          const lines = [
            `Could not find an existing sync repo. Searched for: ${searchedFor}`,
            '',
            'To link to an existing repo, run:',
            '  /sync-link <owner/repo>',
            '',
            'To create a new sync repo, run:',
            '  /sync-init',
          ];
          return lines.join('\n');
        }

        if (strictLinkRepo) {
          const linkedIdentifier = `${found.owner}/${found.name}`.toLowerCase();
          const expectedIdentifier = `${strictLinkRepo.owner}/${strictLinkRepo.name}`.toLowerCase();
          if (linkedIdentifier !== expectedIdentifier) {
            throw new SyncCommandError(
              `Strict link mode expected repo ${strictLinkRepo.owner}/${strictLinkRepo.name}, ` +
                `but resolved ${found.owner}/${found.name}.`
            );
          }
        }

        const config = normalizeSyncConfig({
          repo: { owner: found.owner, name: found.name },
          includeSecrets: false,
          includeMcpSecrets: false,
          includeSessions: false,
          includePromptStash: false,
          extraSecretPaths: [],
          extraConfigPaths: [],
        });

        await writeSyncConfig(locations, config);
        const repoRoot = resolveRepoRoot(config, locations);
        await ensureRepoCloned(ctx.$, config, repoRoot);

        const branch = await resolveBranch(ctx, config, repoRoot);

        await fetchAndFastForward(ctx.$, repoRoot, branch);

        const overrides = await loadOverrides(locations);
        const plan = buildSyncPlan(config, locations, repoRoot);
        await syncRepoToLocal(plan, overrides);

        await updateState(locations, {
          lastPull: new Date().toISOString(),
          lastRemoteUpdate: new Date().toISOString(),
        });

        const linkNotes: string[] = [];
        const syncedConfig = await loadSyncConfig(locations);
        if (syncedConfig && isTursoSessionBackend(syncedConfig)) {
          const setup = await runTursoSetup(syncedConfig, { allowLogin: true });
          linkNotes.push(setup.message);
          if (setup.loginUrl) {
            linkNotes.push(`Complete Turso login at: ${setup.loginUrl}`);
          }
          if (setup.loginCode) {
            linkNotes.push(`Login code: ${setup.loginCode}`);
          }
          ensureTursoSyncLoop(syncedConfig);
        } else if (syncedConfig) {
          ensureTursoSyncLoop(syncedConfig);
        }

        const lines = [
          `Linked to existing sync repo: ${found.owner}/${found.name}`,
          '',
          'Your local opencode config has been OVERWRITTEN with the synced config.',
          'Your local overrides file was preserved and applied on top.',
          '',
          'Restart opencode to apply the new settings.',
          '',
          found.isPrivate
            ? 'To enable secrets sync, run: /sync-enable-secrets'
            : 'Note: Repo is public. Secrets sync is disabled.',
        ];
        if (linkNotes.length > 0) {
          lines.push('', ...linkNotes);
        }

        await showToast(ctx.client, 'Config synced. Restart opencode to apply.', 'info');
        return lines.join('\n');
      }),
    pull: () =>
      runExclusive(async () => {
        const config = await getConfigOrThrow(locations);
        const repoRoot = resolveRepoRoot(config, locations);
        await ensureRepoCloned(ctx.$, config, repoRoot);
        await ensureSecretsPolicy(ctx, config);
        await ensureAuthFilesNotTracked(repoRoot, config);

        const branch = await resolveBranch(ctx, config, repoRoot);

        const dirty = await hasLocalChanges(ctx.$, repoRoot);
        if (dirty) {
          throw new SyncCommandError(
            `Local sync repo has uncommitted changes. Resolve in ${repoRoot} before pulling.`
          );
        }

        const update = await fetchAndFastForward(ctx.$, repoRoot, branch);
        if (!update.updated) {
          const tursoSummary = await runForegroundTursoCycle(config, 'pull-up-to-date');
          ensureTursoSyncLoop(config);
          if (tursoSummary) {
            return ['Already up to date.', tursoSummary].join('\n');
          }
          return 'Already up to date.';
        }

        const overrides = await loadOverrides(locations);
        const plan = buildSyncPlan(config, locations, repoRoot);
        await syncRepoToLocal(plan, overrides);
        await runSecretsPullIfConfigured(config);

        await updateState(locations, {
          lastPull: new Date().toISOString(),
          lastRemoteUpdate: new Date().toISOString(),
        });

        const tursoSummary = await runForegroundTursoCycle(config, 'pull-updated');
        ensureTursoSyncLoop(config);

        await showToast(ctx.client, 'Config updated. Restart opencode to apply.', 'info');
        if (tursoSummary) {
          return [
            'Remote config applied. Restart opencode to use new settings.',
            tursoSummary,
          ].join('\n');
        }
        return 'Remote config applied. Restart opencode to use new settings.';
      }),
    push: () =>
      runExclusive(async () => {
        const config = await getConfigOrThrow(locations);
        const repoRoot = resolveRepoRoot(config, locations);
        await ensureRepoCloned(ctx.$, config, repoRoot);
        await ensureSecretsPolicy(ctx, config);
        await ensureAuthFilesNotTracked(repoRoot, config);
        const branch = await resolveBranch(ctx, config, repoRoot);

        const preDirty = await hasLocalChanges(ctx.$, repoRoot);
        if (preDirty) {
          throw new SyncCommandError(
            `Local sync repo has uncommitted changes. Resolve in ${repoRoot} before pushing.`
          );
        }

        const overrides = await loadOverrides(locations);
        const plan = buildSyncPlan(config, locations, repoRoot);
        await syncLocalToRepo(plan, overrides, {
          overridesPath: locations.overridesPath,
          allowMcpSecrets: canCommitMcpSecrets(config),
        });

        const dirty = await hasLocalChanges(ctx.$, repoRoot);
        if (!dirty) {
          const tursoSummary = await runForegroundTursoCycle(config, 'push-no-config-diff');
          ensureTursoSyncLoop(config);
          try {
            const secretsResult = await runSecretsPushIfConfigured(config);
            const lines: string[] = [];
            if (secretsResult === 'pushed') {
              lines.push('No local changes to push. Secrets updated.');
            } else if (secretsResult === 'skipped') {
              lines.push('No local changes to push. Secrets unchanged.');
            } else {
              lines.push('No local changes to push.');
            }
            if (tursoSummary) {
              lines.push(tursoSummary);
            }
            return lines.join('\n');
          } catch (error) {
            log.warn('Secrets push failed after sync check', { error: formatError(error) });
            const lines = [`No local changes to push. Secrets push failed: ${formatError(error)}`];
            if (tursoSummary) {
              lines.push(tursoSummary);
            }
            return lines.join('\n');
          }
        }

        const message = await generateCommitMessage({ client: ctx.client, $: ctx.$ }, repoRoot);
        await commitAll(ctx.$, repoRoot, message);
        await pushBranch(ctx.$, repoRoot, branch);

        let secretsFailure: string | null = null;
        try {
          await runSecretsPushIfConfigured(config);
        } catch (error) {
          secretsFailure = formatError(error);
          log.warn('Secrets push failed after repo push', { error: secretsFailure });
        }

        await updateState(locations, {
          lastPush: new Date().toISOString(),
        });

        const tursoSummary = await runForegroundTursoCycle(config, 'push-updated');
        ensureTursoSyncLoop(config);

        if (secretsFailure) {
          const lines = [`Pushed changes: ${message}. Secrets push failed: ${secretsFailure}`];
          if (tursoSummary) {
            lines.push(tursoSummary);
          }
          return lines.join('\n');
        }
        if (tursoSummary) {
          return [`Pushed changes: ${message}`, tursoSummary].join('\n');
        }
        return `Pushed changes: ${message}`;
      }),
    secretsPull: () =>
      runExclusive(() =>
        runSecretsCommand(async (backend) => {
          await backend.pull();
          await updateSecretsHashState();
          return 'Pulled secrets from 1Password.';
        })
      ),
    secretsPush: () =>
      runExclusive(() =>
        runSecretsCommand(async (backend) => {
          const result = await pushSecretsWithBackend(backend);
          if (result === 'skipped') {
            return 'Secrets unchanged; skipping 1Password push.';
          }
          return 'Pushed secrets to 1Password.';
        })
      ),
    secretsStatus: () =>
      runExclusive(() =>
        runSecretsCommand(async (backend) => {
          return await backend.status();
        })
      ),
    enableSecrets: (options?: { extraSecretPaths?: string[]; includeMcpSecrets?: boolean }) =>
      runExclusive(async () => {
        const config = await getConfigOrThrow(locations);
        config.includeSecrets = true;
        if (options?.extraSecretPaths) {
          config.extraSecretPaths = options.extraSecretPaths;
        }
        if (options?.includeMcpSecrets !== undefined) {
          config.includeMcpSecrets = options.includeMcpSecrets;
        }

        await ensureRepoPrivate(ctx.$, config);
        await writeSyncConfig(locations, config);

        return 'Secrets sync enabled for this repo.';
      }),
    sessionsBackend: (options: {
      backend?: 'git' | 'turso';
      setupTurso?: boolean;
      migrateSessions?: boolean;
    }) =>
      runExclusive(async () => {
        const config = await getConfigOrThrow(locations);
        if (!config.includeSessions) {
          throw new SyncCommandError(
            'Session sync is disabled. Enable includeSessions=true before selecting a backend.'
          );
        }

        const backend = options.backend;
        if (backend !== 'git' && backend !== 'turso') {
          throw new SyncCommandError('Specify a valid backend: git or turso.');
        }

        const nextConfig = normalizeSyncConfig({
          ...config,
          sessionBackend: {
            ...config.sessionBackend,
            type: backend,
          },
        });

        const notes: string[] = [];
        if (backend === 'turso') {
          if (options.setupTurso !== false) {
            const setup = await runTursoSetup(nextConfig, { allowLogin: true });
            notes.push(setup.message);
            if (setup.loginUrl) {
              notes.push(`Complete Turso login at: ${setup.loginUrl}`);
            }
            if (setup.loginCode) {
              notes.push(`Login code: ${setup.loginCode}`);
            }
          }

          if (options.migrateSessions) {
            const cycle = await runTursoCycleWithRetry(nextConfig, 'sessions-backend-migrate', {
              preference: 'push',
            });
            notes.push(`Session bootstrap: ${cycle.summary}`);
          }
        }

        await writeSyncConfig(locations, nextConfig);
        ensureTursoSyncLoop(nextConfig);

        const lines = [
          `Session backend switched to ${backend}.`,
          backend === 'git'
            ? 'Git mode is best effort and may conflict with concurrent writers.'
            : 'Turso concurrent-safe backend enabled.',
        ];

        if (notes.length > 0) {
          lines.push('', ...notes);
        }

        return lines.join('\n');
      }),
    sessionsSetupTurso: (options?: { forceTokenRefresh?: boolean }) =>
      runExclusive(async () => {
        const config = await getConfigOrThrow(locations);
        if (!config.includeSessions) {
          throw new SyncCommandError(
            'Session sync is disabled. Enable includeSessions=true before Turso setup.'
          );
        }

        const tursoConfig = isTursoSessionBackend(config)
          ? config
          : normalizeSyncConfig({
              ...config,
              sessionBackend: {
                ...config.sessionBackend,
                type: 'turso',
              },
            });

        const setup = await runTursoSetup(tursoConfig, {
          allowLogin: true,
          forceTokenRefresh: options?.forceTokenRefresh,
          allowAutoInstall: true,
        });

        const lines = [setup.message];
        if (setup.loginUrl) {
          lines.push(`Complete Turso login at: ${setup.loginUrl}`);
        }
        if (setup.loginCode) {
          lines.push(`Login code: ${setup.loginCode}`);
        }
        if (setup.ready && isTursoSessionBackend(config)) {
          ensureTursoSyncLoop(config);
        }

        return lines.join('\n');
      }),
    sessionsMigrateTurso: (options?: { setupTurso?: boolean }) =>
      runExclusive(async () => {
        const config = await getConfigOrThrow(locations);
        if (!config.includeSessions) {
          throw new SyncCommandError(
            'Session sync is disabled. Enable includeSessions=true before migration.'
          );
        }

        const migratedConfig = normalizeSyncConfig({
          ...config,
          sessionBackend: {
            ...config.sessionBackend,
            type: 'turso',
          },
        });

        if (options?.setupTurso !== false) {
          const setup = await runTursoSetup(migratedConfig, { allowLogin: true });
          if (!setup.ready) {
            const lines = [setup.message];
            if (setup.loginUrl) {
              lines.push(`Complete Turso login at: ${setup.loginUrl}`);
            }
            if (setup.loginCode) {
              lines.push(`Login code: ${setup.loginCode}`);
            }
            return lines.join('\n');
          }
        } else {
          const setup = await runTursoSetup(migratedConfig, { allowLogin: false });
          if (!setup.ready) {
            throw new SyncCommandError(setup.message);
          }
        }

        const cycle = await runTursoCycleWithRetry(migratedConfig, 'sessions-migrate-turso', {
          preference: 'push',
        });
        await writeSyncConfig(locations, migratedConfig);
        ensureTursoSyncLoop(migratedConfig);

        return [
          'Session migration to Turso completed.',
          `Bootstrap result: ${cycle.summary}`,
          'Git session artifacts were left in the sync repo for temporary fallback.',
          'After stabilization, run /sync-sessions-cleanup-git to remove deprecated repo session files.',
        ].join('\n');
      }),
    sessionsCleanupGit: () =>
      runExclusive(async () => {
        const config = await getConfigOrThrow(locations);
        if (!isTursoSessionBackend(config)) {
          throw new SyncCommandError(
            'Cleanup is only available when includeSessions=true and sessionBackend=turso.'
          );
        }

        const repoRoot = resolveRepoRoot(config, locations);
        await ensureRepoCloned(ctx.$, config, repoRoot);

        const preDirty = await hasLocalChanges(ctx.$, repoRoot);
        if (preDirty) {
          throw new SyncCommandError(
            `Local sync repo has uncommitted changes. Resolve in ${repoRoot} before cleanup.`
          );
        }

        const deprecatedPaths = [
          path.join(repoRoot, 'data', 'opencode.db'),
          path.join(repoRoot, 'data', 'opencode.db-wal'),
          path.join(repoRoot, 'data', 'opencode.db-shm'),
          path.join(repoRoot, 'data', 'storage', 'session'),
          path.join(repoRoot, 'data', 'storage', 'message'),
          path.join(repoRoot, 'data', 'storage', 'part'),
          path.join(repoRoot, 'data', 'storage', 'session_diff'),
        ];

        for (const target of deprecatedPaths) {
          await fs.rm(target, { recursive: true, force: true });
        }

        const dirty = await hasLocalChanges(ctx.$, repoRoot);
        if (!dirty) {
          return 'No deprecated Git session artifacts were found.';
        }

        const branch = await resolveBranch(ctx, config, repoRoot);
        await commitAll(ctx.$, repoRoot, 'chore: remove deprecated git session artifacts');
        await pushBranch(ctx.$, repoRoot, branch);
        await updateState(locations, { lastPush: new Date().toISOString() });
        return 'Deprecated Git session artifacts removed and pushed.';
      }),
    resolve: () =>
      runExclusive(async () => {
        const config = await getConfigOrThrow(locations);
        const repoRoot = resolveRepoRoot(config, locations);
        await ensureRepoCloned(ctx.$, config, repoRoot);

        const dirty = await hasLocalChanges(ctx.$, repoRoot);
        if (!dirty) {
          return 'No uncommitted changes to resolve.';
        }

        const status = await getRepoStatus(ctx.$, repoRoot);
        const decision = await analyzeAndDecideResolution(
          { client: ctx.client, $: ctx.$ },
          repoRoot,
          status.changes
        );

        if (decision.action === 'commit') {
          const message = decision.message ?? 'Sync: Auto-resolved uncommitted changes';
          await commitAll(ctx.$, repoRoot, message);
          return `Resolved by committing changes: ${message}`;
        }

        if (decision.action === 'reset') {
          try {
            await ctx.$`git -C ${repoRoot} reset --hard HEAD`.quiet();
            await ctx.$`git -C ${repoRoot} clean -fd`.quiet();
            return 'Resolved by discarding all uncommitted changes.';
          } catch (error) {
            throw new SyncCommandError(`Failed to reset changes: ${formatError(error)}`);
          }
        }

        return `Unable to automatically resolve. Please manually resolve in: ${repoRoot}`;
      }),
  };
}

function assertValidSecretsBackend(config: NormalizedSyncConfig): void {
  const resolution = resolveSecretsBackendConfig(config);
  if (resolution.state === 'invalid') {
    throw new SyncCommandError(resolution.error);
  }
}

async function isRepoPathTracked(
  $: Shell,
  repoRoot: string,
  repoRelativePath: string
): Promise<boolean> {
  const safePath = repoRelativePath.split(path.sep).join('/');
  try {
    await $`git -C ${repoRoot} ls-files --error-unmatch ${safePath}`.quiet();
    return true;
  } catch {
    return false;
  }
}

function toRepoRelativePath(repoRoot: string, absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).split(path.sep).join('/');
}

async function runStartup(
  ctx: SyncServiceContext,
  locations: ReturnType<typeof resolveSyncLocations>,
  config: ReturnType<typeof normalizeSyncConfig>,
  log: Logger,
  options: {
    ensureAuthFilesNotTracked: (repoRoot: string, config: NormalizedSyncConfig) => Promise<void>;
    runSecretsPullIfConfigured: (config: NormalizedSyncConfig) => Promise<void>;
  }
): Promise<void> {
  const repoRoot = resolveRepoRoot(config, locations);
  log.debug('Starting sync', { repoRoot });

  await ensureRepoCloned(ctx.$, config, repoRoot);
  await ensureSecretsPolicy(ctx, config);
  await options.ensureAuthFilesNotTracked(repoRoot, config);
  const branch = await resolveBranch(ctx, config, repoRoot);
  log.debug('Resolved branch', { branch });

  const dirty = await hasLocalChanges(ctx.$, repoRoot);
  if (dirty) {
    log.warn('Uncommitted changes detected', { repoRoot });
    await showToast(
      ctx.client,
      `Uncommitted changes detected. Run /sync-resolve to auto-fix, or manually resolve in: ${repoRoot}`,
      'warning'
    );
    return;
  }

  const update = await fetchAndFastForward(ctx.$, repoRoot, branch);
  if (update.updated) {
    log.info('Pulled remote changes', { branch });
    const overrides = await loadOverrides(locations);
    const plan = buildSyncPlan(config, locations, repoRoot);
    await syncRepoToLocal(plan, overrides);
    await options.runSecretsPullIfConfigured(config);
    await updateState(locations, {
      lastPull: new Date().toISOString(),
      lastRemoteUpdate: new Date().toISOString(),
    });
    await showToast(ctx.client, 'Config updated. Restart opencode to apply.', 'info');
    return;
  }

  const overrides = await loadOverrides(locations);
  const plan = buildSyncPlan(config, locations, repoRoot);
  await syncLocalToRepo(plan, overrides, {
    overridesPath: locations.overridesPath,
    allowMcpSecrets: canCommitMcpSecrets(config),
  });
  const changes = await hasLocalChanges(ctx.$, repoRoot);
  if (!changes) {
    log.debug('No local changes to push');
    return;
  }

  const message = await generateCommitMessage({ client: ctx.client, $: ctx.$ }, repoRoot);
  log.info('Pushing local changes', { message });
  await commitAll(ctx.$, repoRoot, message);
  await pushBranch(ctx.$, repoRoot, branch);
  await updateState(locations, {
    lastPush: new Date().toISOString(),
  });
}

async function getConfigOrThrow(
  locations: ReturnType<typeof resolveSyncLocations>
): Promise<ReturnType<typeof normalizeSyncConfig>> {
  const config = await loadSyncConfig(locations);
  if (!config) {
    throw new SyncConfigMissingError(
      'Missing opencode-synced config. Run /sync-init to set it up.'
    );
  }
  assertValidSecretsBackend(config);
  return config;
}

async function ensureSecretsPolicy(
  ctx: SyncServiceContext,
  config: ReturnType<typeof normalizeSyncConfig>
) {
  if (!config.includeSecrets) return;
  await ensureRepoPrivate(ctx.$, config);
}

async function resolveBranch(
  ctx: SyncServiceContext,
  config: ReturnType<typeof normalizeSyncConfig>,
  repoRoot: string
): Promise<string> {
  try {
    const status = await getRepoStatus(ctx.$, repoRoot);
    return resolveRepoBranch(config, status.branch);
  } catch {
    return resolveRepoBranch(config);
  }
}

const DEFAULT_REPO_NAME = 'my-opencode-config';

async function buildConfigFromInit($: Shell, options: InitOptions) {
  const repo = await resolveRepoFromInit($, options);
  return normalizeSyncConfig({
    repo,
    includeSecrets: options.includeSecrets ?? false,
    includeMcpSecrets: options.includeMcpSecrets ?? false,
    includeSessions: options.includeSessions ?? false,
    sessionBackend: options.sessionBackend
      ? {
          type: options.sessionBackend,
        }
      : undefined,
    includePromptStash: options.includePromptStash ?? false,
    includeModelFavorites: options.includeModelFavorites ?? true,
    includeOpencodeSkills: options.includeOpencodeSkills ?? true,
    includeAgentsDir: options.includeAgentsDir ?? true,
    extraSecretPaths: options.extraSecretPaths ?? [],
    extraConfigPaths: options.extraConfigPaths ?? [],
    localRepoPath: options.localRepoPath,
  });
}

async function resolveRepoFromInit($: Shell, options: InitOptions) {
  if (options.url) {
    return { url: options.url, branch: options.branch };
  }
  if (options.owner && options.name) {
    return { owner: options.owner, name: options.name, branch: options.branch };
  }
  if (options.repo) {
    if (options.repo.includes('://') || options.repo.endsWith('.git')) {
      return { url: options.repo, branch: options.branch };
    }
    if (options.repo.includes('/')) {
      const [owner, name] = options.repo.split('/');
      if (owner && name) {
        return { owner, name, branch: options.branch };
      }
    }

    const owner = await getAuthenticatedUser($);
    return { owner, name: options.repo, branch: options.branch };
  }

  // Default: auto-detect owner, use default repo name
  const owner = await getAuthenticatedUser($);
  const name = DEFAULT_REPO_NAME;
  return { owner, name, branch: options.branch };
}

async function createRepo(
  $: Shell,
  config: ReturnType<typeof normalizeSyncConfig>,
  isPrivate: boolean
): Promise<void> {
  const owner = config.repo?.owner;
  const name = config.repo?.name;
  if (!owner || !name) {
    throw new SyncCommandError('Repo creation requires owner/name.');
  }

  const visibility = isPrivate ? '--private' : '--public';
  try {
    await $`gh repo create ${owner}/${name} ${visibility} --confirm`.quiet();
  } catch (error) {
    throw new SyncCommandError(`Failed to create repo: ${formatError(error)}`);
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isBusySessionStatus(status: unknown): boolean {
  if (!isRecord(status)) {
    return true;
  }
  const statusType = typeof status.type === 'string' ? status.type : '';
  if (statusType === 'idle') {
    return false;
  }
  if (statusType === 'busy' || statusType === 'retry') {
    return true;
  }
  return true;
}

interface ResolutionDecision {
  action: 'commit' | 'reset' | 'manual';
  message?: string;
  reason?: string;
}

async function analyzeAndDecideResolution(
  ctx: { client: SyncServiceContext['client']; $: Shell },
  repoRoot: string,
  changes: string[]
): Promise<ResolutionDecision> {
  try {
    const diff = await ctx.$`git -C ${repoRoot} diff HEAD`.quiet().text();
    const statusOutput = changes.join('\n');

    const prompt = [
      'You are analyzing uncommitted changes in an opencode-synced repository.',
      'Decide whether to commit these changes or discard them.',
      '',
      'IMPORTANT: Only choose "commit" if the changes appear to be legitimate config updates.',
      'Choose "discard" if the changes look like temporary files, cache, or corruption.',
      '',
      'Respond with ONLY a JSON object in this exact format:',
      '{"action": "commit", "message": "your commit message here"}',
      'OR',
      '{"action": "discard", "reason": "explanation why discarding"}',
      '',
      'Status:',
      statusOutput,
      '',
      'Diff preview (first 2000 chars):',
      diff.slice(0, 2000),
    ].join('\n');

    const model = await resolveSmallModel(ctx.client);
    if (!model) {
      return { action: 'manual', reason: 'No AI model available' };
    }

    let sessionId: string | null = null;
    try {
      const sessionResult = await ctx.client.session.create({
        body: { title: 'sync-resolve' },
      });
      const session = unwrapData<{ id: string }>(sessionResult);
      sessionId = session?.id ?? null;
      if (!sessionId) {
        return { action: 'manual', reason: 'Failed to create session' };
      }

      const response = await ctx.client.session.prompt({
        path: { id: sessionId },
        body: {
          model,
          parts: [{ type: 'text', text: prompt }],
        },
      });

      const messageText = extractTextFromResponse(unwrapData(response) ?? response);
      if (!messageText) {
        return { action: 'manual', reason: 'No response from AI' };
      }

      const decision = parseResolutionDecision(messageText);
      return decision;
    } finally {
      if (sessionId) {
        try {
          await ctx.client.session.delete({ path: { id: sessionId } });
        } catch {}
      }
    }
  } catch (error) {
    console.error('[ERROR] AI resolution analysis failed:', error);
    return { action: 'manual', reason: `Error analyzing changes: ${formatError(error)}` };
  }
}

function parseResolutionDecision(text: string): ResolutionDecision {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { action: 'manual', reason: 'Could not parse AI response' };
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      action?: string;
      message?: string;
      reason?: string;
    };

    if (parsed.action === 'commit' && parsed.message) {
      return { action: 'commit', message: parsed.message };
    }

    if (parsed.action === 'discard') {
      return { action: 'reset', reason: parsed.reason };
    }

    return { action: 'manual', reason: 'Unexpected AI response format' };
  } catch {
    return { action: 'manual', reason: 'Failed to parse AI decision' };
  }
}

function resolveStrictLinkRepo(raw: string | undefined): { owner: string; name: string } | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;

  const parsed = parseRepoReference(value, '__opencode_sync_no_owner__');
  if (!parsed || parsed.owner === '__opencode_sync_no_owner__') {
    throw new SyncCommandError(
      'OPENCODE_SYNC_E2E_STRICT_LINK_REPO must be an explicit owner/repo or GitHub repo URL.'
    );
  }

  return parsed;
}
