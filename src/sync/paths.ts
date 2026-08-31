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
  chunkLargeFiles?: boolean;
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
  configRoot: string;
}

const DEFAULT_CONFIG_NAME = 'opencode.json';
const DEFAULT_CONFIGC_NAME = 'opencode.jsonc';
const DEFAULT_AGENTS_NAME = 'AGENTS.md';
const DEFAULT_SYNC_CONFIG_NAME = 'opencode-synced.jsonc';
const DEFAULT_OVERRIDES_NAME = 'opencode-synced.overrides.jsonc';
const DEFAULT_STATE_NAME = 'sync-state.json';

const CONFIG_DIRS = [
  'agent',
  'agents',
  'command',
  'commands',
  'mode',
  'modes',
  'tool',
  'tools',
  'themes',
  'plugin',
  'plugins',
];
const SESSION_DIRS = ['storage/session', 'storage/message', 'storage/part', 'storage/session_diff'];
const SESSION_DB_FILE = 'opencode.db';
const PROMPT_STASH_FILES = ['prompt-stash.jsonl', 'prompt-history.jsonl'];
const MODEL_FAVORITES_FILE = 'model.json';
const SKILLS_DIR = 'skills';
const HOME_AGENTS_DIR = '.agents';

function pathApiFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function resolveHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    if (env.USERPROFILE) return env.USERPROFILE;
    if (env.HOMEDRIVE && env.HOMEPATH) {
      return path.win32.join(env.HOMEDRIVE, env.HOMEPATH);
    }
    return env.HOME ?? '';
  }

  return env.HOME ?? '';
}

export function resolveXdgPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): XdgPaths {
  const homeDir = resolveHomeDir(env, platform);
  const pathApi = pathApiFor(platform);

  if (!homeDir) {
    return {
      homeDir: '',
      configDir: '',
      dataDir: '',
      stateDir: '',
    };
  }

  const configDir = env.XDG_CONFIG_HOME ?? pathApi.join(homeDir, '.config');
  const dataDir = env.XDG_DATA_HOME ?? pathApi.join(homeDir, '.local', 'share');
  const stateDir = env.XDG_STATE_HOME ?? pathApi.join(homeDir, '.local', 'state');

  return { homeDir, configDir, dataDir, stateDir };
}

export function resolveSyncLocations(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): SyncLocations {
  const xdg = resolveXdgPaths(env, platform);
  const pathApi = pathApiFor(platform);
  const customConfigDir = env.opencode_config_dir;
  const configRoot = customConfigDir
    ? pathApi.resolve(expandHome(customConfigDir, xdg.homeDir, platform))
    : pathApi.join(xdg.configDir, 'opencode');
  const dataRoot = pathApi.join(xdg.dataDir, 'opencode');

  return {
    xdg,
    configRoot,
    syncConfigPath: pathApi.join(configRoot, DEFAULT_SYNC_CONFIG_NAME),
    overridesPath: pathApi.join(configRoot, DEFAULT_OVERRIDES_NAME),
    statePath: pathApi.join(dataRoot, DEFAULT_STATE_NAME),
    defaultRepoDir: pathApi.join(dataRoot, 'opencode-synced', 'repo'),
  };
}

export function expandHome(
  inputPath: string,
  homeDir: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (!inputPath) return inputPath;
  if (!homeDir) return inputPath;
  if (inputPath === '~') return homeDir;
  if (inputPath.startsWith('~/')) return pathApiFor(platform).join(homeDir, inputPath.slice(2));
  return inputPath;
}

export function normalizePath(
  inputPath: string,
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
  baseDir?: string
): string {
  const pathApi = pathApiFor(platform);
  const expanded = expandHome(inputPath, homeDir, platform);
  const resolved = baseDir ? pathApi.resolve(baseDir, expanded) : pathApi.resolve(expanded);
  if (platform === 'win32') {
    return resolved.toLowerCase();
  }
  return resolved;
}

export function resolveExtraPath(
  inputPath: string,
  locations: SyncLocations,
  platform: NodeJS.Platform = process.platform
): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const configRoot = pathApi.join(locations.xdg.configDir, 'opencode');
  return normalizePath(inputPath, locations.xdg.homeDir, platform, configRoot);
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

export function resolveRepoRoot(
  config: SyncConfig | null,
  locations: SyncLocations,
  platform: NodeJS.Platform = process.platform
): string {
  if (config?.localRepoPath) {
    return expandHome(config.localRepoPath, locations.xdg.homeDir, platform);
  }

  return locations.defaultRepoDir;
}

