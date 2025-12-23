import type { PluginInput } from '@opencode-ai/plugin';

import {
  loadOverrides,
  loadState,
  loadSyncConfig,
  normalizeSyncConfig,
  writeState,
  writeSyncConfig,
} from './config.ts';
import { SyncConfigMissingError, SyncCommandError } from './errors.ts';
import { generateCommitMessage } from './commit.ts';
import { syncLocalToRepo, syncRepoToLocal } from './apply.ts';
import { buildSyncPlan, resolveRepoRoot, resolveSyncLocations } from './paths.ts';
import {
  commitAll,
  ensureRepoCloned,
  ensureRepoPrivate,
  fetchAndFastForward,
  getRepoStatus,
  hasLocalChanges,
  isRepoCloned,
  pushBranch,
  resolveRepoBranch,
  resolveRepoIdentifier,
} from './repo.ts';

type SyncServiceContext = Pick<PluginInput, 'client' | '$'>;
type Shell = PluginInput['$'];

interface InitOptions {
  repo?: string;
  owner?: string;
  name?: string;
  url?: string;
  branch?: string;
  includeSecrets?: boolean;
  create?: boolean;
  private?: boolean;
  extraSecretPaths?: string[];
  localRepoPath?: string;
}

export interface SyncService {
  startupSync: () => Promise<void>;
  status: () => Promise<string>;
  init: (_options: InitOptions) => Promise<string>;
  pull: () => Promise<string>;
  push: () => Promise<string>;
  enableSecrets: (_extraSecretPaths?: string[]) => Promise<string>;
}

export function createSyncService(ctx: SyncServiceContext): SyncService {
  const locations = resolveSyncLocations();

  return {
    startupSync: async () => {
      const config = await loadSyncConfig(locations);
      if (!config) {
        await showToast(ctx, 'Configure opencode-sync with /opencode-sync-init.', 'info');
        return;
      }
      try {
        await runStartup(ctx, locations, config);
      } catch (error) {
        await showToast(ctx, formatError(error), 'error');
      }
    },
    status: async () => {
      const config = await loadSyncConfig(locations);
      if (!config) {
        return 'opencode-sync is not configured. Run /opencode-sync-init to set it up.';
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
      const lastPull = state.lastPull ?? 'never';
      const lastPush = state.lastPush ?? 'never';

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
        `Last pull: ${lastPull}`,
        `Last push: ${lastPush}`,
        `Working tree: ${changesLabel}`,
      ];

      return statusLines.join('\n');
    },
    init: async (options: InitOptions) => {
      const config = buildConfigFromInit(options);
      if (!config.repo) {
        throw new SyncCommandError('Provide repo info (owner/name or URL) to initialize sync.');
      }

      const repoIdentifier = resolveRepoIdentifier(config);
      if (options.create) {
        await createRepo(ctx.$, config, options.private ?? true);
      }

      await writeSyncConfig(locations, config);
      const repoRoot = resolveRepoRoot(config, locations);
      await ensureRepoCloned(ctx.$, config, repoRoot);
      await ensureSecretsPolicy(ctx, config);

      return [
        'opencode-sync configured.',
        `Repo: ${repoIdentifier}`,
        `Branch: ${resolveRepoBranch(config)}`,
        `Local repo: ${repoRoot}`,
      ].join('\n');
    },
    pull: async () => {
      const config = await getConfigOrThrow(locations);
      const repoRoot = resolveRepoRoot(config, locations);
      await ensureRepoCloned(ctx.$, config, repoRoot);
      await ensureSecretsPolicy(ctx, config);

      const branch = await resolveBranch(ctx, config, repoRoot);

      const dirty = await hasLocalChanges(ctx.$, repoRoot);
      if (dirty) {
        throw new SyncCommandError(
          `Local sync repo has uncommitted changes. Resolve in ${repoRoot} before pulling.`
        );
      }

      const update = await fetchAndFastForward(ctx.$, repoRoot, branch);
      if (!update.updated) {
        return 'Already up to date.';
      }

      const overrides = await loadOverrides(locations);
      const plan = buildSyncPlan(config, locations, repoRoot);
      await syncRepoToLocal(plan, overrides);

      await writeState(locations, {
        lastPull: new Date().toISOString(),
        lastRemoteUpdate: new Date().toISOString(),
      });

      await showToast(ctx, 'Config updated. Restart OpenCode to apply.', 'info');
      return 'Remote config applied. Restart OpenCode to use new settings.';
    },
    push: async () => {
      const config = await getConfigOrThrow(locations);
      const repoRoot = resolveRepoRoot(config, locations);
      await ensureRepoCloned(ctx.$, config, repoRoot);
      await ensureSecretsPolicy(ctx, config);
      const branch = await resolveBranch(ctx, config, repoRoot);

      const preDirty = await hasLocalChanges(ctx.$, repoRoot);
      if (preDirty) {
        throw new SyncCommandError(
          `Local sync repo has uncommitted changes. Resolve in ${repoRoot} before pushing.`
        );
      }

      const overrides = await loadOverrides(locations);
      const plan = buildSyncPlan(config, locations, repoRoot);
      await syncLocalToRepo(plan, overrides);

      const dirty = await hasLocalChanges(ctx.$, repoRoot);
      if (!dirty) {
        return 'No local changes to push.';
      }

      const message = await generateCommitMessage({ client: ctx.client, $: ctx.$ }, repoRoot);
      await commitAll(ctx.$, repoRoot, message);
      await pushBranch(ctx.$, repoRoot, branch);

      await writeState(locations, {
        lastPush: new Date().toISOString(),
      });

      return `Pushed changes: ${message}`;
    },
    enableSecrets: async (extraSecretPaths?: string[]) => {
      const config = await getConfigOrThrow(locations);
      config.includeSecrets = true;
      if (extraSecretPaths) {
        config.extraSecretPaths = extraSecretPaths;
      }

      await ensureRepoPrivate(ctx.$, config);
      await writeSyncConfig(locations, config);

      return 'Secrets sync enabled for this repo.';
    },
  };
}

