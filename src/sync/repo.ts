import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';

import type { SyncConfig } from './config.js';
import { pathExists } from './config.js';
import {
  RepoDivergedError,
  RepoPrivateRequiredError,
  RepoVisibilityError,
  SyncCommandError,
} from './errors.js';

export interface RepoStatus {
  branch: string;
  changes: string[];
}

export interface RepoUpdateResult {
  updated: boolean;
  branch: string;
}

export interface GitHubUserIdentity {
  login: string;
  id: number;
  name?: string | null;
}

export interface GitIdentity {
  name: string;
  email: string;
}

type Shell = PluginInput['$'];

export async function isRepoCloned(repoDir: string): Promise<boolean> {
  const gitDir = path.join(repoDir, '.git');
  return pathExists(gitDir);
}

const RESTRICTED_REPO_PATHS = [
  'data',
  'secrets',
  'config/opencode-synced.jsonc',
  'config/opencode-synced.overrides.jsonc',
  'config/extra',
  'config/extra-manifest.json',
  'state/model.json',
  'state/prompt-history.jsonl',
  'state/prompt-stash.jsonl',
];

export async function assertRestrictedRepoLayout(repoDir: string): Promise<void> {
  const found: string[] = [];
  for (const relativePath of RESTRICTED_REPO_PATHS) {
    try {
      await fs.lstat(path.join(repoDir, relativePath));
      found.push(relativePath);
    } catch (error) {
      const maybeErrno = error as NodeJS.ErrnoException;
      if (maybeErrno.code !== 'ENOENT') throw error;
    }
  }
  if (found.length > 0) {
    throw new SyncCommandError(
      `Repository contains paths forbidden by this fork: ${found.join(', ')}. Migrate or remove them before syncing.`
    );
  }
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
    await assertRepoOriginMatches($, config, repoDir);
    return;
  }

  await fs.mkdir(path.dirname(repoDir), { recursive: true });
  const repoIdentifier = resolveRepoIdentifier(config);

  try {
    await $`gh repo clone ${repoIdentifier} ${repoDir}`.quiet();
  } catch (error) {
    throw new SyncCommandError(`Failed to clone repo: ${formatError(error)}`);
  }
  await assertRepoOriginMatches($, config, repoDir);
}

export function normalizeRepoRemote(input: string, baseDir = process.cwd()): string {
  const trimmed = input.trim().replace(/\/$/, '');
  const scpLike = trimmed.match(/^git@([^:]+):(.+)$/i);
  if (scpLike) {
    return `${scpLike[1].toLowerCase()}/${stripGitSuffix(scpLike[2]).toLowerCase()}`;
  }

  if (/^[^/:]+\/[^/]+$/.test(trimmed)) {
    return `github.com/${stripGitSuffix(trimmed).toLowerCase()}`;
  }

  try {
    const remoteUrl = new URL(trimmed);
    if (remoteUrl.protocol === 'file:') {
      return `local:${path.resolve(remoteUrl.pathname)}`;
    }
    const host = remoteUrl.hostname.toLowerCase();
    const repoPath = stripGitSuffix(remoteUrl.pathname).toLowerCase();
    const isCanonicalGithub =
      host === 'github.com' &&
      ((remoteUrl.protocol === 'https:' && (!remoteUrl.port || remoteUrl.port === '443')) ||
        (remoteUrl.protocol === 'ssh:' && (!remoteUrl.port || remoteUrl.port === '22')));
    if (isCanonicalGithub) return `${host}/${repoPath}`;
    const port = remoteUrl.port ? `:${remoteUrl.port}` : '';
    return `${remoteUrl.protocol}//${host}${port}/${repoPath}`;
  } catch {
    return `local:${path.resolve(baseDir, trimmed)}`;
  }
}

async function assertRepoOriginMatches(
  $: Shell,
  config: SyncConfig,
  repoDir: string
): Promise<void> {
  let origin: string;
  try {
    origin = await $`git -C ${repoDir} remote get-url origin`.quiet().text();
  } catch (error) {
    throw new SyncCommandError(`Unable to verify sync repo origin: ${formatError(error)}`);
  }
  const configured = resolveRepoIdentifier(config);
  if (normalizeRepoRemote(origin, repoDir) === normalizeRepoRemote(configured, process.cwd()))
    return;
  throw new SyncCommandError(
    `Existing sync repo origin does not match configured repo. Refusing to use ${repoDir}.`
  );
}

function stripGitSuffix(input: string): string {
  return input.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
}

