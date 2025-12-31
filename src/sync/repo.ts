import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';

import type { SyncConfig } from './config.ts';
import { pathExists } from './config.ts';
import {
  RepoDivergedError,
  RepoPrivateRequiredError,
  RepoVisibilityError,
  SyncCommandError,
} from './errors.ts';

export interface RepoStatus {
  branch: string;
  changes: string[];
}

export interface RepoUpdateResult {
  updated: boolean;
  branch: string;
}

type Shell = PluginInput['$'];

export async function isRepoCloned(repoDir: string): Promise<boolean> {
  const gitDir = path.join(repoDir, '.git');
  return pathExists(gitDir);
}

export function resolveRepoIdentifier(config: SyncConfig): string {
  const repo = config.repo;
  if (!repo) {
    throw new SyncCommandError('Missing repo configuration.');
  }

  if (repo.url) return repo.url;
  if (repo.owner && repo.name) return `${repo.owner}/${repo.name}`;

  throw new SyncCommandError('Repo configuration must include url or owner/name.');
}

export function resolveRepoBranch(config: SyncConfig, fallback = 'main'): string {
  const branch = config.repo?.branch;
  if (branch) return branch;
  return fallback;
}

export async function ensureRepoCloned(
  $: Shell,
  config: SyncConfig,
  repoDir: string
): Promise<void> {
  if (await isRepoCloned(repoDir)) {
    return;
  }

  await fs.mkdir(path.dirname(repoDir), { recursive: true });
  const repoIdentifier = resolveRepoIdentifier(config);

  try {
    await $`gh repo clone ${repoIdentifier} ${repoDir}`;
  } catch (error) {
    throw new SyncCommandError(`Failed to clone repo: ${formatError(error)}`);
  }
}

export async function ensureRepoPrivate($: Shell, config: SyncConfig): Promise<void> {
  const repoIdentifier = resolveRepoIdentifier(config);
  let output: string;

  try {
    output = await $`gh repo view ${repoIdentifier} --json isPrivate`.text();
  } catch (error) {
    throw new RepoVisibilityError(`Unable to verify repo visibility: ${formatError(error)}`);
  }

  let isPrivate = false;
  try {
    isPrivate = parseRepoVisibility(output);
  } catch (error) {
    throw new RepoVisibilityError(`Unable to verify repo visibility: ${formatError(error)}`);
  }

  if (!isPrivate) {
    throw new RepoPrivateRequiredError('Secrets sync requires a private GitHub repo.');
  }
}

export function parseRepoVisibility(output: string): boolean {
  const parsed = JSON.parse(output) as { isPrivate?: boolean };
  if (typeof parsed.isPrivate !== 'boolean') {
    throw new Error('Invalid repo visibility response.');
  }
  return parsed.isPrivate;
}

export async function fetchAndFastForward(
  $: Shell,
  repoDir: string,
  branch: string
): Promise<RepoUpdateResult> {
  try {
    await $`git -C ${repoDir} fetch --prune`;
  } catch (error) {
    throw new SyncCommandError(`Failed to fetch repo: ${formatError(error)}`);
  }

  await checkoutBranch($, repoDir, branch);

  const remoteRef = `origin/${branch}`;
  const remoteExists = await hasRemoteRef($, repoDir, branch);
  if (!remoteExists) {
    return { updated: false, branch };
  }

  const { ahead, behind } = await getAheadBehind($, repoDir, remoteRef);
  if (ahead > 0 && behind > 0) {
    throw new RepoDivergedError(
      `Local sync repo has diverged. Resolve with: cd ${repoDir} && git status && git pull --rebase`
    );
  }

  if (behind > 0) {
    try {
      await $`git -C ${repoDir} merge --ff-only ${remoteRef}`;
      return { updated: true, branch };
    } catch (error) {
      throw new SyncCommandError(`Failed to fast-forward: ${formatError(error)}`);
    }
  }

  return { updated: false, branch };
}

export async function getRepoStatus($: Shell, repoDir: string): Promise<RepoStatus> {
  const branch = await getCurrentBranch($, repoDir);
  const changes = await getStatusLines($, repoDir);
  return { branch, changes };
}

export async function hasLocalChanges($: Shell, repoDir: string): Promise<boolean> {
  const lines = await getStatusLines($, repoDir);
  return lines.length > 0;
}

export async function commitAll($: Shell, repoDir: string, message: string): Promise<void> {
  try {
    await $`git -C ${repoDir} add -A`;
    await $`git -C ${repoDir} commit -m ${message}`;
  } catch (error) {
    throw new SyncCommandError(`Failed to commit changes: ${formatError(error)}`);
  }
}

export async function pushBranch($: Shell, repoDir: string, branch: string): Promise<void> {
  try {
    await $`git -C ${repoDir} push -u origin ${branch}`;
  } catch (error) {
    throw new SyncCommandError(`Failed to push changes: ${formatError(error)}`);
  }
}

async function getCurrentBranch($: Shell, repoDir: string): Promise<string> {
  try {
    const output = await $`git -C ${repoDir} rev-parse --abbrev-ref HEAD`.text();
    const branch = output.trim();
    if (!branch || branch === 'HEAD') return 'main';
    return branch;
  } catch {
    return 'main';
  }
}

async function checkoutBranch($: Shell, repoDir: string, branch: string): Promise<void> {
  const exists = await hasLocalBranch($, repoDir, branch);
  try {
    if (exists) {
      await $`git -C ${repoDir} checkout ${branch}`;
      return;
    }
    await $`git -C ${repoDir} checkout -b ${branch}`;
  } catch (error) {
    throw new SyncCommandError(`Failed to checkout branch: ${formatError(error)}`);
  }
}

async function hasLocalBranch($: Shell, repoDir: string, branch: string): Promise<boolean> {
  try {
    await $`git -C ${repoDir} show-ref --verify refs/heads/${branch}`;
    return true;
  } catch {
    return false;
  }
}

async function hasRemoteRef($: Shell, repoDir: string, branch: string): Promise<boolean> {
  try {
    await $`git -C ${repoDir} show-ref --verify refs/remotes/origin/${branch}`;
    return true;
  } catch {
    return false;
  }
}

async function getAheadBehind(
  $: Shell,
  repoDir: string,
  remoteRef: string
): Promise<{ ahead: number; behind: number }> {
  try {
    const output =
      await $`git -C ${repoDir} rev-list --left-right --count HEAD...${remoteRef}`.text();
    const [aheadRaw, behindRaw] = output.trim().split(/\s+/);
    const ahead = Number(aheadRaw ?? 0);
    const behind = Number(behindRaw ?? 0);
    return { ahead, behind };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

async function getStatusLines($: Shell, repoDir: string): Promise<string[]> {
  try {
    const output = await $`git -C ${repoDir} status --porcelain`.text();
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function repoExists($: Shell, repoIdentifier: string): Promise<boolean> {
  try {
    await $`gh repo view ${repoIdentifier} --json name`;
    return true;
  } catch {
    return false;
  }
}

export async function getAuthenticatedUser($: Shell): Promise<string> {
  try {
    const output = await $`gh api user --jq .login`.text();
    return output.trim();
  } catch (error) {
    throw new SyncCommandError(
      `Failed to detect GitHub user. Ensure gh is authenticated: ${formatError(error)}`
    );
  }
}
