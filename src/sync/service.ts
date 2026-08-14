import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';

import { assertSafeDestination, syncLocalToRepo, syncRepoToLocal } from './apply.js';
import {
  canCommitMcpSecrets,
  loadOverrides,
  loadState,
  loadSyncConfig,
  normalizeSyncConfig,
  writeState,
  writeSyncConfig,
} from './config.js';
import { SyncCommandError, SyncConfigMissingError } from './errors.js';
import type { SyncLockInfo } from './lock.js';
import { withSyncLock } from './lock.js';
import { buildSyncPlan, resolveRepoRoot, resolveSyncLocations } from './paths.js';
import { applyLocalProjection, createLocalProjection } from './reconcile.js';
import {
  assertRestrictedRepoLayout,
  commitAll,
  ensureRepoCloned,
  ensureRepoPrivate,
  fetchAndFastForward,
  fetchAndRebaseLocalWins,
  findSyncRepo,
  getAuthenticatedUser,
  getRepoStatus,
  hasLocalChanges,
  isRepoCloned,
  pushBranch,
  pushPendingCommits,
  repoExists,
  resolveRepoBranch,
  resolveRepoIdentifier,
} from './repo.js';
import { createLogger, showToast } from './utils.js';

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
  includeSkills?: boolean;
  includePromptHistory?: boolean;
  includePromptStash?: boolean;
  includeModelFavorites?: boolean;
  includeModelSelectors?: boolean;
  acknowledgePlaintextPromptRisk?: boolean;
  create?: boolean;
  private?: boolean;
  extraSecretPaths?: string[];
  extraConfigPaths?: string[];
  localRepoPath?: string;
}

interface LinkOptions {
  repo?: string;
  includeSkills?: boolean;
  includePromptHistory?: boolean;
  includePromptStash?: boolean;
  includeModelFavorites?: boolean;
  includeModelSelectors?: boolean;
  acknowledgePlaintextPromptRisk?: boolean;
}

export interface SyncService {
  startupSync: () => Promise<void>;
  status: () => Promise<string>;
  init: (_options: InitOptions) => Promise<string>;
  link: (_options: LinkOptions) => Promise<string>;
  pull: () => Promise<string>;
  push: () => Promise<string>;
}

