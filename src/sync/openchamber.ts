import { promises as fs } from 'node:fs';
import path from 'node:path';

import { isPlainObject, pathExists } from './config.js';

/**
 * Syncs a safe subset of OpenChamber's `preferences.json` between machines.
 *
 * The file looks like `{ "version": 1, "fields": { "<name>": { "value": ..., "updatedAt": 123 } } }`.
 * Fields are merged one by one and the newest `updatedAt` wins, so two machines never overwrite each
 * other's unrelated settings. Only allowlisted fields are copied, the per-device `surfaces` data is
 * never written to the repo, and field names that look like credentials are always refused.
 */

export interface OpenChamberPlan {
  localPath: string;
  repoPath: string;
  include: string[];
  exclude: string[];
}

export type OpenChamberSyncResult =
  | 'changed'
  | 'unchanged'
  | 'missing-local'
  | 'missing-repo'
  | 'invalid'
  | 'version-mismatch';

interface PreferenceEntry {
  value?: unknown;
  updatedAt?: number;
  surfaces?: unknown;
  [key: string]: unknown;
}

interface PreferencesDocument {
  version?: number;
  fields: Record<string, PreferenceEntry>;
  [key: string]: unknown;
}

/** Conservative defaults: appearance, notifications, favourites and behaviour toggles. */
export const DEFAULT_OPENCHAMBER_FIELDS: readonly string[] = [
  'lightThemeId',
  'darkThemeId',
  'themeVariant',
  'notifyOnSubtasks',
  'notifyOnCompletion',
  'notifyOnError',
  'notifyOnQuestion',
  'notificationMode',
  'notificationTemplates',
  'favoriteModels',
  'favoriteAgents',
  'hiddenModels',
  'collapsedModelProviders',
  'customProviderIcons',
  'workStatusPanelEnabled',
  'gitmojiEnabled',
  'largeTextPasteBehavior',
];

const SENSITIVE_FIELD = /token|secret|password|credential|private|api[-_]?key|vapid|identity/iu;

function matchesPattern(name: string, pattern: string): boolean {
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

export function isSyncableField(name: string, include: string[], exclude: string[]): boolean {
  if (SENSITIVE_FIELD.test(name)) return false;
  if (exclude.some((pattern) => matchesPattern(name, pattern))) return false;
  const allowed = include.length > 0 ? include : DEFAULT_OPENCHAMBER_FIELDS;
  return allowed.some((pattern) => matchesPattern(name, pattern));
}

function timestamp(entry: PreferenceEntry | undefined): number {
  const value = entry?.updatedAt;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isEntry(value: unknown): value is PreferenceEntry {
  return isPlainObject(value);
}

async function readPreferences(
  filePath: string
): Promise<PreferencesDocument | 'missing' | 'invalid'> {
  if (!(await pathExists(filePath))) return 'missing';
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (!isPlainObject(parsed) || !isPlainObject(parsed.fields)) return 'invalid';
    const fields: Record<string, PreferenceEntry> = {};
    for (const [name, entry] of Object.entries(parsed.fields)) {
      if (!isEntry(entry)) continue;
      Object.defineProperty(fields, name, {
        value: entry,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return { ...parsed, fields } as PreferencesDocument;
  } catch {
    return 'invalid';
  }
}

function serialize(document: PreferencesDocument): string {
  const sorted: Record<string, PreferenceEntry> = {};
  for (const name of Object.keys(document.fields).sort()) {
    Object.defineProperty(sorted, name, {
      value: document.fields[name],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return `${JSON.stringify({ ...document, fields: sorted }, null, 2)}\n`;
}

async function writeAtomically(filePath: string, content: string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', mode });
    await fs.chmod(temporary, mode);
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

function withoutSurfaces(entry: PreferenceEntry): PreferenceEntry {
  const { surfaces: _surfaces, ...rest } = entry;
  return rest;
}

/** Copies newer allowlisted fields from the local preferences file into the sync repo. */
export async function pushOpenChamberPreferences(
  plan: OpenChamberPlan
): Promise<OpenChamberSyncResult> {
  const local = await readPreferences(plan.localPath);
  if (local === 'missing') return 'missing-local';
  if (local === 'invalid') return 'invalid';

  const existing = await readPreferences(plan.repoPath);
  if (existing === 'invalid') return 'invalid';
  const repo: PreferencesDocument =
    existing === 'missing' ? { version: local.version ?? 1, fields: {} } : existing;
  if (
    typeof repo.version === 'number' &&
    typeof local.version === 'number' &&
    repo.version !== local.version
  ) {
    return 'version-mismatch';
  }

  let changed = false;
  for (const [name, entry] of Object.entries(local.fields)) {
    if (!isSyncableField(name, plan.include, plan.exclude)) continue;
    const current = repo.fields[name];
    if (current && timestamp(entry) <= timestamp(current)) continue;
    Object.defineProperty(repo.fields, name, {
      value: withoutSurfaces(entry),
      enumerable: true,
      writable: true,
      configurable: true,
    });
    changed = true;
  }
  if (!changed) return 'unchanged';

  await writeAtomically(plan.repoPath, serialize(repo), 0o644);
  return 'changed';
}

/** Applies newer allowlisted fields from the sync repo to the local preferences file. */
export async function pullOpenChamberPreferences(
  plan: OpenChamberPlan
): Promise<OpenChamberSyncResult> {
  const repo = await readPreferences(plan.repoPath);
  if (repo === 'missing') return 'missing-repo';
  if (repo === 'invalid') return 'invalid';
  const local = await readPreferences(plan.localPath);
  if (local === 'missing') return 'missing-local';
  if (local === 'invalid') return 'invalid';
  if (
    typeof repo.version === 'number' &&
    typeof local.version === 'number' &&
    repo.version !== local.version
  ) {
    return 'version-mismatch';
  }

  let changed = false;
  for (const [name, entry] of Object.entries(repo.fields)) {
    if (!isSyncableField(name, plan.include, plan.exclude)) continue;
    const current = local.fields[name];
    if (current && timestamp(entry) <= timestamp(current)) continue;
    const merged: PreferenceEntry = { ...withoutSurfaces(entry) };
    if (current?.surfaces !== undefined) {
      merged.surfaces = current.surfaces;
    }
    Object.defineProperty(local.fields, name, {
      value: merged,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    changed = true;
  }
  if (!changed) return 'unchanged';

  const stat = await fs.stat(plan.localPath);
  const backupPath = `${plan.localPath}.pre-opencode-synced`;
  if (!(await pathExists(backupPath))) {
    await fs.copyFile(plan.localPath, backupPath);
  }
  await writeAtomically(plan.localPath, serialize(local), stat.mode & 0o777);
  return 'changed';
}
