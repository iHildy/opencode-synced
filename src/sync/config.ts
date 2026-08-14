import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { SyncLocations } from './paths.js';

export interface SyncRepoConfig {
  url?: string;
  owner?: string;
  name?: string;
  branch?: string;
}

export interface SyncConfig {
  repo?: SyncRepoConfig;
  localRepoPath?: string;
  includeSecrets?: boolean;
  includeMcpSecrets?: boolean;
  includeSessions?: boolean;
  includeSkills?: boolean;
  includePromptHistory?: boolean;
  includePromptStash?: boolean;
  includeModelFavorites?: boolean;
  includeModelSelectors?: boolean;
  acknowledgePlaintextPromptRisk?: boolean;
  extraSecretPaths?: string[];
  extraConfigPaths?: string[];
}

export interface SyncState {
  lastAttempt?: string;
  lastFetch?: string;
  lastNoop?: string;
  lastApplied?: string;
  lastCommit?: string;
  lastPull?: string;
  lastPush?: string;
  lastRemoteUpdate?: string;
  lastError?: string;
  lastOutcome?: 'noop' | 'pulled' | 'pushed' | 'failed';
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function chmodIfExists(filePath: string, mode: number): Promise<void> {
  try {
    await fs.chmod(filePath, mode);
  } catch (error) {
    const maybeErrno = error as NodeJS.ErrnoException;
    if (maybeErrno.code === 'ENOENT') return;
    throw error;
  }
}

export function normalizeSyncConfig(config: SyncConfig): SyncConfig {
  assertSupportedSyncScope(config);

  const includePromptHistory = Boolean(config.includePromptHistory);
  const includePromptStash = Boolean(config.includePromptStash);
  const promptsEnabled = includePromptHistory || includePromptStash;
  if (promptsEnabled && config.acknowledgePlaintextPromptRisk !== true) {
    throw new Error(
      'Prompt sync requires acknowledgePlaintextPromptRisk: true because Git history is plaintext.'
    );
  }

  const includeModelFavorites = config.includeModelFavorites !== false;
  return {
    includeSecrets: false,
    includeMcpSecrets: false,
    includeSessions: false,
    includeSkills: Boolean(config.includeSkills),
    includePromptHistory,
    includePromptStash,
    includeModelFavorites,
    includeModelSelectors: Boolean(config.includeModelSelectors),
    acknowledgePlaintextPromptRisk: promptsEnabled,
    extraSecretPaths: [],
    extraConfigPaths: [],
    repo: config.repo,
  };
}

export function canCommitMcpSecrets(config: SyncConfig): boolean {
  void config;
  return false;
}

export function assertSupportedSyncScope(config: SyncConfig): void {
  const unsupported =
    config.includeSecrets === true ||
    config.includeMcpSecrets === true ||
    config.includeSessions === true ||
    (config.extraSecretPaths?.length ?? 0) > 0 ||
    (config.extraConfigPaths?.length ?? 0) > 0 ||
    Boolean(config.localRepoPath);

  if (unsupported) {
    throw new Error(
      'Secrets, sessions, arbitrary extra paths, and localRepoPath are not supported by this fork.'
    );
  }
}

export async function loadSyncConfig(locations: SyncLocations): Promise<SyncConfig | null> {
  if (!(await pathExists(locations.syncConfigPath))) {
    return null;
  }

  const content = await fs.readFile(locations.syncConfigPath, 'utf8');
  const parsed = parseJsonc<SyncConfig>(content);
  return normalizeSyncConfig(parsed);
}

export async function writeSyncConfig(locations: SyncLocations, config: SyncConfig): Promise<void> {
  const parent = path.dirname(locations.syncConfigPath);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await fs.chmod(parent, 0o700);
  const payload = normalizeSyncConfig(config);
  await writeJsonFile(locations.syncConfigPath, payload, { jsonc: true, mode: 0o600 });
}

export async function loadOverrides(
  locations: SyncLocations
): Promise<Record<string, unknown> | null> {
  if (!(await pathExists(locations.overridesPath))) {
    return null;
  }

  const content = await fs.readFile(locations.overridesPath, 'utf8');
  const parsed = parseJsonc<Record<string, unknown>>(content);
  return parsed;
}

export async function loadState(locations: SyncLocations): Promise<SyncState> {
  if (!(await pathExists(locations.statePath))) {
    return {};
  }

  const content = await fs.readFile(locations.statePath, 'utf8');
  return parseJsonc<SyncState>(content);
}

export async function writeState(locations: SyncLocations, state: SyncState): Promise<void> {
  const parent = path.dirname(locations.statePath);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await fs.chmod(parent, 0o700);
  const current = await loadState(locations);
  await writeJsonFile(locations.statePath, { ...current, ...state }, { jsonc: false, mode: 0o600 });
}

export function applyOverridesToRuntimeConfig(
  config: Record<string, unknown>,
  overrides: Record<string, unknown>
): void {
  const merged = deepMerge(config, overrides) as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    delete config[key];
  }
  Object.assign(config, merged);
}