export function buildSyncPlan(
  config: NormalizedSyncConfig,
  locations: SyncLocations,
  repoRoot: string,
  platform: NodeJS.Platform = process.platform
): SyncPlan {
  const pathApi = pathApiFor(platform);
  const configRoot = locations.configRoot;
  const dataRoot = pathApi.join(locations.xdg.dataDir, 'opencode');
  const stateRoot = pathApi.join(locations.xdg.stateDir, 'opencode');
  const repoConfigRoot = pathApi.join(repoRoot, 'config');
  const repoDataRoot = pathApi.join(repoRoot, 'data');
  const repoSecretsRoot = pathApi.join(repoRoot, 'secrets');
  const repoStateRoot = pathApi.join(repoRoot, 'state');
  const repoExtraDir = pathApi.join(repoSecretsRoot, 'extra');
  const manifestPath = pathApi.join(repoSecretsRoot, 'extra-manifest.json');
  const repoConfigExtraDir = pathApi.join(repoConfigRoot, 'extra');
  const configManifestPath = pathApi.join(repoConfigRoot, 'extra-manifest.json');

  const items: SyncItem[] = [];
  const usingSecretsBackend = hasSecretsBackend(config);
  const authJsonPath = pathApi.join(dataRoot, 'auth.json');
  const mcpAuthJsonPath = pathApi.join(dataRoot, 'mcp-auth.json');

  const addFile = (name: string, isSecret: boolean, isConfigFile: boolean): void => {
    items.push({
      localPath: pathApi.join(configRoot, name),
      repoPath: pathApi.join(repoConfigRoot, name),
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
      localPath: pathApi.join(configRoot, dirName),
      repoPath: pathApi.join(repoConfigRoot, dirName),
      type: 'dir',
      isSecret: false,
      isConfigFile: false,
    });
  }

  if (config.includeOpencodeSkills !== false) {
    items.push({
      localPath: pathApi.join(configRoot, SKILLS_DIR),
      repoPath: pathApi.join(repoConfigRoot, SKILLS_DIR),
      type: 'dir',
      isSecret: false,
      isConfigFile: false,
    });
  }

  if (config.includeAgentsDir !== false) {
    items.push({
      localPath: pathApi.join(locations.xdg.homeDir, HOME_AGENTS_DIR),
      repoPath: pathApi.join(repoConfigRoot, HOME_AGENTS_DIR),
      type: 'dir',
      isSecret: false,
      isConfigFile: false,
    });
  }

  if (config.includeModelFavorites !== false) {
    items.push({
      localPath: pathApi.join(stateRoot, MODEL_FAVORITES_FILE),
      repoPath: pathApi.join(repoStateRoot, MODEL_FAVORITES_FILE),
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
          repoPath: pathApi.join(repoDataRoot, 'auth.json'),
          type: 'file',
          isSecret: true,
          isConfigFile: false,
        },
        {
          localPath: mcpAuthJsonPath,
          repoPath: pathApi.join(repoDataRoot, 'mcp-auth.json'),
          type: 'file',
          isSecret: true,
          isConfigFile: false,
        }
      );
    }

    if (config.includeSessions && !isTursoSessionBackend(config)) {
      items.push({
        localPath: pathApi.join(dataRoot, SESSION_DB_FILE),
        repoPath: pathApi.join(repoDataRoot, SESSION_DB_FILE),
        type: 'file',
        isSecret: true,
        isConfigFile: false,
        preserveWhenMissing: true,
        chunkLargeFiles: true,
      });

      for (const dirName of SESSION_DIRS) {
        items.push({
          localPath: pathApi.join(dataRoot, dirName),
          repoPath: pathApi.join(repoDataRoot, dirName),
          type: 'dir',
          isSecret: true,
          isConfigFile: false,
          preserveWhenMissing: true,
          chunkLargeFiles: dirName === 'storage/message',
        });
      }
    }

    if (config.includePromptStash) {
      for (const fileName of PROMPT_STASH_FILES) {
        items.push({
          localPath: pathApi.join(stateRoot, fileName),
          repoPath: pathApi.join(repoStateRoot, fileName),
          type: 'file',
          isSecret: true,
          isConfigFile: false,
        });
      }
    }
  }

  const extraSecretPaths = config.includeSecrets
    ? config.extraSecretPaths.map((entry) => resolveExtraPath(entry, locations, platform))
    : [];
  const filteredExtraSecrets = usingSecretsBackend
    ? extraSecretPaths.filter(
        (entry) =>
          !isSamePath(entry, authJsonPath, locations.xdg.homeDir, platform) &&
          !isSamePath(entry, mcpAuthJsonPath, locations.xdg.homeDir, platform)
      )
    : extraSecretPaths;

  const extraSecrets = buildExtraPathPlan(
    filteredExtraSecrets,
    repoExtraDir,
    manifestPath,
    platform
  );

  const extraConfigPaths = (config.extraConfigPaths ?? [])
    .map((entry) => resolveExtraPath(entry, locations, platform))
    .filter(
      (entry) =>
        !items.some((item) => isSamePath(entry, item.localPath, locations.xdg.homeDir, platform))
    );

  const extraConfigs = buildExtraPathPlan(
    extraConfigPaths,
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
    configRoot: locations.configRoot,
  };
}