async function runStartup(
  ctx: SyncServiceContext,
  locations: ReturnType<typeof resolveSyncLocations>,
  config: ReturnType<typeof normalizeSyncConfig>
): Promise<void> {
  const repoRoot = resolveRepoRoot(config, locations);
  await ensureRepoCloned(ctx.$, config, repoRoot);
  await ensureSecretsPolicy(ctx, config);
  const branch = await resolveBranch(ctx, config, repoRoot);

  const dirty = await hasLocalChanges(ctx.$, repoRoot);
  if (dirty) {
    await showToast(
      ctx,
      `Local sync repo has uncommitted changes in ${repoRoot}. Resolve before sync.`,
      'warning'
    );
    return;
  }

  const update = await fetchAndFastForward(ctx.$, repoRoot, branch);
  if (update.updated) {
    const overrides = await loadOverrides(locations);
    const plan = buildSyncPlan(config, locations, repoRoot);
    await syncRepoToLocal(plan, overrides);
    await writeState(locations, {
      lastPull: new Date().toISOString(),
      lastRemoteUpdate: new Date().toISOString(),
    });
    await showToast(ctx, 'Config updated. Restart OpenCode to apply.', 'info');
    return;
  }

  const overrides = await loadOverrides(locations);
  const plan = buildSyncPlan(config, locations, repoRoot);
  await syncLocalToRepo(plan, overrides);
  const changes = await hasLocalChanges(ctx.$, repoRoot);
  if (!changes) return;

  const message = await generateCommitMessage({ client: ctx.client, $: ctx.$ }, repoRoot);
  await commitAll(ctx.$, repoRoot, message);
  await pushBranch(ctx.$, repoRoot, branch);
  await writeState(locations, {
    lastPush: new Date().toISOString(),
  });
}

async function getConfigOrThrow(
  locations: ReturnType<typeof resolveSyncLocations>
): Promise<ReturnType<typeof normalizeSyncConfig>> {
  const config = await loadSyncConfig(locations);
  if (!config) {
    throw new SyncConfigMissingError(
      'Missing opencode-sync config. Run /opencode-sync-init to set it up.'
    );
  }
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

function buildConfigFromInit(options: InitOptions) {
  const repo = resolveRepoFromInit(options);
  return normalizeSyncConfig({
    repo,
    includeSecrets: options.includeSecrets ?? false,
    extraSecretPaths: options.extraSecretPaths ?? [],
    localRepoPath: options.localRepoPath,
  });
}

function resolveRepoFromInit(options: InitOptions) {
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
    const [owner, name] = options.repo.split('/');
    if (owner && name) {
      return { owner, name, branch: options.branch };
    }
  }
  return undefined;
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
    await $`gh repo create ${owner}/${name} ${visibility} --confirm`;
  } catch (error) {
    throw new SyncCommandError(`Failed to create repo: ${formatError(error)}`);
  }
}

type ToastVariant = 'info' | 'success' | 'warning' | 'error';

async function showToast(
  ctx: SyncServiceContext,
  message: string,
  variant: ToastVariant
): Promise<void> {
  await ctx.client.tui.showToast({ body: { message: `opencode-sync: ${message}`, variant } });
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
