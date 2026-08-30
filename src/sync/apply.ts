import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  chmodIfExists,
  deepMerge,
  hasOwn,
  parseJsonc,
  pathExists,
  stripOverrides,
  writeJsonFile,
} from './config.js';
import {
  extractMcpSecrets,
  hasOverrides,
  mergeOverrides,
  stripOverrideKeys,
} from './mcp-secrets.js';
import type { ExtraPathPlan, SyncItem, SyncPlan } from './paths.js';
import { normalizePath } from './paths.js';

type ExtraPathType = 'file' | 'dir';

const SESSION_DB_NAME = 'opencode.db';
const SESSION_DB_SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;

interface ExtraPathManifestItem {
  relativePath: string;
  type: ExtraPathType;
  mode?: number;
}

interface ExtraPathManifestEntry {
  sourcePath: string;
  repoPath: string;
  type?: ExtraPathType;
  mode?: number;
  items?: ExtraPathManifestItem[];
}

interface ExtraPathManifest {
  entries: ExtraPathManifestEntry[];
}

export async function syncRepoToLocal(
  plan: SyncPlan,
  overrides: Record<string, unknown> | null
): Promise<void> {
  for (const item of plan.items) {
    await copyItem(item.repoPath, item.localPath, item.type);
  }

  await applyExtraPaths(plan, plan.extraConfigs);
  await applyExtraPaths(plan, plan.extraSecrets);

  if (overrides && Object.keys(overrides).length > 0) {
    await applyOverridesToLocalConfig(plan, overrides);
  }
}

export async function syncLocalToRepo(
  plan: SyncPlan,
  overrides: Record<string, unknown> | null,
  options: { overridesPath?: string; allowMcpSecrets?: boolean } = {}
): Promise<void> {
  const configItems = plan.items.filter((item) => item.isConfigFile);
  const sanitizedConfigs = new Map<string, Record<string, unknown>>();
  let secretOverrides: Record<string, unknown> = {};
  const allowMcpSecrets = Boolean(options.allowMcpSecrets);

  for (const item of configItems) {
    if (!(await pathExists(item.localPath))) continue;

    const content = await fs.readFile(item.localPath, 'utf8');
    const parsed = parseJsonc<Record<string, unknown>>(content);
    const { sanitizedConfig, secretOverrides: extracted } = extractMcpSecrets(parsed);
    if (!allowMcpSecrets) {
      sanitizedConfigs.set(item.localPath, sanitizedConfig);
    }
    if (hasOverrides(extracted)) {
      secretOverrides = mergeOverrides(secretOverrides, extracted);
    }
  }

  let overridesForStrip = overrides;
  if (hasOverrides(secretOverrides)) {
    if (!allowMcpSecrets) {
      const baseOverrides = overrides ?? {};
      const mergedOverrides = mergeOverrides(baseOverrides, secretOverrides);
      if (options.overridesPath && !isDeepEqual(baseOverrides, mergedOverrides)) {
        await writeJsonFile(options.overridesPath, mergedOverrides, { jsonc: true });
      }
    }
    overridesForStrip = overrides ? stripOverrideKeys(overrides, secretOverrides) : overrides;
  }

  for (const item of plan.items) {
    if (item.isConfigFile) {
      const sanitized = sanitizedConfigs.get(item.localPath);
      await copyConfigForRepo(item, overridesForStrip, plan.repoRoot, sanitized, {
        removeWhenMissing: !item.preserveWhenMissing,
      });
      continue;
    }

    await copyItem(item.localPath, item.repoPath, item.type, !item.preserveWhenMissing);
  }

  await writeExtraPathManifest(plan, plan.extraConfigs);
  await writeExtraPathManifest(plan, plan.extraSecrets);
}

async function copyItem(
  sourcePath: string,
  destinationPath: string,
  type: SyncItem['type'],
  removeWhenMissing = false
): Promise<void> {
  if (
    type === 'file' &&
    (path.basename(sourcePath) === SESSION_DB_NAME ||
      path.basename(destinationPath) === SESSION_DB_NAME)
  ) {
    await copySessionDbBundle(sourcePath, destinationPath, removeWhenMissing);
    return;
  }

  if (!(await pathExists(sourcePath))) {
    if (removeWhenMissing) {
      await removePath(destinationPath);
    }
    return;
  }

  if (type === 'file') {
    await copyFileWithMode(sourcePath, destinationPath);
    return;
  }

  await removePath(destinationPath);
  await copyDirRecursive(sourcePath, destinationPath);
}