function buildExtraPathPlan(
  sourcePaths: string[],
  repoExtraDir: string,
  manifestPath: string,
  platform: NodeJS.Platform
): ExtraPathPlan {
  const entries = sourcePaths.map((sourcePath) => ({
    sourcePath,
    repoPath: pathApiFor(platform).join(repoExtraDir, encodeExtraPath(sourcePath)),
  }));

  return {
    allowlist: sourcePaths,
    manifestPath,
    entries,
  };
}

/**
 * Convert an absolute sourcePath to a portable form for the manifest.
 * If the path is configRoot, store it as ".". Paths inside it are relative.
 * If outside configRoot, store it with ~/ prefix (e.g. "~/.ssh/id_rsa").
 * Manifest separators are always forward slashes.
 */
export function toPortablePath(
  absolutePath: string,
  configRoot: string,
  homeDir: string,
  pathApi: typeof path.posix = process.platform === 'win32' ? path.win32 : path.posix
): string {
  const relativeToConfig = relativeIfContained(absolutePath, configRoot, pathApi);
  if (relativeToConfig !== null) {
    return relativeToConfig === '' ? '.' : toPortableSeparators(relativeToConfig);
  }

  const relativeToHome = homeDir ? relativeIfContained(absolutePath, homeDir, pathApi) : null;
  if (relativeToHome !== null) {
    return relativeToHome === '' ? '~' : `~/${toPortableSeparators(relativeToHome)}`;
  }

  return toPortableSeparators(absolutePath);
}

/**
 * Resolve a portable sourcePath from the manifest back to a local absolute path.
 * "." and relative paths are resolved against configRoot.
 * ~/ paths are expanded via the local homeDir.
 * Absolute POSIX, drive-letter, and UNC paths remain absolute for backwards compatibility.
 */
export function fromPortablePath(
  portablePath: string,
  configRoot: string,
  homeDir: string,
  pathApi: typeof path.posix = process.platform === 'win32' ? path.win32 : path.posix
): string {
  if (!portablePath) return portablePath;

  if (portablePath === '.') return pathApi.resolve(configRoot);
  if (portablePath === '~') return pathApi.resolve(homeDir);
  if (portablePath.startsWith('~/') || portablePath.startsWith('~\\')) {
    return pathApi.resolve(homeDir, portablePath.slice(2));
  }

  if (isAbsoluteOnAnyPlatform(portablePath)) {
    return portablePath;
  }

  return pathApi.resolve(configRoot, portablePath);
}

function relativeIfContained(
  candidatePath: string,
  rootPath: string,
  pathApi: typeof path.posix
): string | null {
  const resolvedCandidate = pathApi.resolve(candidatePath);
  const resolvedRoot = pathApi.resolve(rootPath);
  const comparisonCandidate = normalizeForComparison(resolvedCandidate, pathApi);
  const comparisonRoot = normalizeForComparison(resolvedRoot, pathApi);
  const comparisonRelative = pathApi.relative(comparisonRoot, comparisonCandidate);

  if (
    comparisonRelative === '..' ||
    comparisonRelative.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(comparisonRelative)
  ) {
    return null;
  }

  return pathApi.relative(resolvedRoot, resolvedCandidate);
}

function normalizeForComparison(inputPath: string, pathApi: typeof path.posix): string {
  const normalized = pathApi.normalize(inputPath);
  return pathApi === path.win32 ? normalized.toLowerCase() : normalized;
}

function isAbsoluteOnAnyPlatform(inputPath: string): boolean {
  if (path.posix.isAbsolute(inputPath)) return true;
  if (/^[a-zA-Z]:[\\/]/.test(inputPath)) return true;
  return /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(inputPath);
}

function toPortableSeparators(inputPath: string): string {
  return inputPath.replace(/\\/g, '/');
}