export function createSyncService(ctx: SyncServiceContext): SyncService {
  const locations = resolveSyncLocations();
  const log = createLogger(ctx.client);
  const lockPath = path.join(path.dirname(locations.statePath), 'sync.lock');

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

  return {
    startupSync: () =>
      skipIfBusy(async () => {
        let config: ReturnType<typeof normalizeSyncConfig> | null = null;
        try {
          config = await loadSyncConfig(locations);
        } catch (error) {
          const message = `Failed to load opencode-synced config: ${formatError(error)}`;
          log.error(message, { path: locations.syncConfigPath });
          return;
        }
        if (!config) {
          log.info('Sync is not configured; skipping startup sync');
          return;
        }
        try {
          await runStartup(ctx, locations, config, log);
        } catch (error) {
          log.error('Startup sync failed', { error: formatError(error) });
        }
      }),
    status: async () => {
      const config = await loadSyncConfig(locations);
      if (!config) {
        return 'opencode-synced is not configured. Run /sync-init to set it up.';
      }

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
      const includeSkills = config.includeSkills ? 'enabled' : 'disabled';
      const includePromptHistory = config.includePromptHistory ? 'enabled' : 'disabled';
      const includePromptStash = config.includePromptStash ? 'enabled' : 'disabled';
      const includeModelFavorites = config.includeModelFavorites ? 'enabled' : 'disabled';
      const includeModelSelectors = config.includeModelSelectors ? 'enabled' : 'disabled';
      const lastPull = state.lastPull ?? 'never';
      const lastPush = state.lastPush ?? 'never';
      const lastOutcome = state.lastOutcome ?? 'never';

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
        `MCP secrets: ${includeMcpSecrets}`,
        `Sessions: ${includeSessions}`,
        `Skills: ${includeSkills}`,
        `Prompt history: ${includePromptHistory}`,
        `Prompt stash: ${includePromptStash}`,
        `Model favorites: ${includeModelFavorites}`,
        `Model selectors: ${includeModelSelectors}`,
        `Last pull: ${lastPull}`,
        `Last push: ${lastPush}`,
        `Last outcome: ${lastOutcome}`,
        `Working tree: ${changesLabel}`,
      ];

      return statusLines.join('\n');
    },
    init: (options: InitOptions) =>
      runExclusive(async () => {
        const config = await buildConfigFromInit(ctx.$, options);

        const repoIdentifier = resolveRepoIdentifier(config);
        const isPrivate = options.private ?? true;
        if (!isPrivate && (config.includePromptHistory || config.includePromptStash)) {
          throw new SyncCommandError('Prompt synchronization requires a private repository.');
        }

        const exists = await repoExists(ctx.$, repoIdentifier);
        let created = false;
        if (!exists) {
          await createRepo(ctx.$, config, isPrivate);
          created = true;
        }

        await writeSyncConfig(locations, config);
        const repoRoot = resolveRepoRoot(config, locations);
        await ensureRepoCloned(ctx.$, config, repoRoot);
        await assertRestrictedRepoLayout(repoRoot);
        await ensurePrivateDataPolicy(ctx, config);

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
            const completedAt = new Date().toISOString();
            await writeState(locations, {
              lastAttempt: completedAt,
              lastCommit: completedAt,
              lastPush: completedAt,
              lastOutcome: 'pushed',
            });
          }
        }

        const lines = [
          'opencode-synced configured.',
          `Repo: ${repoIdentifier}${created ? ' (created)' : ''}`,
          `Branch: ${resolveRepoBranch(config)}`,
          `Local repo: ${repoRoot}`,
        ];

        return lines.join('\n');
      }),
    link: (options: LinkOptions) =>
      runExclusive(async () => {
        const found = await findSyncRepo(ctx.$, options.repo);

        if (!found) {
          const searchedFor = options.repo
            ? `"${options.repo}"`
            : 'common sync repo names (my-opencode-config, opencode-config, etc.)';

          const lines = [
            `Could not find an existing sync repo. Searched for: ${searchedFor}`,
            '',
            'To link to an existing repo, run:',
            '  /sync-link <repo-name>',
            '',
            'To create a new sync repo, run:',
            '  /sync-init',
          ];
          return lines.join('\n');
        }

        const config = normalizeSyncConfig({
          repo: { owner: found.owner, name: found.name },
          includeSecrets: false,
          includeMcpSecrets: false,
          includeSessions: false,
          includeSkills: options.includeSkills ?? false,
          includePromptHistory: options.includePromptHistory ?? false,
          includePromptStash: options.includePromptStash ?? false,
          includeModelFavorites: options.includeModelFavorites ?? true,
          includeModelSelectors: options.includeModelSelectors ?? false,
          acknowledgePlaintextPromptRisk: options.acknowledgePlaintextPromptRisk ?? false,
          extraSecretPaths: [],
          extraConfigPaths: [],
        });

        await writeSyncConfig(locations, config);
        const repoRoot = resolveRepoRoot(config, locations);
        await ensureRepoCloned(ctx.$, config, repoRoot);
        await ensurePrivateDataPolicy(ctx, config);
        await assertRestrictedRepoLayout(repoRoot);

        const branch = await resolveBranch(ctx, config, repoRoot);

        await fetchAndFastForward(ctx.$, repoRoot, branch);
        await assertRestrictedRepoLayout(repoRoot);

        const overrides = await loadOverrides(locations);
        const plan = buildSyncPlan(config, locations, repoRoot);
        await syncRepoToLocal(plan, overrides);

        await writeState(locations, {
          lastPull: new Date().toISOString(),
          lastRemoteUpdate: new Date().toISOString(),
        });

        const lines = [
          `Linked to existing sync repo: ${found.owner}/${found.name}`,
          '',
          'Your local opencode config has been OVERWRITTEN with the synced config.',
          'Your local overrides file was preserved and applied on top.',
          '',
          'Restart opencode to apply the new settings.',
          '',
          found.isPrivate
            ? 'Private repository verified. Secret files remain local-only.'
            : 'Public repository detected. Prompt snapshots remain disabled.',
        ];

        await showToast(ctx.client, 'Config synced. Restart opencode to apply.', 'info');
        return lines.join('\n');
      }),
    pull: () =>
      runExclusive(async () => {
        const config = await getConfigOrThrow(locations);
        const repoRoot = resolveRepoRoot(config, locations);
        await ensureRepoCloned(ctx.$, config, repoRoot);
        await ensurePrivateDataPolicy(ctx, config);
        await assertRestrictedRepoLayout(repoRoot);
        const attemptedAt = new Date().toISOString();
        await writeState(locations, { lastAttempt: attemptedAt });

        const branch = await resolveBranch(ctx, config, repoRoot);

        const dirty = await hasLocalChanges(ctx.$, repoRoot);
        if (dirty) {
          throw new SyncCommandError(
            `Local sync repo has uncommitted changes. Resolve in ${repoRoot} before pulling.`
          );
        }

        const update = await fetchAndFastForward(ctx.$, repoRoot, branch);
        await assertRestrictedRepoLayout(repoRoot);

        const overrides = await loadOverrides(locations);
        const plan = buildSyncPlan(config, locations, repoRoot);
        await syncRepoToLocal(plan, overrides);

        const completedAt = new Date().toISOString();
        await writeState(locations, {
          lastFetch: completedAt,
          lastApplied: completedAt,
          lastPull: completedAt,
          ...(update.updated ? { lastRemoteUpdate: completedAt } : {}),
          lastOutcome: 'pulled',
        });

        await showToast(ctx.client, 'Config updated. Restart opencode to apply.', 'info');
        return 'Remote config applied. Restart opencode to use new settings.';
      }),
    push: () =>
      runExclusive(async () => {
        const config = await getConfigOrThrow(locations);
        return runLocalWinsSync(ctx, locations, config, log);
      }),
  };
}

