import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { syncLocalToRepo, syncRepoToLocal } from './apply.js';
import { parseJsonc } from './config.js';
import type { SyncItem, SyncPlan } from './paths.js';

export interface LocalProjection {
  plan: SyncPlan;
  changedItemIndexes: number[];
}

export async function createLocalProjection(
  plan: SyncPlan,
  overrides: Record<string, unknown> | null,
  projectionRoot: string,
  options: { overridesPath?: string } = {}
): Promise<LocalProjection> {
  await fs.rm(projectionRoot, { recursive: true, force: true });
  await fs.mkdir(projectionRoot, { recursive: true, mode: 0o700 });
  const projectionPlan = remapRepoRoot(plan, projectionRoot);
  await seedProjectionFromRepo(plan, projectionPlan);
  await syncLocalToRepo(projectionPlan, overrides, {
    overridesPath: options.overridesPath,
    allowMcpSecrets: false,
  });

  const changedItemIndexes: number[] = [];
  for (let index = 0; index < plan.items.length; index += 1) {
    const localDigest = await digestManagedItem(
      projectionPlan.items[index],
      projectionPlan.items[index].repoPath
    );
    const baseDigest = await digestManagedItem(plan.items[index], plan.items[index].repoPath);
    if (localDigest !== baseDigest) changedItemIndexes.push(index);
  }

  return { plan: projectionPlan, changedItemIndexes };
}

async function seedProjectionFromRepo(
  sourcePlan: SyncPlan,
  projectionPlan: SyncPlan
): Promise<void> {
  const seedItems = sourcePlan.items.map(
    (item, index): SyncItem => ({
      ...item,
      localPath: projectionPlan.items[index].repoPath,
      isConfigFile: false,
      strategy: 'copy',
    })
  );
  await syncRepoToLocal(
    {
      ...sourcePlan,
      homeDir: projectionPlan.repoRoot,
      localRoots: [projectionPlan.repoRoot],
      items: seedItems,
    },
    null
  );
}

export async function applyLocalProjection(
  targetPlan: SyncPlan,
  projection: LocalProjection,
  rollbackRoot: string
): Promise<void> {
  await fs.rm(rollbackRoot, { recursive: true, force: true });
  await fs.mkdir(rollbackRoot, { recursive: true, mode: 0o700 });

  const replacements: Array<{ index: number; targetItem: SyncItem; projectedItem: SyncItem }> = [];
  for (const index of projection.changedItemIndexes) {
    const targetItem = targetPlan.items[index];
    const projectedItem = projection.plan.items[index];
    if (!targetItem || !projectedItem) throw new Error(`Invalid projected item index: ${index}`);
    const relativePath = relativeRepoPath(targetPlan.repoRoot, targetItem.repoPath);
    const rollbackPath = path.join(rollbackRoot, relativePath);

    await backupRepoItem(targetPlan, targetItem, rollbackRoot, rollbackPath);
    replacements.push({ index, targetItem, projectedItem });
  }

  const applied: typeof replacements = [];
  try {
    for (const replacement of replacements) {
      await replaceRepoItem(
        targetPlan,
        projection.plan,
        replacement.targetItem,
        replacement.projectedItem
      );
      applied.push(replacement);
    }
  } catch (error) {
    const rollbackPlan = remapRepoRoot(targetPlan, rollbackRoot);
    const restoreErrors: unknown[] = [];
    for (const replacement of applied.reverse()) {
      try {
        await replaceRepoItem(
          targetPlan,
          rollbackPlan,
          replacement.targetItem,
          rollbackPlan.items[replacement.index]
        );
      } catch (restoreError) {
        restoreErrors.push(restoreError);
      }
    }
    await makePrivateRecursive(rollbackRoot);
    if (restoreErrors.length > 0) {
      throw new AggregateError(
        [error, ...restoreErrors],
        `Projection failed and rollback data was retained at ${rollbackRoot}`
      );
    }
    throw error;
  }

  await makePrivateRecursive(rollbackRoot);
}

