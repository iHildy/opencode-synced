import crypto from 'node:crypto';
import path from 'node:path';
import type { NormalizedSyncConfig, SyncConfig } from './config.js';
import { hasSecretsBackend, isTursoSessionBackend } from './config.js';

export interface XdgPaths {
  homeDir: string;
  configDir: string;
  dataDir: string;
  stateDir: string;
}

export interface SyncLocations {
  xdg: XdgPaths;
  configRoot: string;
  syncConfigPath: string;
  overridesPath: string;
  statePath: string;
  defaultRepoDir: string;
}

export type SyncItemType = 'file' | 'dir';

export interface SyncItem {
  localPath: string;
  repoPath: string;
  type: SyncItemType;
  isSecret: boolean;
  isConfigFile: boolean;
  preserveWhenMissing?: boolean;
}

export interface ExtraPathPlan {
  allowlist: string[];
  manifestPath: string;
  entries: Array<{ sourcePath: string; repoPath: string }>;
}

export interface SyncPlan {
  items: SyncItem[];
  extraSecrets: ExtraPathPlan;
  extraConfigs: ExtraPathPlan;
  repoRoot: string;
  homeDir: string;
  platform: NodeJS.Platform;
}

const DEFAULT_CONFIG_NAME = 'opencode.json';
const DEFAULT_CONFIGC_NAME = 'opencode.jsonc';
const DEFAULT_AGENTS_NAME = 'AGENTS.md';
const DEFAULT_SYNC_CONFIG_NAME = 'opencode-synced.jsonc';
const DEFAULT_OVERRIDES_NAME = 'opencode-synced.overrides.jsonc';
const DEFAULT_STATE_NAME = 'sync-state.json';

const CONFIG_DIRS = ['agent', 'command', 'commands', 'mode', 'tool', 'themes', 'plugin', 'plugins'];
const PROMPT_STASH_FILES = ['prompt-stash.jsonl', 'prompt-history.jsonl'];
const MODEL_FAVORITES_FILE = 'model.json';
const SKILLS_DIR = 'skills';
const HOME_AGENTS_DIR = '.agents';
const GLOBAL_DAT_FILE = 'opencode.global.dat';

// EN: Platform-aware path.join — when testing (platform != runtime), uses posix/win32 module
// RU: path.join с учётом платформы — при тестах (platform != runtime) использует posix/win32 модуль
function platformJoin(platform: NodeJS.Platform, ...parts: string[]): string {
  if (platform === 'win32') return path.win32.join(...parts);
  return path.posix.join(...parts);
}

export function resolveHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    return env.USERPROFILE ?? env.HOMEDRIVE ?? env.HOME ?? '';
  }

  return env.HOME ?? '';
}

export function resolveXdgPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): XdgPaths {
  const homeDir = resolveHomeDir(env, platform);

  if (!homeDir) {
    return {
      homeDir: '',
      configDir: '',
      dataDir: '',
      stateDir: '',
    };
  }

  const configDir = env.XDG_CONFIG_HOME ?? platformJoin(platform, homeDir, '.config');
  const dataDir = env.XDG_DATA_HOME ?? platformJoin(platform, homeDir, '.local', 'share');
  const stateDir = env.XDG_STATE_HOME ?? platformJoin(platform, homeDir, '.local', 'state');

  return { homeDir, configDir, dataDir, stateDir };
}

export function resolveSyncLocations(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): SyncLocations {
  const xdg = resolveXdgPaths(env, platform);
  const customConfigDir = env.OPENCODE_CONFIG_DIR;
  const configRoot = customConfigDir
    ? platformJoin(platform, expandHome(customConfigDir, xdg.homeDir))
    : platformJoin(platform, xdg.configDir, 'opencode');
  const dataRoot = platformJoin(platform, xdg.dataDir, 'opencode');

  return {
    xdg,
    configRoot,
    syncConfigPath: platformJoin(platform, configRoot, DEFAULT_SYNC_CONFIG_NAME),
    overridesPath: platformJoin(platform, configRoot, DEFAULT_OVERRIDES_NAME),
    statePath: platformJoin(platform, dataRoot, DEFAULT_STATE_NAME),
    defaultRepoDir: platformJoin(platform, dataRoot, 'opencode-synced', 'repo'),
  };
}

