import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';

import { syncLocalToRepo } from './apply.js';
import type { NormalizedSyncConfig } from './config.js';
import { canCommitMcpSecrets } from './config.js';
import { buildSyncPlan, type SyncLocations } from './paths.js';
import { getStatusLines } from './repo.js';

type Shell = PluginInput['$'];

/** Repo paths the preview reports on. Secrets and session data are never compared or printed. */
const PREVIEW_ROOTS = ['config/', 'state/'] as const;
const MAX_LISTED_CHANGES = 15;

const ACTION_BY_CODE: Record<string, string> = {
  M: 'update',
  A: 'add',
  '??': 'add',
  D: 'delete',
  R: 'rename',
  C: 'add',
  T: 'update',
};

/**
 * Lists what a push would change, without touching the real sync repo, the real config or the
 * overrides file. The local config is staged into a throwaway sparse clone with the same code a
 * real push uses, and the clone's `git status` is reported. Only paths are returned, never content.
 *
 * Session and secret items are not compared. Returns null when the preview cannot be computed.
 */
export async function previewLocalChanges(
  $: Shell,
  config: NormalizedSyncConfig,
  locations: SyncLocations,
  repoRoot: string,
  overrides: Record<string, unknown> | null
): Promise<string[] | null> {
  let scratchRoot: string | null = null;
  try {
    scratchRoot = await fs.mkdtemp(path.join(tmpdir(), 'opencode-synced-preview-'));
    const cloneRoot = path.join(scratchRoot, 'repo');
    await $`git clone --quiet --local --no-checkout ${repoRoot} ${cloneRoot}`.quiet();
    try {
      await $`git -C ${cloneRoot} sparse-checkout set --no-cone /config /state`.quiet();
    } catch {
      // Older Git without sparse-checkout: fall back to a full checkout.
    }
    const head = (await $`git -C ${repoRoot} rev-parse HEAD`.quiet().text()).trim();
    await $`git -C ${cloneRoot} checkout --quiet --detach ${head}`.quiet();

    const plan = buildSyncPlan(config, locations, cloneRoot);
    await syncLocalToRepo(
      {
        ...plan,
        items: plan.items.filter(
          (item) => !item.isSecret && !item.chunkLargeFiles && !item.preserveWhenMissing
        ),
        extraSecrets: { ...plan.extraSecrets, allowlist: [], entries: [] },
      },
      overrides,
      { allowMcpSecrets: canCommitMcpSecrets(config) }
    );

    const changes = await getStatusLines($, cloneRoot);
    return changes.filter((line) =>
      PREVIEW_ROOTS.some((root) => changePath(line).startsWith(root))
    );
  } catch {
    return null;
  } finally {
    if (scratchRoot) {
      await fs.rm(scratchRoot, { recursive: true, force: true });
    }
  }
}

function changePath(line: string): string {
  const match = /^\S+\s+(.*)$/u.exec(line);
  const rest = match?.[1] ?? line;
  const renamed = rest.split(' -> ');
  return (renamed[renamed.length - 1] ?? rest).replace(/^"|"$/gu, '');
}

function changeAction(line: string): string {
  const code = /^(\S+)/u.exec(line)?.[1] ?? '';
  return ACTION_BY_CODE[code] ?? ACTION_BY_CODE[code.charAt(0)] ?? 'update';
}

/**
 * Turns `git status --porcelain` or `git diff --name-status` lines into a short summary, for
 * example `3 files: 2 updated, 1 added` followed by one `action path` line per file.
 */
export function summarizeChanges(lines: string[], limit = MAX_LISTED_CHANGES): string[] {
  const entries = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ action: changeAction(line), path: changePath(line) }));
  if (entries.length === 0) return [];

  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.action, (counts.get(entry.action) ?? 0) + 1);
  }
  const past: Record<string, string> = {
    update: 'updated',
    add: 'added',
    delete: 'deleted',
    rename: 'renamed',
  };
  const breakdown = [...counts.entries()]
    .map(([action, count]) => `${count} ${past[action] ?? action}`)
    .join(', ');

  const noun = entries.length === 1 ? 'file' : 'files';
  const summary = [`${entries.length} ${noun}: ${breakdown}`];
  for (const entry of entries.slice(0, limit)) {
    summary.push(`  ${entry.action} ${entry.path}`);
  }
  if (entries.length > limit) {
    summary.push(`  ... and ${entries.length - limit} more`);
  }
  return summary;
}
