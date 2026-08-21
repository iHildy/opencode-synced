import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
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
  assertNoLiteralSecrets,
  extractMcpSecrets,
  hasOverrides,
  mergeOverrides,
  stripOverrideKeys,
} from './mcp-secrets.js';
import type { SyncItem, SyncPlan } from './paths.js';

export async function syncRepoToLocal(
  plan: SyncPlan,
  overrides: Record<string, unknown> | null
): Promise<void> {
  const rollbackRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-synced-apply-'));
  await fs.chmod(rollbackRoot, 0o700);
  let retainRollback = false;
  try {
    await backupLocalItems(plan, rollbackRoot);
    try {
      await applyRepoToLocal(plan, overrides);
    } catch (error) {
      const restoreErrors = await restoreLocalItems(plan, rollbackRoot);
      if (restoreErrors.length > 0) {
        retainRollback = true;
        throw new AggregateError(
          [error, ...restoreErrors],
          `Remote apply failed and rollback data was retained at ${rollbackRoot}`
        );
      }
      throw error;
    }
  } finally {
    if (!retainRollback) await fs.rm(rollbackRoot, { recursive: true, force: true });
  }
}

async function applyRepoToLocal(
  plan: SyncPlan,
  overrides: Record<string, unknown> | null
): Promise<void> {
  for (const item of plan.items) {
    assertPathInside(plan.repoRoot, item.repoPath);
    const localRoot = findAllowedLocalRoot(plan, item.localPath);
    await assertSafeDestination(localRoot, item.localPath);
    if (item.isConfigFile) {
      await validateRemoteConfig(item.repoPath);
    }
    if (item.strategy === 'model-favorites') {
      await applyModelFavorites(item, localRoot);
      continue;
    }
    await copyItem(item.repoPath, item.localPath, item.type, true, {
      sourceRoot: plan.repoRoot,
      destinationRoot: localRoot,
      strategy: item.strategy,
    });
  }

  if (overrides && Object.keys(overrides).length > 0) {
    await applyOverridesToLocalConfig(plan, overrides);
  }
}

async function validateRemoteConfig(configPath: string): Promise<void> {
  const stat = await lstatOrNull(configPath);
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new Error(`Refusing to read symlink: ${configPath}`);
  if (!stat.isFile()) throw new Error(`Expected regular file: ${configPath}`);
  const parsed = parseJsonc<Record<string, unknown>>(await fs.readFile(configPath, 'utf8'));
  assertNoLiteralSecrets(parsed);
}

async function backupLocalItems(plan: SyncPlan, rollbackRoot: string): Promise<void> {
  for (let index = 0; index < plan.items.length; index += 1) {
    const item = plan.items[index];
    const localRoot = findAllowedLocalRoot(plan, item.localPath);
    const rollbackPath = localRollbackPath(rollbackRoot, item, index);
    await copyItem(item.localPath, rollbackPath, item.type, true, {
      sourceRoot: localRoot,
      destinationRoot: rollbackRoot,
      strategy: 'copy',
    });
  }
}

async function restoreLocalItems(plan: SyncPlan, rollbackRoot: string): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (let index = plan.items.length - 1; index >= 0; index -= 1) {
    const item = plan.items[index];
    const localRoot = findAllowedLocalRoot(plan, item.localPath);
    const rollbackPath = localRollbackPath(rollbackRoot, item, index);
    try {
      await copyItem(rollbackPath, item.localPath, item.type, true, {
        sourceRoot: rollbackRoot,
        destinationRoot: localRoot,
        strategy: 'copy',
      });
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function localRollbackPath(rollbackRoot: string, item: SyncItem, index: number): string {
  return path.join(rollbackRoot, String(index), path.basename(item.localPath) || 'item');
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
    assertNoLiteralSecrets(sanitizedConfig);
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
        const overridesParent = path.dirname(options.overridesPath);
        await fs.mkdir(overridesParent, { recursive: true, mode: 0o700 });
        await fs.chmod(overridesParent, 0o700);
        await writeJsonFile(options.overridesPath, mergedOverrides, { jsonc: true, mode: 0o600 });
      }
    }
    overridesForStrip = overrides ? stripOverrideKeys(overrides, secretOverrides) : overrides;
  }

  for (const item of plan.items) {
    assertPathInside(plan.repoRoot, item.repoPath);
    const localRoot = findAllowedLocalRoot(plan, item.localPath);
    await assertSafeDestination(localRoot, item.localPath);
    if (item.isConfigFile) {
      const sanitized = sanitizedConfigs.get(item.localPath);
      await copyConfigForRepo(item, overridesForStrip, plan.repoRoot, sanitized);
      continue;
    }

    if (item.strategy === 'model-favorites') {
      await writeModelFavorites(item, plan);
      continue;
    }

    await copyItem(item.localPath, item.repoPath, item.type, true, {
      sourceRoot: localRoot,
      destinationRoot: plan.repoRoot,
      strategy: item.strategy,
    });
  }
}