export function expandHome(inputPath: string, homeDir: string): string {
  if (!inputPath) return inputPath;
  if (!homeDir) return inputPath;
  if (inputPath === '~') return homeDir;
  if (inputPath.startsWith('~/')) return `${homeDir}/${inputPath.slice(2)}`;
  return inputPath;
}

export function normalizePath(
  inputPath: string,
  homeDir: string,
  platform: NodeJS.Platform = process.platform
): string {
  const pj = (...parts: string[]) => platformJoin(platform, ...parts);
  const expanded = expandHome(inputPath, homeDir).replace(/\\/g, '/');
  const resolved = pj(expanded);
  if (platform === 'win32') {
    return resolved.toLowerCase();
  }
  return resolved;
}

export function isSamePath(
  left: string,
  right: string,
  homeDir: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return normalizePath(left, homeDir, platform) === normalizePath(right, homeDir, platform);
}

export function encodeExtraPath(inputPath: string): string {
  const normalized = inputPath.replace(/\\/g, '/');
  const safeBase = normalized.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+/, '');
  const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 8);
  const base = safeBase ? safeBase.slice(-80) : 'path';
  return `${base}-${hash}`;
}

export const encodeSecretPath = encodeExtraPath;

export function resolveRepoRoot(config: SyncConfig | null, locations: SyncLocations): string {
  if (config?.localRepoPath) {
    return expandHome(config.localRepoPath, locations.xdg.homeDir);
  }

  return locations.defaultRepoDir;
}

export function resolveProjectsFilePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const pj = (...parts: string[]) => platformJoin(platform, ...parts);
  if (platform === 'win32') {
    const appData = env.APPDATA ?? pj(env.USERPROFILE ?? '', 'AppData', 'Roaming');
    return pj(appData, 'ai.opencode.desktop', GLOBAL_DAT_FILE);
  }
  const dataDir = env.XDG_DATA_HOME ?? pj(resolveHomeDir(env, platform), '.local', 'share');
  return pj(dataDir, 'opencode', GLOBAL_DAT_FILE);
}

