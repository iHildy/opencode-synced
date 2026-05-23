import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { SyncLocations } from './paths.js';

export interface SyncRepoConfig {
  url?: string;
  owner?: string;
  name?: string;
  branch?: string;
}

export type KnownSecretsBackendType = '1password';
export type SecretsBackendType = KnownSecretsBackendType | (string & {});

export interface SecretsBackendDocuments {
  authJson?: string;
  mcpAuthJson?: string;
}

export interface SecretsBackendConfig {
  type: SecretsBackendType;
  vault?: string;
  documents?: SecretsBackendDocuments;
}

export type SessionBackendType = 'git' | 'turso';

export interface TursoSessionBackendSettings {
  database?: string;
  url?: string;
  syncIntervalSec?: number;
  autoSetup?: boolean;
}

export interface SessionBackendConfig {
  type?: SessionBackendType;
  turso?: TursoSessionBackendSettings;
}

export interface NormalizedTursoSessionBackendSettings {
  database?: string;
  url?: string;
  syncIntervalSec: number;
  autoSetup: boolean;
}

export interface NormalizedSessionBackendConfig {
  type: SessionBackendType;
  turso: NormalizedTursoSessionBackendSettings;
}

export interface SyncConfig {
  repo?: SyncRepoConfig;
  localRepoPath?: string;
  includeSecrets?: boolean;
  includeMcpSecrets?: boolean;
  includeSessions?: boolean;
  sessionBackend?: SessionBackendConfig;
  includePromptStash?: boolean;
  includeModelFavorites?: boolean;
  includeOpencodeSkills?: boolean;
  includeAgentsDir?: boolean;
  secretsBackend?: SecretsBackendConfig;
  extraSecretPaths?: string[];
  extraConfigPaths?: string[];
}

export interface NormalizedSyncConfig extends SyncConfig {
  includeSecrets: boolean;
  includeMcpSecrets: boolean;
  includeSessions: boolean;
  sessionBackend: NormalizedSessionBackendConfig;
  includePromptStash: boolean;
  includeModelFavorites: boolean;
  includeOpencodeSkills: boolean;
  includeAgentsDir: boolean;
  secretsBackend?: SecretsBackendConfig;
  extraSecretPaths: string[];
  extraConfigPaths: string[];
}

export interface SyncState {
  lastPull?: string;
  lastPush?: string;
  lastRemoteUpdate?: string;
  lastSecretsHash?: string;
  lastSessionPull?: string;
  lastSessionPush?: string;
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

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

export function normalizeSecretsBackend(
  input: SyncConfig['secretsBackend']
): SecretsBackendConfig | undefined {
  if (!input || typeof input !== 'object') return undefined;

  const type = typeof input.type === 'string' ? input.type : undefined;
  if (!type) return undefined;

  if (type !== '1password') {
    return { type };
  }

  const vault = typeof input.vault === 'string' ? input.vault : undefined;
  const documentsInput = isPlainObject(input.documents) ? input.documents : {};

  const documents: SecretsBackendDocuments = {
    authJson: typeof documentsInput.authJson === 'string' ? documentsInput.authJson : undefined,
    mcpAuthJson:
      typeof documentsInput.mcpAuthJson === 'string' ? documentsInput.mcpAuthJson : undefined,
  };

  return { type: '1password', vault, documents };
}

function normalizeTursoBackendSettings(
  input: SessionBackendConfig['turso']
): NormalizedTursoSessionBackendSettings {
  const syncIntervalRaw = input?.syncIntervalSec;
  const syncIntervalSec =
    typeof syncIntervalRaw === 'number' && Number.isFinite(syncIntervalRaw) && syncIntervalRaw > 0
      ? Math.floor(syncIntervalRaw)
      : 15;

  return {
    database: typeof input?.database === 'string' ? input.database : undefined,
    url: typeof input?.url === 'string' ? input.url : undefined,
    syncIntervalSec,
    autoSetup: input?.autoSetup !== false,
  };
}

export function normalizeSessionBackend(
  input: SyncConfig['sessionBackend']
): NormalizedSessionBackendConfig {
  const type = input?.type === 'turso' ? 'turso' : 'git';
  return {
    type,
    turso: normalizeTursoBackendSettings(input?.turso),
  };
}

export function isTursoSessionBackend(config: SyncConfig | NormalizedSyncConfig): boolean {
  if (!config.includeSessions) return false;
  const normalized = normalizeSessionBackend(config.sessionBackend);
  return normalized.type === 'turso';
}

export function normalizeSyncConfig(config: SyncConfig): NormalizedSyncConfig {
  const includeSecrets = Boolean(config.includeSecrets);
  const includeModelFavorites = config.includeModelFavorites !== false;
  const includeOpencodeSkills = config.includeOpencodeSkills !== false;
  const includeAgentsDir = config.includeAgentsDir !== false;
  return {
    includeSecrets,
    includeMcpSecrets: includeSecrets ? Boolean(config.includeMcpSecrets) : false,
    includeSessions: Boolean(config.includeSessions),
    sessionBackend: normalizeSessionBackend(config.sessionBackend),
    includePromptStash: Boolean(config.includePromptStash),
    includeModelFavorites,
    includeOpencodeSkills,
    includeAgentsDir,
    secretsBackend: normalizeSecretsBackend(config.secretsBackend),
    extraSecretPaths: Array.isArray(config.extraSecretPaths) ? config.extraSecretPaths : [],
    extraConfigPaths: Array.isArray(config.extraConfigPaths) ? config.extraConfigPaths : [],
    localRepoPath: config.localRepoPath,
    repo: config.repo,
  };
}

export function canCommitMcpSecrets(config: SyncConfig): boolean {
  return Boolean(config.includeSecrets) && Boolean(config.includeMcpSecrets);
}

export function hasSecretsBackend(config: SyncConfig | NormalizedSyncConfig): boolean {
  return Boolean(config.secretsBackend);
}

export async function loadSyncConfig(
  locations: SyncLocations
): Promise<NormalizedSyncConfig | null> {
  if (!(await pathExists(locations.syncConfigPath))) {
    return null;
  }

  const content = await fs.readFile(locations.syncConfigPath, 'utf8');
  const parsed = parseJsonc<SyncConfig>(content);
  return normalizeSyncConfig(parsed);
}

export async function writeSyncConfig(locations: SyncLocations, config: SyncConfig): Promise<void> {
  await fs.mkdir(path.dirname(locations.syncConfigPath), { recursive: true });
  const payload = normalizeSyncConfig(config);
  await writeJsonFile(locations.syncConfigPath, payload, { jsonc: true });
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
  await fs.mkdir(path.dirname(locations.statePath), { recursive: true });
  await writeJsonFile(locations.statePath, state, { jsonc: false });
}

export async function updateState(
  locations: SyncLocations,
  update: Partial<SyncState>
): Promise<void> {
  const existing = await loadState(locations);
  await writeState(locations, { ...existing, ...update });
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
  await fs.writeFile(filePath, content, 'utf8');
  if (options.mode !== undefined) {
    await chmodIfExists(filePath, options.mode);
  }
}

export function hasOwn(target: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(target, key);
}