async function copyItem(
  sourcePath: string,
  destinationPath: string,
  type: SyncItem['type'],
  removeWhenMissing = false,
  options: {
    sourceRoot?: string;
    destinationRoot?: string;
    strategy?: SyncItem['strategy'];
  } = {}
): Promise<void> {
  if (options.sourceRoot) assertPathInside(options.sourceRoot, sourcePath);
  if (options.destinationRoot) assertPathInside(options.destinationRoot, destinationPath);
  if (options.sourceRoot) await assertSafeDestination(options.sourceRoot, sourcePath);
  if (options.destinationRoot)
    await assertSafeDestination(options.destinationRoot, destinationPath);

  const sourceStat = await lstatOrNull(sourcePath);
  if (!sourceStat) {
    if (removeWhenMissing) {
      await removePath(destinationPath);
    }
    return;
  }

  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Refusing to copy symlink: ${sourcePath}`);
  }

  if (type === 'file') {
    if (!sourceStat.isFile()) {
      throw new Error(`Expected regular file: ${sourcePath}`);
    }
    if (options.strategy === 'prompt-snapshot') {
      await validatePromptSnapshot(sourcePath, sourceStat.size);
    }
    const isPrivateSnapshot = options.strategy === 'prompt-snapshot';
    await copyFileWithMode(
      sourcePath,
      destinationPath,
      options.destinationRoot,
      isPrivateSnapshot ? 0o600 : undefined,
      isPrivateSnapshot ? 0o700 : undefined
    );
    return;
  }

  if (!sourceStat.isDirectory()) {
    throw new Error(`Expected directory: ${sourcePath}`);
  }
  await replaceDirectoryAtomic(
    sourcePath,
    destinationPath,
    options.strategy === 'skills',
    options.destinationRoot
  );
}

async function copyConfigForRepo(
  item: SyncItem,
  overrides: Record<string, unknown> | null,
  repoRoot: string,
  configOverride?: Record<string, unknown>
): Promise<void> {
  await assertSafeDestination(repoRoot, item.repoPath);
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
  assertPathInside(repoRoot, item.repoPath);
  const stat = await safeRegularFileStat(item.localPath);
  await assertSafeDestination(repoRoot, item.repoPath);
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
  assertPathInside(repoRoot, item.repoPath);
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
    const stat = await safeRegularFileStat(item.localPath);
    await writeJsonFile(item.localPath, merged, {
      jsonc: item.localPath.endsWith('.jsonc'),
      mode: stat.mode & 0o777,
    });
  }
}

async function copyFileWithMode(
  sourcePath: string,
  destinationPath: string,
  destinationRoot?: string,
  modeOverride?: number,
  parentMode?: number
): Promise<void> {
  const stat = await safeRegularFileStat(sourcePath);
  if (destinationRoot) await assertSafeDestination(destinationRoot, destinationPath);
  const destinationParent = path.dirname(destinationPath);
  await fs.mkdir(destinationParent, { recursive: true, mode: parentMode });
  if (parentMode !== undefined) await fs.chmod(destinationParent, parentMode);
  const tempPath = `${destinationPath}.sync-tmp-${randomUUID()}`;
  try {
    await fs.copyFile(sourcePath, tempPath);
    await fs.chmod(tempPath, modeOverride ?? stat.mode & 0o777);
    await fs.rename(tempPath, destinationPath);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

async function copyDirRecursive(
  sourcePath: string,
  destinationPath: string,
  skillsOnly = false,
  relativeRoot = sourcePath
): Promise<void> {
  const stat = await fs.lstat(sourcePath);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to copy symlink: ${sourcePath}`);
  if (!stat.isDirectory()) throw new Error(`Expected directory: ${sourcePath}`);
  await fs.mkdir(destinationPath, { recursive: true });
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });

  for (const entry of entries) {
    const entrySource = path.join(sourcePath, entry.name);
    const entryDest = path.join(destinationPath, entry.name);
    const relativePath = path.relative(relativeRoot, entrySource);

    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to copy symlink: ${entrySource}`);
    }
    if (skillsOnly) {
      const skillPathPolicy = classifySkillPath(relativePath, entry.isDirectory());
      if (skillPathPolicy === 'ignore') continue;
      if (skillPathPolicy === 'reject') {
        throw new Error(`Refusing to sync sensitive skill path: ${relativePath}`);
      }
    }

    if (entry.isDirectory()) {
      await copyDirRecursive(entrySource, entryDest, skillsOnly, relativeRoot);
      continue;
    }

    if (entry.isFile()) {
      if (skillsOnly) await assertSkillFileContentSafe(entrySource, relativePath);
      await copyFileWithMode(entrySource, entryDest);
      continue;
    }
    throw new Error(`Refusing unsupported filesystem entry: ${entrySource}`);
  }

  await chmodIfExists(destinationPath, stat.mode & 0o777);
}

async function removePath(targetPath: string): Promise<void> {
  await fs.rm(targetPath, { recursive: true, force: true });
}

async function replaceDirectoryAtomic(
  sourcePath: string,
  destinationPath: string,
  skillsOnly: boolean,
  destinationRoot?: string
): Promise<void> {
  if (destinationRoot) await assertSafeDestination(destinationRoot, destinationPath);
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  const stagePath = `${destinationPath}.sync-tmp-${randomUUID()}`;
  const backupPath = `${destinationPath}.sync-backup-${randomUUID()}`;
  let hasBackup = false;

  try {
    await copyDirRecursive(sourcePath, stagePath, skillsOnly);
    const destinationStat = await lstatOrNull(destinationPath);
    if (destinationStat?.isSymbolicLink()) {
      throw new Error(`Refusing to replace symlink: ${destinationPath}`);
    }
    if (destinationStat) {
      if (!destinationStat.isDirectory()) throw new Error(`Expected directory: ${destinationPath}`);
      await fs.rename(destinationPath, backupPath);
      hasBackup = true;
    }
    await fs.rename(stagePath, destinationPath);
    if (hasBackup) {
      await fs.rm(backupPath, { recursive: true, force: true });
      hasBackup = false;
    }
  } catch (error) {
    const destinationExists = Boolean(await lstatOrNull(destinationPath));
    if (hasBackup && !destinationExists) {
      try {
        await fs.rename(backupPath, destinationPath);
        hasBackup = false;
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Directory replacement failed and backup was retained at ${backupPath}`
        );
      }
    }
    throw error;
  } finally {
    await fs.rm(stagePath, { recursive: true, force: true });
  }
}