export async function ensureRepoPrivate($: Shell, config: SyncConfig): Promise<void> {
  const repoIdentifier = resolveRepoIdentifier(config);
  let output: string;

  try {
    output = await $`gh repo view ${repoIdentifier} --json isPrivate`.quiet().text();
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
    await $`git -C ${repoDir} fetch --prune`.quiet();
  } catch (error) {
    throw new SyncCommandError(`Failed to fetch repo: ${formatError(error)}`);
  }

  await checkoutBranch($, repoDir, branch);

  const remoteRef = `origin/${branch}`;
  const remoteExists = await hasRemoteRef($, repoDir, branch);
  if (!remoteExists) {
    await assertRemoteBranchNotDeleted($, repoDir, branch);
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
      await $`git -C ${repoDir} merge --ff-only ${remoteRef}`.quiet();
      return { updated: true, branch };
    } catch (error) {
      throw new SyncCommandError(`Failed to fast-forward: ${formatError(error)}`);
    }
  }

  return { updated: false, branch };
}

export async function fetchAndRebaseLocalWins(
  $: Shell,
  repoDir: string,
  branch: string
): Promise<RepoUpdateResult> {
  try {
    await $`git -C ${repoDir} fetch --prune`.quiet();
  } catch (error) {
    throw new SyncCommandError(`Failed to fetch repo: ${formatError(error)}`);
  }

  await checkoutBranch($, repoDir, branch);
  const remoteRef = `origin/${branch}`;
  const remoteExists = await hasRemoteRef($, repoDir, branch);
  if (!remoteExists) {
    await assertRemoteBranchNotDeleted($, repoDir, branch);
    return { updated: false, branch };
  }

  const { ahead, behind } = await getAheadBehind($, repoDir, remoteRef);
  if (ahead > 0 && behind > 0) {
    const recoveryRef = `refs/opencode-synced/pending/${Date.now()}`;
    try {
      await $`git -C ${repoDir} update-ref ${recoveryRef} HEAD`.quiet();
      await $`git -C ${repoDir} rebase ${remoteRef}`.quiet();
      return { updated: true, branch };
    } catch (error) {
      try {
        await resolveRebaseConflictsLocalWins($, repoDir, recoveryRef);
        return { updated: true, branch };
      } catch (recoveryError) {
        try {
          await $`git -C ${repoDir} rebase --abort`.quiet();
        } catch {}
        throw new SyncCommandError(
          `Failed to rebase pending local commits safely: ${formatError(error)}; ${formatError(recoveryError)}. Pending commits remain at ${recoveryRef}.`
        );
      }
    }
  }

  if (behind > 0) {
    try {
      await $`git -C ${repoDir} merge --ff-only ${remoteRef}`.quiet();
      return { updated: true, branch };
    } catch (error) {
      throw new SyncCommandError(`Failed to fast-forward: ${formatError(error)}`);
    }
  }

  return { updated: false, branch };
}

async function resolveRebaseConflictsLocalWins(
  $: Shell,
  repoDir: string,
  pendingRef: string
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const output = await $`git -C ${repoDir} diff --name-only --diff-filter=U -z`.quiet().text();
    const conflictedPaths = output.split('\0').filter(Boolean);
    if (conflictedPaths.length === 0) {
      throw new Error('Rebase failed without resolvable unmerged paths.');
    }

    for (const conflictedPath of conflictedPaths) {
      const pendingObject = `${pendingRef}:${conflictedPath}`;
      if (await gitObjectExists($, repoDir, pendingObject)) {
        await $`git -C ${repoDir} checkout ${pendingRef} -- ${conflictedPath}`.quiet();
        await $`git -C ${repoDir} add -- ${conflictedPath}`.quiet();
      } else {
        await $`git -C ${repoDir} rm -f --ignore-unmatch -- ${conflictedPath}`.quiet();
      }
    }

    try {
      await $`git -C ${repoDir} -c core.editor=true rebase --continue`.quiet();
      return;
    } catch {
      const remaining = await $`git -C ${repoDir} diff --name-only --diff-filter=U -z`
        .quiet()
        .text();
      if (remaining.length === 0) throw new Error('Unable to continue resolved rebase.');
    }
  }
  throw new Error('Exceeded the maximum number of automatic rebase conflict resolutions.');
}

async function gitObjectExists($: Shell, repoDir: string, objectName: string): Promise<boolean> {
  try {
    await $`git -C ${repoDir} cat-file -e ${objectName}`.quiet();
    return true;
  } catch {
    return false;
  }
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
    await ensureGitIdentity($, repoDir);
    await $`git -C ${repoDir} add -A`.quiet();
    await $`git -C ${repoDir} commit -m ${message}`.quiet();
  } catch (error) {
    throw new SyncCommandError(`Failed to commit changes: ${formatError(error)}`);
  }
}