async function copyConfigForRepo(
  item: SyncItem,
  overrides: Record<string, unknown> | null,
  repoRoot: string,
  configOverride?: Record<string, unknown>,
  options: { removeWhenMissing?: boolean } = {}
): Promise<void> {
  const removeWhenMissing = options.removeWhenMissing ?? true;
  if (!(await pathExists(item.localPath))) {
    if (removeWhenMissing) {
      await removePath(item.repoPath);
    }
    return;
  }

  const localConfig =
    configOverride ??
    parseJsonc<Record<string, unknown>>(await fs.readFile(item.localPath, 'utf8'));
  const baseConfig = await readRepoConfig(item, repoRoot);
  const effectiveOverrides = overrides ?? {};
  if (baseConfig) {
    const expectedLocal = deepMerge(baseConfig, effectiveOverrides) as Record<string, unknown>;
    if (isDeepEqual(localConfig, expectedLocal)) {
      return;
    }
  }
  const stripped = stripOverrides(localConfig, effectiveOverrides, baseConfig);
  const stat = await fs.stat(item.localPath);
  await fs.mkdir(path.dirname(item.repoPath), { recursive: true });
  await writeJsonFile(item.repoPath, stripped, {
    jsonc: item.localPath.endsWith('.jsonc'),
    mode: stat.mode & 0o777,
  });
}

async function readRepoConfig(
  item: SyncItem,
  repoRoot: string
): Promise<Record<string, unknown> | null> {
  if (!item.repoPath.startsWith(repoRoot)) {
    return null;
  }
  if (!(await pathExists(item.repoPath))) {
    return null;
  }
  const content = await fs.readFile(item.repoPath, 'utf8');
  return parseJsonc<Record<string, unknown>>(content);
}

async function applyOverridesToLocalConfig(
  plan: SyncPlan,
  overrides: Record<string, unknown>
): Promise<void> {
  const configFiles = plan.items.filter((item) => item.isConfigFile);
  for (const item of configFiles) {
    if (!(await pathExists(item.localPath))) continue;

    const content = await fs.readFile(item.localPath, 'utf8');
    const parsed = parseJsonc<Record<string, unknown>>(content);
    const merged = deepMerge(parsed, overrides) as Record<string, unknown>;
    const stat = await fs.stat(item.localPath);
    await writeJsonFile(item.localPath, merged, {
      jsonc: item.localPath.endsWith('.jsonc'),
      mode: stat.mode & 0o777,
    });
  }
}

async function copyFileWithMode(sourcePath: string, destinationPath: string): Promise<void> {
  const stat = await fs.stat(sourcePath);
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.copyFile(sourcePath, destinationPath);
  await chmodIfExists(destinationPath, stat.mode & 0o777);
}

async function copySessionDbBundle(
  sourceDbPath: string,
  destinationDbPath: string,
  removeWhenMissing: boolean
): Promise<void> {
  if (!(await pathExists(sourceDbPath))) {
    if (removeWhenMissing) {
      await removePath(destinationDbPath);
      await removeSessionDbSidecars(destinationDbPath);
    }
    return;
  }

  await copyFileWithMode(sourceDbPath, destinationDbPath);

  for (const suffix of SESSION_DB_SIDECAR_SUFFIXES) {
    const sourceSidecarPath = `${sourceDbPath}${suffix}`;
    const destinationSidecarPath = `${destinationDbPath}${suffix}`;
    if (await pathExists(sourceSidecarPath)) {
      await copyFileWithMode(sourceSidecarPath, destinationSidecarPath);
      continue;
    }
    await removePath(destinationSidecarPath);
  }
}

async function removeSessionDbSidecars(dbPath: string): Promise<void> {
  for (const suffix of SESSION_DB_SIDECAR_SUFFIXES) {
    await removePath(`${dbPath}${suffix}`);
  }
}

async function copyDirRecursive(sourcePath: string, destinationPath: string): Promise<void> {
  const stat = await fs.stat(sourcePath);
  await fs.mkdir(destinationPath, { recursive: true });
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });

  for (const entry of entries) {
    const entrySource = path.join(sourcePath, entry.name);
    const entryDest = path.join(destinationPath, entry.name);

    if (entry.isDirectory()) {
      await copyDirRecursive(entrySource, entryDest);
      continue;
    }

    if (entry.isFile()) {
      await copyFileWithMode(entrySource, entryDest);
    }
  }

  await chmodIfExists(destinationPath, stat.mode & 0o777);
}

async function removePath(targetPath: string): Promise<void> {
  await fs.rm(targetPath, { recursive: true, force: true });
}