async function writeModelFavorites(item: SyncItem, plan: SyncPlan): Promise<void> {
  await assertSafeDestination(plan.repoRoot, item.repoPath);
  const sourceStat = await lstatOrNull(item.localPath);
  if (!sourceStat) {
    await removePath(item.repoPath);
    return;
  }
  const stat = await safeRegularFileStat(item.localPath);
  const modelState = parseJsonc<Record<string, unknown>>(await fs.readFile(item.localPath, 'utf8'));
  const favorite = modelState.favorite;
  if (!Array.isArray(favorite)) throw new Error(`Invalid model favorites file: ${item.localPath}`);
  await assertSafeDestination(plan.repoRoot, item.repoPath);
  await fs.mkdir(path.dirname(item.repoPath), { recursive: true });
  await writeJsonFile(item.repoPath, { favorite }, { jsonc: false, mode: stat.mode & 0o777 });
}

async function applyModelFavorites(item: SyncItem, localRoot: string): Promise<void> {
  const remoteStat = await lstatOrNull(item.repoPath);
  if (!remoteStat) {
    const localStat = await lstatOrNull(item.localPath);
    if (!localStat) return;
    if (localStat.isSymbolicLink())
      throw new Error(`Refusing to replace symlink: ${item.localPath}`);
    if (!localStat.isFile()) throw new Error(`Expected regular file: ${item.localPath}`);
    const local = parseJsonc<Record<string, unknown>>(await fs.readFile(item.localPath, 'utf8'));
    await assertSafeDestination(localRoot, item.localPath);
    await writeJsonFile(
      item.localPath,
      { ...local, favorite: [] },
      { jsonc: false, mode: localStat.mode & 0o777 }
    );
    return;
  }
  if (remoteStat.isSymbolicLink()) throw new Error(`Refusing to read symlink: ${item.repoPath}`);
  if (!remoteStat.isFile()) throw new Error(`Expected regular file: ${item.repoPath}`);
  const remote = parseJsonc<Record<string, unknown>>(await fs.readFile(item.repoPath, 'utf8'));
  if (!Array.isArray(remote.favorite)) {
    throw new Error(`Invalid model favorites projection: ${item.repoPath}`);
  }

  const localStat = await lstatOrNull(item.localPath);
  if (localStat?.isSymbolicLink())
    throw new Error(`Refusing to replace symlink: ${item.localPath}`);
  const local = localStat
    ? parseJsonc<Record<string, unknown>>(await fs.readFile(item.localPath, 'utf8'))
    : {};
  await assertSafeDestination(localRoot, item.localPath);
  await fs.mkdir(path.dirname(item.localPath), { recursive: true });
  await writeJsonFile(
    item.localPath,
    { ...local, favorite: remote.favorite },
    { jsonc: false, mode: localStat ? localStat.mode & 0o777 : 0o600 }
  );
}