export function buildSyncPlan(
  config: NormalizedSyncConfig,
  locations: SyncLocations,
  repoRoot: string,
  platform: NodeJS.Platform = process.platform
): SyncPlan {
  const pj = (...parts: string[]) => platformJoin(platform, ...parts);
  const configRoot = locations.configRoot;
  const dataRoot = pj(locations.xdg.dataDir, 'opencode');
  const stateRoot = pj(locations.xdg.stateDir, 'opencode');
  const repoConfigRoot = pj(repoRoot, 'config');
  const repoDataRoot = pj(repoRoot, 'data');
  const repoSecretsRoot = pj(repoRoot, 'secrets');
  const repoStateRoot = pj(repoRoot, 'state');
  const repoExtraDir = pj(repoSecretsRoot, 'extra');
  const manifestPath = pj(repoSecretsRoot, 'extra-manifest.json');
  const repoConfigExtraDir = pj(repoConfigRoot, 'extra');
  const configManifestPath = pj(repoConfigRoot, 'extra-manifest.json');

  const items: SyncItem[] = [];
  const usingSecretsBackend = hasSecretsBackend(config);
  const authJsonPath = pj(dataRoot, 'auth.json');
  const mcpAuthJsonPath = pj(dataRoot, 'mcp-auth.json');

  const addFile = (name: string, isSecret: boolean, isConfigFile: boolean): void => {
    items.push({
      localPath: pj(configRoot, name),
      repoPath: pj(repoConfigRoot, name),
      type: 'file',
      isSecret,
      isConfigFile,
    });
  };

  addFile(DEFAULT_CONFIG_NAME, false, true);
  addFile(DEFAULT_CONFIGC_NAME, false, true);
  addFile(DEFAULT_AGENTS_NAME, false, false);
  addFile(DEFAULT_SYNC_CONFIG_NAME, false, false);

  for (const dirName of CONFIG_DIRS) {
    items.push({
      localPath: pj(configRoot, dirName),
      repoPath: pj(repoConfigRoot, dirName),
      type: 'dir',
      isSecret: false,
      isConfigFile: false,
    });
  }

  if (config.includeOpencodeSkills !== false) {
    items.push({
      localPath: pj(configRoot, SKILLS_DIR),
      repoPath: pj(repoConfigRoot, SKILLS_DIR),
      type: 'dir',
      isSecret: false,
      isConfigFile: false,
    });
  }

  if (config.includeAgentsDir !== false) {
    items.push({
      localPath: pj(locations.xdg.homeDir, HOME_AGENTS_DIR),
      repoPath: pj(repoConfigRoot, HOME_AGENTS_DIR),
      type: 'dir',
      isSecret: false,
      isConfigFile: false,
    });
  }

  if (config.includeModelFavorites !== false) {
    items.push({
      localPath: pj(stateRoot, MODEL_FAVORITES_FILE),
      repoPath: pj(repoStateRoot, MODEL_FAVORITES_FILE),
      type: 'file',
      isSecret: false,
      isConfigFile: false,
    });
  }

  if (config.includeSecrets) {
    if (!usingSecretsBackend) {
      items.push(
        {
          localPath: authJsonPath,
          repoPath: path.join(repoDataRoot, 'auth.json'),
          type: 'file',
          isSecret: true,
          isConfigFile: false,
        },
        {
          localPath: mcpAuthJsonPath,
          repoPath: pj(repoDataRoot, 'mcp-auth.json'),
          type: 'file',
          isSecret: true,
          isConfigFile: false,
        }
      );
    }

    if (config.includeSessions && !isTursoSessionBackend(config)) {
      // Session sync uses per-session JSON merge (syncSessions),
      // NOT raw DB/storage copy — to avoid overwriting local sessions on pull.
    }

    if (config.includePromptStash) {
      for (const fileName of PROMPT_STASH_FILES) {
        items.push({
          localPath: pj(stateRoot, fileName),
          repoPath: pj(repoStateRoot, fileName),
          type: 'file',
          isSecret: true,
          isConfigFile: false,
        });
      }
    }
  }

  const extraSecretPaths = config.includeSecrets ? config.extraSecretPaths : [];
  const filteredExtraSecrets = usingSecretsBackend
    ? extraSecretPaths.filter(
        (entry) =>
          !isSamePath(entry, authJsonPath, locations.xdg.homeDir, platform) &&
          !isSamePath(entry, mcpAuthJsonPath, locations.xdg.homeDir, platform)
      )
    : extraSecretPaths;

  const extraSecrets = buildExtraPathPlan(
    filteredExtraSecrets,
    locations,
    repoExtraDir,
    manifestPath,
    platform
  );

  const extraConfigPaths = (config.extraConfigPaths ?? []).filter(
    (entry) =>
      !items.some((item) => isSamePath(entry, item.localPath, locations.xdg.homeDir, platform))
  );

  const extraConfigs = buildExtraPathPlan(
    extraConfigPaths,
    locations,
    repoConfigExtraDir,
    configManifestPath,
    platform
  );

  return {
    items,
    extraSecrets,
    extraConfigs,
    repoRoot,
    homeDir: locations.xdg.homeDir,
    platform,
  };
}

function buildExtraPathPlan(
  inputPaths: string[] | undefined,
  locations: SyncLocations,
  repoExtraDir: string,
  manifestPath: string,
  platform: NodeJS.Platform
): ExtraPathPlan {
  const pj = (...parts: string[]) => platformJoin(platform, ...parts);
  const allowlist = (inputPaths ?? []).map((entry) =>
    normalizePath(entry, locations.xdg.homeDir, platform)
  );

  const entries = allowlist.map((sourcePath) => ({
    sourcePath,
    repoPath: pj(repoExtraDir, encodeExtraPath(sourcePath)),
  }));

  return {
    allowlist,
    manifestPath,
    entries,
  };
}