async function runStartup(
  ctx: SyncServiceContext,
  locations: ReturnType<typeof resolveSyncLocations>,
  config: ReturnType<typeof normalizeSyncConfig>,
  log: Logger
): Promise<void> {
  const result = await runLocalWinsSync(ctx, locations, config, log);
  if (result === 'pulled') {
    await showToast(ctx.client, 'Config updated. Restart opencode to apply.', 'info');
  }
}

async function runLocalWinsSync(
  ctx: SyncServiceContext,
  locations: ReturnType<typeof resolveSyncLocations>,
  config: ReturnType<typeof normalizeSyncConfig>,
  log: Logger
): Promise<string> {
  const attemptedAt = new Date().toISOString();
  await writeState(locations, { lastAttempt: attemptedAt });
  const repoRoot = resolveRepoRoot(config, locations);
  const workspaceParent = path.dirname(locations.statePath);
  const projectionRoot = path.join(workspaceParent, 'opencode-synced', 'projection');
  const rollbackBase = path.join(workspaceParent, 'opencode-synced', 'rollbacks');

  try {
    await assertSafeDestination(workspaceParent, projectionRoot);
    await ensureRepoCloned(ctx.$, config, repoRoot);
    await ensurePrivateDataPolicy(ctx, config);
    await assertRestrictedRepoLayout(repoRoot);
    const branch = await resolveBranch(ctx, config, repoRoot);
    const dirty = await hasLocalChanges(ctx.$, repoRoot);
    if (dirty) {
      throw new SyncCommandError(
        `Local sync repo has uncommitted changes. Resolve them manually in ${repoRoot}.`
      );
    }

    const overrides = await loadOverrides(locations);
    const plan = buildSyncPlan(config, locations, repoRoot);
    const projection = await createLocalProjection(plan, overrides, projectionRoot, {
      overridesPath: locations.overridesPath,
    });
    const update = await fetchAndRebaseLocalWins(ctx.$, repoRoot, branch);
    await assertRestrictedRepoLayout(repoRoot);
    const fetchedAt = new Date().toISOString();
    await writeState(locations, { lastFetch: fetchedAt });

    if (update.updated && projection.changedItemIndexes.length > 0) {
      const rollbackRoot = path.join(rollbackBase, safeTimestamp());
      await assertSafeDestination(workspaceParent, rollbackRoot);
      await applyLocalProjection(plan, projection, rollbackRoot);
      log.warn('Concurrent remote changes reconciled with local-wins policy', {
        changedItems: projection.changedItemIndexes.length,
        rollbackRoot,
      });
    } else if (!update.updated) {
      await syncLocalToRepo(plan, overrides, {
        overridesPath: locations.overridesPath,
        allowMcpSecrets: canCommitMcpSecrets(config),
      });
    }

    let message: string | null = null;
    if (await hasLocalChanges(ctx.$, repoRoot)) {
      message = 'sync: update OpenCode configuration';
      await commitAll(ctx.$, repoRoot, message);
      await writeState(locations, { lastCommit: new Date().toISOString() });
    }

    const pushed = await pushPendingCommits(ctx.$, repoRoot, branch);
    if (pushed) {
      const completedAt = new Date().toISOString();
      await writeState(locations, {
        lastPush: completedAt,
        lastOutcome: 'pushed',
      });
      await syncRepoToLocal(plan, overrides);
      return message ? `Pushed changes: ${message}` : 'Pushed pending commits.';
    }

    if (update.updated) {
      await syncRepoToLocal(plan, overrides);
      const completedAt = new Date().toISOString();
      await writeState(locations, {
        lastApplied: completedAt,
        lastPull: completedAt,
        lastRemoteUpdate: completedAt,
        lastOutcome: 'pulled',
      });
      return 'pulled';
    }

    const completedAt = new Date().toISOString();
    await writeState(locations, {
      lastNoop: completedAt,
      lastOutcome: 'noop',
    });
    return 'No local or remote changes.';
  } catch (error) {
    await writeState(locations, {
      lastError: new Date().toISOString(),
      lastOutcome: 'failed',
    });
    throw error;
  } finally {
    await assertSafeDestination(workspaceParent, projectionRoot);
    await fs.rm(projectionRoot, { recursive: true, force: true });
  }
}