function classifySkillPath(
  relativePath: string,
  isDirectory: boolean
): 'include' | 'ignore' | 'reject' {
  const segments = relativePath.split(path.sep);
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const name = lowerSegments.at(-1) ?? '';
  const ignoredDirectories = new Set([
    '.cache',
    '.git',
    '.mypy_cache',
    '.pytest_cache',
    '.venv',
    '__pycache__',
    'build',
    'coverage',
    'dist',
    'node_modules',
    'target',
    'venv',
  ]);
  if (isDirectory && ignoredDirectories.has(name)) return 'ignore';
  if (name.endsWith('.pyc') || name.endsWith('.pyo')) return 'ignore';
  const normalizedMetadataName = name.replace(/[\uF03A\uFF1A]/g, ':');
  if (normalizedMetadataName.endsWith(':zone.identifier') || name === '.ds_store') return 'ignore';

  const sensitiveDirectories = new Set(['.gnupg', '.ssh', 'private', 'secrets']);
  if (lowerSegments.some((segment) => sensitiveDirectories.has(segment))) return 'reject';
  const sensitiveNames = new Set([
    '.netrc',
    '.npmrc',
    'auth.json',
    'credentials.json',
    'id_ed25519',
    'id_rsa',
    'token.json',
  ]);
  if (name === '.env' || name.startsWith('.env.')) return 'reject';
  if (sensitiveNames.has(name)) return 'reject';
  if (/\.(?:db|key|kdbx|p12|pem|pfx|sqlite|sqlite3)$/i.test(name)) return 'reject';
  return 'include';
}

async function assertSkillFileContentSafe(filePath: string, relativePath: string): Promise<void> {
  const stat = await safeRegularFileStat(filePath);
  const maxBytes = 16 * 1024 * 1024;
  if (stat.size > maxBytes) {
    throw new Error(`Refusing oversized skill file (${stat.size} bytes): ${relativePath}`);
  }
  const content = await fs.readFile(filePath);
  if (content.includes(0)) return;
  const text = content.toString('utf8');
  const secretPatterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /ghp_[A-Za-z0-9]{36,}/,
    /github_pat_[A-Za-z0-9_]{50,}/,
    /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/,
  ];
  if (secretPatterns.some((pattern) => pattern.test(text))) {
    throw new Error(`Refusing to sync secret-like skill content: ${relativePath}`);
  }
}

async function validatePromptSnapshot(filePath: string, size: number): Promise<void> {
  const maxBytes = 16 * 1024 * 1024;
  if (size > maxBytes) throw new Error(`Prompt snapshot exceeds ${maxBytes} bytes: ${filePath}`);
  const content = await fs.readFile(filePath, 'utf8');
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('not object');
    } catch {
      throw new Error(`Invalid prompt JSONL at ${filePath}:${index + 1}`);
    }
  }
}

function assertPathInside(rootPath: string, candidatePath: string): void {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  if (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  ) {
    return;
  }
  throw new Error(`Path is outside the allowed root: ${candidatePath}`);
}

function findAllowedLocalRoot(plan: SyncPlan, candidatePath: string): string {
  for (const root of plan.localRoots ?? [plan.homeDir]) {
    try {
      assertPathInside(root, candidatePath);
      return root;
    } catch {}
  }
  throw new Error(`Path is outside the allowed local roots: ${candidatePath}`);
}

export async function assertSafeDestination(
  rootPath: string,
  destinationPath: string
): Promise<void> {
  assertPathInside(rootPath, destinationPath);
  const root = path.resolve(rootPath);
  const rootStat = await lstatOrNull(root);
  if (rootStat?.isSymbolicLink()) throw new Error(`Refusing to traverse symlink: ${root}`);
  if (rootStat && !rootStat.isDirectory()) throw new Error(`Expected directory root: ${root}`);
  const relative = path.relative(root, path.resolve(destinationPath));
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new Error(`Refusing to traverse symlink: ${current}`);
  }
}

async function safeRegularFileStat(filePath: string) {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to copy symlink: ${filePath}`);
  if (!stat.isFile()) throw new Error(`Expected regular file: ${filePath}`);
  return stat;
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