async function applyExtraPaths(plan: SyncPlan, extra: ExtraPathPlan): Promise<void> {
  const allowlist = extra.allowlist;
  if (allowlist.length === 0) return;

  if (!(await pathExists(extra.manifestPath))) return;

  const manifestContent = await fs.readFile(extra.manifestPath, 'utf8');
  const manifest = parseJsonc<ExtraPathManifest>(manifestContent);

  for (const entry of manifest.entries) {
    const normalized = normalizePath(entry.sourcePath, plan.homeDir, plan.platform);
    const isAllowed = allowlist.includes(normalized);
    if (!isAllowed) continue;

    const repoPath = path.isAbsolute(entry.repoPath)
      ? entry.repoPath
      : path.join(plan.repoRoot, entry.repoPath);
    const localPath = entry.sourcePath;
    const entryType: ExtraPathType = entry.type ?? 'file';

    if (!(await pathExists(repoPath))) continue;

    await copyItem(repoPath, localPath, entryType);
    await applyExtraPathModes(localPath, entry);
  }
}

async function writeExtraPathManifest(plan: SyncPlan, extra: ExtraPathPlan): Promise<void> {
  const allowlist = extra.allowlist;
  const extraDir = path.join(path.dirname(extra.manifestPath), 'extra');
  if (allowlist.length === 0) {
    await removePath(extra.manifestPath);
    await removePath(extraDir);
    return;
  }

  await removePath(extraDir);

  const entries: ExtraPathManifestEntry[] = [];

  for (const entry of extra.entries) {
    const sourcePath = entry.sourcePath;
    if (!(await pathExists(sourcePath))) {
      continue;
    }
    const stat = await fs.stat(sourcePath);
    if (stat.isDirectory()) {
      await copyDirRecursive(sourcePath, entry.repoPath);
      const items = await collectExtraPathItems(sourcePath, sourcePath);
      entries.push({
        sourcePath,
        repoPath: path.relative(plan.repoRoot, entry.repoPath),
        type: 'dir',
        mode: stat.mode & 0o777,
        items,
      });
      continue;
    }
    if (stat.isFile()) {
      await copyFileWithMode(sourcePath, entry.repoPath);
      entries.push({
        sourcePath,
        repoPath: path.relative(plan.repoRoot, entry.repoPath),
        type: 'file',
        mode: stat.mode & 0o777,
      });
    }
  }

  await fs.mkdir(path.dirname(extra.manifestPath), { recursive: true });
  await writeJsonFile(extra.manifestPath, { entries }, { jsonc: false });
}

async function collectExtraPathItems(
  sourcePath: string,
  basePath: string
): Promise<ExtraPathManifestItem[]> {
  const items: ExtraPathManifestItem[] = [];
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });

  for (const entry of entries) {
    const entrySource = path.join(sourcePath, entry.name);
    const relativePath = path.relative(basePath, entrySource);

    if (entry.isDirectory()) {
      const stat = await fs.stat(entrySource);
      items.push({
        relativePath,
        type: 'dir',
        mode: stat.mode & 0o777,
      });
      const nested = await collectExtraPathItems(entrySource, basePath);
      items.push(...nested);
      continue;
    }

    if (entry.isFile()) {
      const stat = await fs.stat(entrySource);
      items.push({
        relativePath,
        type: 'file',
        mode: stat.mode & 0o777,
      });
    }
  }

  return items;
}

async function applyExtraPathModes(
  targetPath: string,
  entry: ExtraPathManifestEntry
): Promise<void> {
  if (entry.mode !== undefined) {
    await chmodIfExists(targetPath, entry.mode);
  }

  if (entry.type !== 'dir') {
    return;
  }

  if (!entry.items || entry.items.length === 0) {
    return;
  }

  for (const item of entry.items) {
    if (item.mode === undefined) continue;
    const itemPath = resolveExtraPathItem(targetPath, item.relativePath);
    if (!itemPath) continue;
    await chmodIfExists(itemPath, item.mode);
  }
}

function resolveExtraPathItem(basePath: string, relativePath: string): string | null {
  if (!relativePath) return null;
  if (path.isAbsolute(relativePath)) return null;

  const resolvedBase = path.resolve(basePath);
  const resolvedPath = path.resolve(basePath, relativePath);
  const relative = path.relative(resolvedBase, resolvedPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
    return null;
  }
  if (path.isAbsolute(relative)) {
    return null;
  }

  return resolvedPath;
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (!left || !right) return false;

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) {
      if (!isDeepEqual(left[i], right[i])) return false;
    }
    return true;
  }

  if (typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left as Record<string, unknown>);
    const rightKeys = Object.keys(right as Record<string, unknown>);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
      if (!hasOwn(right as Record<string, unknown>, key)) return false;
      if (
        !isDeepEqual(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key]
        )
      ) {
        return false;
      }
    }
    return true;
  }

  return false;
}
