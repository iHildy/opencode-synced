import crypto from 'node:crypto';
import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import {
  type ChunkOptions,
  cleanupUnreferencedChunkStores,
  copySessionFileFromRepo,
  copySessionFileToRepo,
} from './chunks.js';
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
  overrides: Record<string, unknown> | null,
  options: { chunkOptions?: ChunkOptions } = {}
): Promise<void> {
  for (const item of plan.items) {
    if (item.chunkLargeFiles) {
      await copyChunkableItemFromRepo(item, plan.repoRoot, options.chunkOptions);
      continue;
    }
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
  options: {
    overridesPath?: string;
    allowMcpSecrets?: boolean;
    chunkOptions?: ChunkOptions;
  } = {}
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

    if (item.chunkLargeFiles) {
      await copyChunkableItemToRepo(item, plan.repoRoot, options.chunkOptions);
      continue;
    }

    await copyItem(item.localPath, item.repoPath, item.type, !item.preserveWhenMissing);
  }

  await writeExtraPathManifest(plan, plan.extraConfigs);
  await writeExtraPathManifest(plan, plan.extraSecrets);
  await cleanupUnreferencedChunkStores(plan.repoRoot);
}

async function copyChunkableItemToRepo(
  item: SyncItem,
  repoRoot: string,
  options: ChunkOptions = {}
): Promise<void> {
  if (!(await pathExists(item.localPath))) {
    if (!item.preserveWhenMissing) await removePath(item.repoPath);
    return;
  }

  if (item.type === 'file') {
    await copyChunkableDbBundleToRepo(item.localPath, item.repoPath, repoRoot, options);
    return;
  }

  const tempPath = `${item.repoPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await copyChunkableDirectoryToRepo(item.localPath, tempPath, item.repoPath, repoRoot, options);
    await replaceDirectory(tempPath, item.repoPath);
  } catch (error) {
    await removePath(tempPath);
    throw error;
  }
}

async function copyChunkableItemFromRepo(
  item: SyncItem,
  repoRoot: string,
  options: ChunkOptions = {}
): Promise<void> {
  if (!(await pathExists(item.repoPath))) return;

  if (item.type === 'file') {
    await copyChunkableDbBundleFromRepo(item.repoPath, item.localPath, repoRoot, options);
    return;
  }

  const tempPath = `${item.localPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await copyChunkableDirectoryFromRepo(item.repoPath, tempPath, repoRoot, options);
    await replaceDirectory(tempPath, item.localPath);
  } catch (error) {
    await removePath(tempPath);
    throw error;
  }
}

async function copyChunkableDbBundleToRepo(
  sourceDbPath: string,
  repoDbPath: string,
  repoRoot: string,
  options: ChunkOptions
): Promise<void> {
  const stageDir = path.join(
    path.dirname(repoDbPath),
    `.db-bundle-${process.pid}-${crypto.randomUUID()}`
  );
  const destinations = [
    repoDbPath,
    ...SESSION_DB_SIDECAR_SUFFIXES.map((suffix) => `${repoDbPath}${suffix}`),
  ];
  try {
    await fs.mkdir(stageDir, { recursive: true, mode: 0o700 });
    await copySessionFileToRepo(
      sourceDbPath,
      path.join(stageDir, path.basename(repoDbPath)),
      repoRoot,
      options,
      repoDbPath
    );
    for (const suffix of SESSION_DB_SIDECAR_SUFFIXES) {
      const sourcePath = `${sourceDbPath}${suffix}`;
      if (!(await pathExists(sourcePath))) continue;
      await copySessionFileToRepo(
        sourcePath,
        path.join(stageDir, `${path.basename(repoDbPath)}${suffix}`),
        repoRoot,
        options,
        `${repoDbPath}${suffix}`
      );
    }
    await replaceFileBundle(stageDir, destinations);
  } catch (error) {
    await removePath(stageDir);
    throw error;
  }
}

async function copyChunkableDbBundleFromRepo(
  repoDbPath: string,
  destinationDbPath: string,
  repoRoot: string,
  options: ChunkOptions
): Promise<void> {
  const stageDir = path.join(
    path.dirname(destinationDbPath),
    `.db-bundle-${process.pid}-${crypto.randomUUID()}`
  );
  const destinations = [
    destinationDbPath,
    ...SESSION_DB_SIDECAR_SUFFIXES.map((suffix) => `${destinationDbPath}${suffix}`),
  ];
  try {
    await fs.mkdir(stageDir, { recursive: true, mode: 0o700 });
    await copySessionFileFromRepo(
      repoDbPath,
      path.join(stageDir, path.basename(destinationDbPath)),
      repoRoot,
      options
    );
    for (const suffix of SESSION_DB_SIDECAR_SUFFIXES) {
      const sourcePath = `${repoDbPath}${suffix}`;
      if (!(await pathExists(sourcePath))) continue;
      await copySessionFileFromRepo(
        sourcePath,
        path.join(stageDir, `${path.basename(destinationDbPath)}${suffix}`),
        repoRoot,
        options
      );
    }
    await replaceFileBundle(stageDir, destinations);
  } catch (error) {
    await removePath(stageDir);
    throw error;
  }
}