export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : override) as T;
  }

  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

export function stripOverrides(
  localConfig: Record<string, unknown>,
  overrides: Record<string, unknown>,
  baseConfig: Record<string, unknown> | null
): Record<string, unknown> {
  if (!isPlainObject(localConfig) || !isPlainObject(overrides)) {
    return localConfig;
  }

  const result: Record<string, unknown> = { ...localConfig };

  for (const [key, overrideValue] of Object.entries(overrides)) {
    const baseValue = baseConfig ? baseConfig[key] : undefined;
    const currentValue = result[key];

    if (isPlainObject(overrideValue) && isPlainObject(currentValue)) {
      const stripped = stripOverrides(
        currentValue as Record<string, unknown>,
        overrideValue as Record<string, unknown>,
        isPlainObject(baseValue) ? (baseValue as Record<string, unknown>) : null
      );
      if (Object.keys(stripped).length === 0 && !baseValue) {
        delete result[key];
      } else {
        result[key] = stripped;
      }
      continue;
    }

    if (baseValue === undefined) {
      delete result[key];
    } else {
      result[key] = baseValue;
    }
  }

  return result;
}

export function parseJsonc<T>(content: string): T {
  let output = '';
  let inString = false;
  let inSingleLine = false;
  let inMultiLine = false;
  let escapeNext = false;

  for (let i = 0; i < content.length; i += 1) {
    const current = content[i];
    const next = content[i + 1];

    if (inSingleLine) {
      if (current === '\n') {
        inSingleLine = false;
        output += current;
      }
      continue;
    }

    if (inMultiLine) {
      if (current === '*' && next === '/') {
        inMultiLine = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      output += current;
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (current === '\\') {
        escapeNext = true;
        continue;
      }
      if (current === '"') {
        inString = false;
      }
      continue;
    }

    if (current === '"') {
      inString = true;
      output += current;
      continue;
    }

    if (current === '/' && next === '/') {
      inSingleLine = true;
      i += 1;
      continue;
    }

    if (current === '/' && next === '*') {
      inMultiLine = true;
      i += 1;
      continue;
    }

    if (current === ',') {
      let nextIndex = i + 1;
      while (nextIndex < content.length && /\s/.test(content[nextIndex])) {
        nextIndex += 1;
      }
      const nextChar = content[nextIndex];
      if (nextChar === '}' || nextChar === ']') {
        continue;
      }
    }

    output += current;
  }

  return JSON.parse(output) as T;
}

export async function writeJsonFile(
  filePath: string,
  data: unknown,
  options: { jsonc: boolean; mode?: number } = { jsonc: false }
): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  const content = options.jsonc ? `// Generated by opencode-synced\n${json}\n` : `${json}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const current = await lstatOrNull(filePath);
  if (current?.isSymbolicLink()) {
    throw new Error(`Refusing to replace symlink: ${filePath}`);
  }
  if (current && !current.isFile()) throw new Error(`Expected regular file: ${filePath}`);

  const mode = options.mode ?? (current ? current.mode & 0o777 : 0o600);
  const tempPath = `${filePath}.sync-tmp-${randomUUID()}`;
  try {
    await fs.writeFile(tempPath, content, { encoding: 'utf8', mode });
    await fs.chmod(tempPath, mode);
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

async function lstatOrNull(filePath: string) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    const maybeErrno = error as NodeJS.ErrnoException;
    if (maybeErrno.code === 'ENOENT') return null;
    throw error;
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

export function hasOwn(target: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(target, key);
}