export async function pushBranch(
  $: Shell,
  repoDir: string,
  branch: string,
  expectedRemoteCommit?: string
): Promise<void> {
  try {
    if (expectedRemoteCommit) {
      const lease = `refs/heads/${branch}:${expectedRemoteCommit}`;
      await $`git -C ${repoDir} push -u --force-with-lease=${lease} origin ${branch}`.quiet();
      return;
    }
    await $`git -C ${repoDir} push -u origin ${branch}`.quiet();
  } catch (error) {
    throw new SyncCommandError(`Failed to push changes: ${formatError(error)}`);
  }
}

export async function pushPendingCommits(
  $: Shell,
  repoDir: string,
  branch: string
): Promise<boolean> {
  const remoteExists = await hasRemoteRef($, repoDir, branch);
  const hadUpstream = await hasConfiguredUpstream($, repoDir, branch);
  let ahead = 0;
  let expectedRemoteCommit: string | undefined;
  if (remoteExists) {
    ahead = (await getAheadBehind($, repoDir, `origin/${branch}`)).ahead;
    expectedRemoteCommit = await resolveGitCommit($, repoDir, `origin/${branch}`);
  }
  if (!shouldPushBranch(remoteExists, ahead, hadUpstream)) return false;
  await pushBranch($, repoDir, branch, expectedRemoteCommit);
  return true;
}

async function resolveGitCommit($: Shell, repoDir: string, ref: string): Promise<string> {
  try {
    return (await $`git -C ${repoDir} rev-parse ${ref}`.quiet().text()).trim();
  } catch (error) {
    throw new SyncCommandError(`Failed to resolve Git ref ${ref}: ${formatError(error)}`);
  }
}

export function shouldPushBranch(
  remoteExists: boolean,
  ahead: number,
  hadUpstream = false
): boolean {
  if (!remoteExists) return !hadUpstream;
  return ahead > 0;
}

export function deriveGitIdentity(user: GitHubUserIdentity): GitIdentity {
  if (!user.login || !Number.isInteger(user.id) || user.id <= 0) {
    throw new Error('Invalid GitHub user identity response.');
  }
  return {
    name: user.name?.trim() || user.login,
    email: `${user.id}+${user.login}@users.noreply.github.com`,
  };
}

export async function ensureGitIdentity($: Shell, repoDir: string): Promise<void> {
  const name = await readLocalGitConfig($, repoDir, 'user.name');
  const email = await readLocalGitConfig($, repoDir, 'user.email');
  if (name && email) return;

  let user: GitHubUserIdentity;
  try {
    const output = await $`gh api user --jq ${'{login: .login, id: .id, name: .name}'}`
      .quiet()
      .text();
    user = JSON.parse(output) as GitHubUserIdentity;
  } catch (error) {
    throw new SyncCommandError(`Failed to derive Git identity: ${formatError(error)}`);
  }
  const derived = deriveGitIdentity(user);
  try {
    if (!name) await $`git -C ${repoDir} config user.name ${derived.name}`.quiet();
    if (!email) await $`git -C ${repoDir} config user.email ${derived.email}`.quiet();
  } catch (error) {
    throw new SyncCommandError(
      `Failed to configure repository Git identity: ${formatError(error)}`
    );
  }
}

async function getCurrentBranch($: Shell, repoDir: string): Promise<string> {
  try {
    const output = await $`git -C ${repoDir} rev-parse --abbrev-ref HEAD`.quiet().text();
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
      await $`git -C ${repoDir} checkout ${branch}`.quiet();
      return;
    }
    if (await hasRemoteRef($, repoDir, branch)) {
      await $`git -C ${repoDir} checkout -b ${branch} --track origin/${branch}`.quiet();
      return;
    }
    if (await hasHeadCommit($, repoDir)) {
      throw new SyncCommandError(
        `Configured branch ${branch} does not exist locally or on origin. Refusing to create it from the current branch.`
      );
    }
    await $`git -C ${repoDir} checkout --orphan ${branch}`.quiet();
  } catch (error) {
    throw new SyncCommandError(`Failed to checkout branch: ${formatError(error)}`);
  }
}

async function hasLocalBranch($: Shell, repoDir: string, branch: string): Promise<boolean> {
  try {
    await $`git -C ${repoDir} show-ref --verify refs/heads/${branch}`.quiet();
    return true;
  } catch {
    return false;
  }
}

