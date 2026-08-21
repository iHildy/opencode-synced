import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertRestrictedRepoLayout,
  deriveGitIdentity,
  normalizeRepoRemote,
  parseAheadBehind,
  parseRepoVisibility,
  shouldPushBranch,
} from './repo.js';

describe('normalizeRepoRemote', () => {
  it('matches GitHub owner/name, HTTPS, and SSH forms', () => {
    expect(normalizeRepoRemote('Owner/Repo')).toBe('github.com/owner/repo');
    expect(normalizeRepoRemote('https://github.com/Owner/Repo.git')).toBe('github.com/owner/repo');
    expect(normalizeRepoRemote('git@github.com:Owner/Repo.git')).toBe('github.com/owner/repo');
  });

  it('normalizes local repository paths', () => {
    expect(normalizeRepoRemote('/tmp/example.git')).toBe(`local:${path.resolve('/tmp/example.git')}`);
  });

  it('does not equate alternate protocols or ports with canonical GitHub', () => {
    expect(normalizeRepoRemote('http://github.com/Owner/Repo.git')).not.toBe(
      normalizeRepoRemote('Owner/Repo')
    );
    expect(normalizeRepoRemote('https://github.com:8443/Owner/Repo.git')).not.toBe(
      normalizeRepoRemote('Owner/Repo')
    );
  });
});

describe('parseRepoVisibility', () => {
  it('parses private status', () => {
    expect(parseRepoVisibility('{"isPrivate": true}')).toBe(true);
    expect(parseRepoVisibility('{"isPrivate": false}')).toBe(false);
  });

  it('throws on invalid payload', () => {
    expect(() => parseRepoVisibility('{"private": true}')).toThrow();
  });
});

describe('parseAheadBehind', () => {
  it('parses git rev-list counts', () => {
    expect(parseAheadBehind('2\t3\n')).toEqual({ ahead: 2, behind: 3 });
  });

  it('rejects malformed counts instead of pretending the repo is current', () => {
    expect(() => parseAheadBehind('not-a-count')).toThrow('Invalid ahead/behind response');
  });
});

describe('deriveGitIdentity', () => {
  it('uses the account name and GitHub noreply address', () => {
    expect(deriveGitIdentity({ login: 'octocat', id: 123, name: 'The Octocat' })).toEqual({
      name: 'The Octocat',
      email: '123+octocat@users.noreply.github.com',
    });
  });

  it('falls back to login when the account has no display name', () => {
    expect(deriveGitIdentity({ login: 'octocat', id: 123, name: null })).toEqual({
      name: 'octocat',
      email: '123+octocat@users.noreply.github.com',
    });
  });
});

describe('shouldPushBranch', () => {
  it('pushes an initial branch and a clean branch that is ahead', () => {
    expect(shouldPushBranch(false, 0)).toBe(true);
    expect(shouldPushBranch(true, 1)).toBe(true);
  });

  it('does not push a branch already equal to its remote', () => {
    expect(shouldPushBranch(true, 0)).toBe(false);
  });

  it('does not recreate a previously tracked branch deleted from the remote', () => {
    expect(shouldPushBranch(false, 0, true)).toBe(false);
  });
});

describe('assertRestrictedRepoLayout', () => {
  it('rejects legacy sensitive or local-only tracked paths', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'opencode-synced-layout-'));
    try {
      await mkdir(path.join(repo, 'data'), { recursive: true });
      await writeFile(path.join(repo, 'data', 'auth.json'), '{}\n');

      await expect(assertRestrictedRepoLayout(repo)).rejects.toThrow('data');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('accepts the narrow portable layout', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'opencode-synced-layout-'));
    try {
      await mkdir(path.join(repo, 'config', 'skills'), { recursive: true });
      await mkdir(path.join(repo, 'state', 'prompts'), { recursive: true });
      await writeFile(path.join(repo, 'state', 'model-favorites.json'), '{"favorite":[]}\n');

      await expect(assertRestrictedRepoLayout(repo)).resolves.toBeUndefined();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