async function replaceFileBundle(stageDir: string, destinations: string[]): Promise<void> {
  const backupDir = `${stageDir}.backup`;
  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
  const movedDestinations: string[] = [];
  try {
    for (const destination of destinations) {
      if (!(await pathExists(destination))) continue;
      await fs.rename(destination, path.join(backupDir, path.basename(destination)));
    }

    const stagedEntries = await fs.readdir(stageDir, { withFileTypes: true });
    for (const entry of stagedEntries) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`Invalid staged database bundle entry: ${entry.name}`);
      }
      const destination = destinations.find((candidate) => path.basename(candidate) === entry.name);
      if (!destination) throw new Error(`Unexpected staged database bundle entry: ${entry.name}`);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rename(path.join(stageDir, entry.name), destination);
      movedDestinations.push(destination);
    }
  } catch (error) {
    for (const destination of movedDestinations) await removePath(destination);
    const backups = await fs.readdir(backupDir).catch(() => []);
    for (const name of backups) {
      const destination = destinations.find((candidate) => path.basename(candidate) === name);
      if (destination) await fs.rename(path.join(backupDir, name), destination);
    }
    await removePath(backupDir);
    throw error;
  }
  await removePath(stageDir).catch(() => undefined);
  await removePath(backupDir).catch(() => undefined);
}

async function copyChunkableDirectoryToRepo(
  sourcePath: string,
  destinationPath: string,
  logicalRepoPath: string,
  repoRoot: string,
  options: ChunkOptions
): Promise<void> {
  const stat = await assertDirectory(sourcePath, 'session source directory');
  await fs.mkdir(destinationPath, { recursive: true, mode: stat.mode & 0o777 });
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });
  const entryNames = entries.map((entry) => entry.name).sort();

  for (const entry of entries) {
    const entrySource = path.join(sourcePath, entry.name);
    const entryDestination = path.join(destinationPath, entry.name);
    const entryLogicalPath = path.join(logicalRepoPath, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Session source contains a symlink: ${entrySource}`);
    if (entry.isDirectory()) {
      await copyChunkableDirectoryToRepo(
        entrySource,
        entryDestination,
        entryLogicalPath,
        repoRoot,
        options
      );
      continue;
    }
    if (!entry.isFile())
      throw new Error(`Session source contains an unsupported entry: ${entrySource}`);
    await copySessionFileToRepo(entrySource, entryDestination, repoRoot, options, entryLogicalPath);
  }
  await assertDirectoryUnchanged(sourcePath, stat, entryNames);
  await chmodIfExists(destinationPath, stat.mode & 0o777);
}

async function copyChunkableDirectoryFromRepo(
  sourcePath: string,
  destinationPath: string,
  repoRoot: string,
  options: ChunkOptions
): Promise<void> {
  const stat = await assertDirectory(sourcePath, 'repository session directory');
  await fs.mkdir(destinationPath, { recursive: true, mode: stat.mode & 0o777 });
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });
  const entryNames = entries.map((entry) => entry.name).sort();

  for (const entry of entries) {
    const entrySource = path.join(sourcePath, entry.name);
    const entryDestination = path.join(destinationPath, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Repository session contains a symlink: ${entrySource}`);
    if (entry.isDirectory()) {
      await copyChunkableDirectoryFromRepo(entrySource, entryDestination, repoRoot, options);
      continue;
    }
    if (!entry.isFile())
      throw new Error(`Repository session has an unsupported entry: ${entrySource}`);
    await copySessionFileFromRepo(entrySource, entryDestination, repoRoot, options);
  }
  await assertDirectoryUnchanged(sourcePath, stat, entryNames);
  await chmodIfExists(destinationPath, stat.mode & 0o777);
}

async function replaceDirectory(sourcePath: string, destinationPath: string): Promise<void> {
  const backupPath = `${destinationPath}.backup-${process.pid}-${crypto.randomUUID()}`;
  const hadDestination = await pathExists(destinationPath);
  if (hadDestination) await fs.rename(destinationPath, backupPath);
  try {
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.rename(sourcePath, destinationPath);
    if (hadDestination) await removePath(backupPath);
  } catch (error) {
    if (hadDestination && !(await pathExists(destinationPath))) {
      await fs.rename(backupPath, destinationPath);
    }
    throw error;
  }
}

async function assertDirectory(directoryPath: string, label: string): Promise<Stats> {
  const stat = await fs.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular directory: ${directoryPath}`);
  }
  return stat;
}

async function assertDirectoryUnchanged(
  directoryPath: string,
  initialStat: Stats,
  initialNames: string[]
): Promise<void> {
  const finalStat = await assertDirectory(directoryPath, 'session directory');
  const finalNames = (await fs.readdir(directoryPath)).sort();
  if (
    finalStat.mtimeMs !== initialStat.mtimeMs ||
    finalStat.ctimeMs !== initialStat.ctimeMs ||
    finalStat.dev !== initialStat.dev ||
    finalStat.ino !== initialStat.ino ||
    finalNames.length !== initialNames.length ||
    finalNames.some((name, index) => name !== initialNames[index])
  ) {
    throw new Error(`Session directory changed while it was being copied: ${directoryPath}`);
  }
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