async function hasRemoteRef($: Shell, repoDir: string, branch: string): Promise<boolean> {
  try {
    await $`git -C ${repoDir} show-ref --verify refs/remotes/origin/${branch}`.quiet();
    return true;
  } catch {
    return false;
  }
}

async function hasConfiguredUpstream($: Shell, repoDir: string, branch: string): Promise<boolean> {
  try {
    const remote = await $`git -C ${repoDir} config --get branch.${branch}.remote`.quiet().text();
    return remote.trim().length > 0;
  } catch {
    return false;
  }
}

async function assertRemoteBranchNotDeleted(
  $: Shell,
  repoDir: string,
  branch: string
): Promise<void> {
  if (!(await hasConfiguredUpstream($, repoDir, branch))) return;
  throw new SyncCommandError(
    `Remote branch origin/${branch} no longer exists. Refusing to recreate a deleted branch.`
  );
}

async function hasHeadCommit($: Shell, repoDir: string): Promise<boolean> {
  try {
    await $`git -C ${repoDir} rev-parse --verify HEAD`.quiet();
    return true;
  } catch {
    return false;
  }
}

export async function getAheadBehind(
  $: Shell,
  repoDir: string,
  remoteRef: string
): Promise<{ ahead: number; behind: number }> {
  try {
    const output = await $`git -C ${repoDir} rev-list --left-right --count HEAD...${remoteRef}`
      .quiet()
      .text();
    return parseAheadBehind(output);
  } catch (error) {
    throw new SyncCommandError(`Failed to determine ahead/behind state: ${formatError(error)}`);
  }
}

export function parseAheadBehind(output: string): { ahead: number; behind: number } {
  const [aheadRaw, behindRaw, ...rest] = output.trim().split(/\s+/);
  const ahead = Number(aheadRaw);
  const behind = Number(behindRaw);
  if (
    rest.length > 0 ||
    !Number.isInteger(ahead) ||
    ahead < 0 ||
    !Number.isInteger(behind) ||
    behind < 0
  ) {
    throw new Error('Invalid ahead/behind response.');
  }
  return { ahead, behind };
}

async function getStatusLines($: Shell, repoDir: string): Promise<string[]> {
  try {
    const output = await $`git -C ${repoDir} status --porcelain`.quiet().text();
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    throw new SyncCommandError(`Failed to read Git status: ${formatError(error)}`);
  }
}

async function readLocalGitConfig(
  $: Shell,
  repoDir: string,
  key: 'user.name' | 'user.email'
): Promise<string | null> {
  try {
    const output = await $`git -C ${repoDir} config --local --get ${key}`.quiet().text();
    return output.trim() || null;
  } catch {
    return null;
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function repoExists($: Shell, repoIdentifier: string): Promise<boolean> {
  try {
    await $`gh repo view ${repoIdentifier} --json name`.quiet();
    return true;
  } catch {
    return false;
  }
}

export async function getAuthenticatedUser($: Shell): Promise<string> {
  try {
    const output = await $`gh api user --jq .login`.quiet().text();
    return output.trim();
  } catch (error) {
    throw new SyncCommandError(
      `Failed to detect GitHub user. Ensure gh is authenticated: ${formatError(error)}`
    );
  }
}

const LIKELY_SYNC_REPO_NAMES = [
  'my-opencode-config',
  'opencode-config',
  'opencode-sync',
  'opencode-synced',
  'dotfiles-opencode',
];

export interface FoundRepo {
  owner: string;
  name: string;
  isPrivate: boolean;
}

export async function findSyncRepo($: Shell, repoName?: string): Promise<FoundRepo | null> {
  const owner = await getAuthenticatedUser($);

  // If user provided a specific name, check that first
  if (repoName) {
    const exists = await repoExists($, `${owner}/${repoName}`);
    if (exists) {
      const isPrivate = await checkRepoPrivate($, `${owner}/${repoName}`);
      return { owner, name: repoName, isPrivate };
    }
    return null;
  }

  // Search through likely repo names
  for (const name of LIKELY_SYNC_REPO_NAMES) {
    const exists = await repoExists($, `${owner}/${name}`);
    if (exists) {
      const isPrivate = await checkRepoPrivate($, `${owner}/${name}`);
      return { owner, name, isPrivate };
    }
  }

  return null;
}

async function checkRepoPrivate($: Shell, repoIdentifier: string): Promise<boolean> {
  try {
    const output = await $`gh repo view ${repoIdentifier} --json isPrivate`.quiet().text();
    return parseRepoVisibility(output);
  } catch {
    return false;
  }
}