function remapRepoRoot(plan: SyncPlan, nextRepoRoot: string): SyncPlan {
  const remapItem = (item: SyncItem): SyncItem => ({
    ...item,
    repoPath: path.join(nextRepoRoot, relativeRepoPath(plan.repoRoot, item.repoPath)),
  });
  return {
    ...plan,
    repoRoot: nextRepoRoot,
    items: plan.items.map(remapItem),
  };
}

async function backupRepoItem(
  plan: SyncPlan,
  item: SyncItem,
  rollbackRoot: string,
  rollbackPath: string
): Promise<void> {
  const rawItem: SyncItem = {
    ...item,
    localPath: rollbackPath,
    isConfigFile: false,
    strategy: 'copy',
  };
  await syncRepoToLocal(
    {
      ...plan,
      homeDir: rollbackRoot,
      localRoots: [rollbackRoot],
      items: [rawItem],
    },
    null
  );
}

async function replaceRepoItem(
  targetPlan: SyncPlan,
  projectionPlan: SyncPlan,
  targetItem: SyncItem,
  projectedItem: SyncItem
): Promise<void> {
  const rawItem: SyncItem = {
    ...targetItem,
    localPath: projectedItem.repoPath,
    isConfigFile: false,
    strategy: 'copy',
  };
  await syncLocalToRepo(
    {
      ...targetPlan,
      homeDir: projectionPlan.repoRoot,
      localRoots: [projectionPlan.repoRoot],
      items: [rawItem],
    },
    null
  );
}

function relativeRepoPath(repoRoot: string, itemPath: string): string {
  const relative = path.relative(path.resolve(repoRoot), path.resolve(itemPath));
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Managed item is outside repository root: ${itemPath}`);
  }
  return relative;
}

async function digestPath(targetPath: string): Promise<string> {
  const stat = await lstatOrNull(targetPath);
  if (!stat) return 'missing';
  if (stat.isSymbolicLink()) throw new Error(`Refusing to digest symlink: ${targetPath}`);
  const hash = createHash('sha256');
  if (stat.isFile()) {
    hash.update('file\0');
    hash.update(stat.mode & 0o111 ? 'executable\0' : 'regular\0');
    hash.update(await fs.readFile(targetPath));
    return hash.digest('hex');
  }
  if (!stat.isDirectory()) throw new Error(`Unsupported managed path type: ${targetPath}`);
  hash.update('dir\0');
  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    hash.update(entry.name);
    hash.update('\0');
    hash.update(await digestPath(path.join(targetPath, entry.name)));
  }
  return hash.digest('hex');
}

async function digestManagedItem(item: SyncItem, targetPath: string): Promise<string> {
  const stat = await lstatOrNull(targetPath);
  if (!stat) return 'missing';
  if (stat.isSymbolicLink()) throw new Error(`Refusing to digest symlink: ${targetPath}`);
  if (item.isConfigFile || item.strategy === 'model-favorites') {
    if (!stat.isFile()) throw new Error(`Expected JSON file: ${targetPath}`);
    const parsed = parseJsonc<unknown>(await fs.readFile(targetPath, 'utf8'));
    return createHash('sha256').update(stableJson(parsed)).digest('hex');
  }
  return digestPath(targetPath);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right)
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function makePrivateRecursive(targetPath: string): Promise<void> {
  const stat = await lstatOrNull(targetPath);
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new Error(`Refusing to chmod symlink: ${targetPath}`);
  if (stat.isFile()) {
    await fs.chmod(targetPath, 0o600);
    return;
  }
  if (!stat.isDirectory()) throw new Error(`Unsupported rollback path type: ${targetPath}`);
  await fs.chmod(targetPath, 0o700);
  for (const entry of await fs.readdir(targetPath)) {
    await makePrivateRecursive(path.join(targetPath, entry));
  }
}

async function lstatOrNull(targetPath: string) {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    const maybeErrno = error as NodeJS.ErrnoException;
    if (maybeErrno.code === 'ENOENT') return null;
    throw error;
  }
}
