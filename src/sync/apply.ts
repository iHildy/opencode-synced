import { promises as fs } from 'node:fs';
import path from 'node:path';

import { deepMerge, parseJsonc, pathExists, stripOverrides, writeJsonFile } from './config.js';
import {
  extractMcpSecrets,
  hasOverrides,
  mergeOverrides,
  stripOverrideKeys,
} from './mcp-secrets.js';
import type { SyncItem, SyncPlan } from './paths.js';
import { normalizePath } from './paths.js';

interface ExtraSecretManifestEntry {
  sourcePath: string;
  repoPath: string;
  mode?: number;
}

interface ExtraSecretManifest {
  entries: ExtraSecretManifestEntry[];
}

export async function syncRepoToLocal(
  plan: SyncPlan,
  overrides: Record<string, unknown> | null
): Promise<void> {
  for (const item of plan.items) {
    await copyItem(item.repoPath, item.localPath, item.type);
  }

  await applyExtraSecrets(plan, true);

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
      await copyConfigForRepo(item, overridesForStrip, plan.repoRoot, sanitized);
      continue;
    }

    await copyItem(item.localPath, item.repoPath, item.type, true);
  }

  await writeExtraSecretsManifest(plan);
}

async function copyItem(
  sourcePath: string,
  destinationPath: string,
  type: SyncItem['type'],
  removeWhenMissing = false
): Promise<void> {
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
  configOverride?: Record<string, unknown>
): Promise<void> {
  if (!(await pathExists(item.localPath))) {
    await removePath(item.repoPath);
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
  await fs.chmod(destinationPath, stat.mode & 0o777);
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

  await fs.chmod(destinationPath, stat.mode & 0o777);
}

async function removePath(targetPath: string): Promise<void> {
  await fs.rm(targetPath, { recursive: true, force: true });
}

async function applyExtraSecrets(plan: SyncPlan, fromRepo: boolean): Promise<void> {
  const allowlist = plan.extraSecrets.allowlist;
  if (allowlist.length === 0) return;

  if (!(await pathExists(plan.extraSecrets.manifestPath))) return;

  const manifestContent = await fs.readFile(plan.extraSecrets.manifestPath, 'utf8');
  const manifest = parseJsonc<ExtraSecretManifest>(manifestContent);

  for (const entry of manifest.entries) {
    const normalized = normalizePath(entry.sourcePath, plan.homeDir, plan.platform);
    const isAllowed = allowlist.includes(normalized);
    if (!isAllowed) continue;

    const repoPath = path.isAbsolute(entry.repoPath)
      ? entry.repoPath
      : path.join(plan.repoRoot, entry.repoPath);
    const localPath = entry.sourcePath;

    if (!(await pathExists(repoPath))) continue;

    if (fromRepo) {
      await copyFileWithMode(repoPath, localPath);
      if (entry.mode !== undefined) {
        await fs.chmod(localPath, entry.mode);
      }
    }
  }
}

async function writeExtraSecretsManifest(plan: SyncPlan): Promise<void> {
  const allowlist = plan.extraSecrets.allowlist;
  const extraDir = path.join(path.dirname(plan.extraSecrets.manifestPath), 'extra');
  if (allowlist.length === 0) {
    await removePath(plan.extraSecrets.manifestPath);
    await removePath(extraDir);
    return;
  }

  await removePath(extraDir);

  const entries: ExtraSecretManifestEntry[] = [];

  for (const entry of plan.extraSecrets.entries) {
    const sourcePath = entry.sourcePath;
    if (!(await pathExists(sourcePath))) {
      continue;
    }
    const stat = await fs.stat(sourcePath);
    await copyFileWithMode(sourcePath, entry.repoPath);
    entries.push({
      sourcePath,
      repoPath: path.relative(plan.repoRoot, entry.repoPath),
      mode: stat.mode & 0o777,
    });
  }

  await fs.mkdir(path.dirname(plan.extraSecrets.manifestPath), { recursive: true });
  await writeJsonFile(plan.extraSecrets.manifestPath, { entries }, { jsonc: false });
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
      if (!Object.hasOwn(right, key)) return false;
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