function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
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
  return config;
}

async function ensurePrivateDataPolicy(
  ctx: SyncServiceContext,
  config: ReturnType<typeof normalizeSyncConfig>
) {
  if (!config.includePromptHistory && !config.includePromptStash) return;
  await ensureRepoPrivate(ctx.$, config);
}

async function resolveBranch(
  _ctx: SyncServiceContext,
  config: ReturnType<typeof normalizeSyncConfig>,
  _repoRoot: string
): Promise<string> {
  return resolveRepoBranch(config);
}

const DEFAULT_REPO_NAME = 'my-opencode-config';

async function buildConfigFromInit($: Shell, options: InitOptions) {
  const repo = await resolveRepoFromInit($, options);
  return normalizeSyncConfig({
    repo,
    includeSecrets: options.includeSecrets ?? false,
    includeMcpSecrets: options.includeMcpSecrets ?? false,
    includeSessions: options.includeSessions ?? false,
    includeSkills: options.includeSkills ?? false,
    includePromptHistory: options.includePromptHistory ?? false,
    includePromptStash: options.includePromptStash ?? false,
    includeModelFavorites: options.includeModelFavorites ?? true,
    includeModelSelectors: options.includeModelSelectors ?? false,
    acknowledgePlaintextPromptRisk: options.acknowledgePlaintextPromptRisk ?? false,
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
