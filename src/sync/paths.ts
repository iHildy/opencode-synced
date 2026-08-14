import path from 'node:path';

import { assertSupportedSyncScope, type SyncConfig } from './config.js';

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
export type SyncItemStrategy =
  | 'copy'
  | 'skills'
  | 'prompt-snapshot'
  | 'model-favorites'
  | 'model-selector';

export interface SyncItem {
  localPath: string;
  repoPath: string;
  type: SyncItemType;
  isSecret: boolean;
  isConfigFile: boolean;
  strategy?: SyncItemStrategy;
}

export interface SyncPlan {
  items: SyncItem[];
  repoRoot: string;
  homeDir: string;
  localRoots?: string[];
  platform: NodeJS.Platform;
}

const DEFAULT_CONFIG_NAME = 'opencode.json';
const DEFAULT_CONFIGC_NAME = 'opencode.jsonc';
const DEFAULT_AGENTS_NAME = 'AGENTS.md';
const DEFAULT_SYNC_CONFIG_NAME = 'opencode-synced.jsonc';
const DEFAULT_OVERRIDES_NAME = 'opencode-synced.overrides.jsonc';
const DEFAULT_STATE_NAME = 'sync-state.json';

const CONFIG_DIRS = ['agent', 'command', 'mode', 'tool', 'themes', 'plugin'];
const MODEL_FAVORITES_FILE = 'model.json';
const PROMPT_HISTORY_FILE = 'prompt-history.jsonl';
const PROMPT_STASH_FILE = 'prompt-stash.jsonl';
const MODEL_SELECTOR_FILES = ['main-model.txt', 'cheap-model.txt'];

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

  if (platform === 'win32') {
    const configDir = env.APPDATA ?? path.join(homeDir, 'AppData', 'Roaming');
    const dataDir = env.LOCALAPPDATA ?? path.join(homeDir, 'AppData', 'Local');
    // Windows doesn't have XDG_STATE_HOME equivalent, use LOCALAPPDATA
    const stateDir = env.LOCALAPPDATA ?? path.join(homeDir, 'AppData', 'Local');
    return { homeDir, configDir, dataDir, stateDir };
  }

  const configDir = env.XDG_CONFIG_HOME ?? path.join(homeDir, '.config');
  const dataDir = env.XDG_DATA_HOME ?? path.join(homeDir, '.local', 'share');
  const stateDir = env.XDG_STATE_HOME ?? path.join(homeDir, '.local', 'state');

  return { homeDir, configDir, dataDir, stateDir };
}

export function resolveSyncLocations(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): SyncLocations {
  const xdg = resolveXdgPaths(env, platform);
  const customConfigDir = env.OPENCODE_CONFIG_DIR ?? env.opencode_config_dir;
  const configRoot = customConfigDir
    ? path.resolve(expandHome(customConfigDir, xdg.homeDir))
    : path.join(xdg.configDir, 'opencode');
  const dataRoot = path.join(xdg.dataDir, 'opencode');

  return {
    xdg,
    configRoot,
    syncConfigPath: path.join(configRoot, DEFAULT_SYNC_CONFIG_NAME),
    overridesPath: path.join(configRoot, DEFAULT_OVERRIDES_NAME),
    statePath: path.join(dataRoot, DEFAULT_STATE_NAME),
    defaultRepoDir: path.join(dataRoot, 'opencode-synced', 'repo'),
  };
}

export function expandHome(inputPath: string, homeDir: string): string {
  if (!inputPath) return inputPath;
  if (!homeDir) return inputPath;
  if (inputPath === '~') return homeDir;
  if (inputPath.startsWith('~/')) return path.join(homeDir, inputPath.slice(2));
  return inputPath;
}

export function normalizePath(
  inputPath: string,
  homeDir: string,
  platform: NodeJS.Platform = process.platform
): string {
  const expanded = expandHome(inputPath, homeDir);
  const resolved = path.resolve(expanded);
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

export function resolveRepoRoot(config: SyncConfig | null, locations: SyncLocations): string {
  if (config?.localRepoPath) {
    return expandHome(config.localRepoPath, locations.xdg.homeDir);
  }

  return locations.defaultRepoDir;
}

export function buildSyncPlan(
  config: SyncConfig,
  locations: SyncLocations,
  repoRoot: string,
  platform: NodeJS.Platform = process.platform
): SyncPlan {
  assertSupportedSyncScope(config);

  const configRoot = locations.configRoot;
  const stateRoot = path.join(locations.xdg.stateDir, 'opencode');
  const repoConfigRoot = path.join(repoRoot, 'config');
  const repoStateRoot = path.join(repoRoot, 'state');

  const items: SyncItem[] = [];

  const addFile = (name: string, isSecret: boolean, isConfigFile: boolean): void => {
    items.push({
      localPath: path.join(configRoot, name),
      repoPath: path.join(repoConfigRoot, name),
      type: 'file',
      isSecret,
      isConfigFile,
    });
  };

  addFile(DEFAULT_CONFIG_NAME, false, true);
  addFile(DEFAULT_CONFIGC_NAME, false, true);
  addFile(DEFAULT_AGENTS_NAME, false, false);

  for (const dirName of CONFIG_DIRS) {
    items.push({
      localPath: path.join(configRoot, dirName),
      repoPath: path.join(repoConfigRoot, dirName),
      type: 'dir',
      isSecret: false,
      isConfigFile: false,
    });
  }

  if (config.includeSkills) {
    items.push({
      localPath: path.join(configRoot, 'skills'),
      repoPath: path.join(repoConfigRoot, 'skills'),
      type: 'dir',
      isSecret: false,
      isConfigFile: false,
      strategy: 'skills',
    });
  }

  if (config.includeModelFavorites !== false) {
    items.push({
      localPath: path.join(stateRoot, MODEL_FAVORITES_FILE),
      repoPath: path.join(repoStateRoot, 'model-favorites.json'),
      type: 'file',
      isSecret: false,
      isConfigFile: false,
      strategy: 'model-favorites',
    });
  }

  if (config.includePromptHistory) {
    items.push({
      localPath: path.join(stateRoot, PROMPT_HISTORY_FILE),
      repoPath: path.join(repoStateRoot, 'prompts', PROMPT_HISTORY_FILE),
      type: 'file',
      isSecret: true,
      isConfigFile: false,
      strategy: 'prompt-snapshot',
    });
  }

  if (config.includePromptStash) {
    items.push({
      localPath: path.join(stateRoot, PROMPT_STASH_FILE),
      repoPath: path.join(repoStateRoot, 'prompts', PROMPT_STASH_FILE),
      type: 'file',
      isSecret: true,
      isConfigFile: false,
      strategy: 'prompt-snapshot',
    });
  }

  if (config.includeModelSelectors) {
    for (const fileName of MODEL_SELECTOR_FILES) {
      items.push({
        localPath: path.join(configRoot, fileName),
        repoPath: path.join(repoStateRoot, 'model-selectors', fileName),
        type: 'file',
        isSecret: false,
        isConfigFile: false,
        strategy: 'model-selector',
      });
    }
  }

  return {
    items,
    repoRoot,
    homeDir: locations.xdg.homeDir,
    localRoots: [configRoot, stateRoot],
    platform,
  };
}
