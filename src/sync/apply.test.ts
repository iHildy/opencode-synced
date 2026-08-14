import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { syncLocalToRepo, syncRepoToLocal } from './apply.js';
import type { SyncItem, SyncPlan } from './paths.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRoots(): Promise<{ home: string; repo: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-synced-apply-'));
  tempDirs.push(root);
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
  return { home, repo };
}

function makePlan(home: string, repo: string, items: SyncItem[]): SyncPlan {
  return {
    items,
    repoRoot: repo,
    homeDir: home,
    platform: 'linux',
  };
}

describe('safe synchronization', () => {
  it('rejects a symlinked source file', async () => {
    const { home, repo } = await makeRoots();
    const outside = path.join(home, 'outside.txt');
    const source = path.join(home, 'config.txt');
    await writeFile(outside, 'private');
    await symlink(outside, source);

    const plan = makePlan(home, repo, [
      {
        localPath: source,
        repoPath: path.join(repo, 'config', 'config.txt'),
        type: 'file',
        isSecret: false,
        isConfigFile: false,
      },
    ]);

    await expect(syncLocalToRepo(plan, null)).rejects.toThrow('symlink');
  });

  it('rejects repository paths outside the repository root', async () => {
    const { home, repo } = await makeRoots();
    const source = path.join(home, 'config.txt');
    await writeFile(source, 'safe');

    const plan = makePlan(home, repo, [
      {
        localPath: source,
        repoPath: `${repo}-evil/config.txt`,
        type: 'file',
        isSecret: false,
        isConfigFile: false,
      },
    ]);

    await expect(syncLocalToRepo(plan, null)).rejects.toThrow('outside the allowed root');
  });

  it('does not delete through a symlinked repository ancestor', async () => {
    const { home, repo } = await makeRoots();
    const outside = path.join(home, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'AGENTS.md'), 'keep');
    await symlink(outside, path.join(repo, 'config'));
    const plan = makePlan(home, repo, [
      {
        localPath: path.join(home, 'missing-AGENTS.md'),
        repoPath: path.join(repo, 'config', 'AGENTS.md'),
        type: 'file',
        isSecret: false,
        isConfigFile: false,
      },
    ]);

    await expect(syncLocalToRepo(plan, null)).rejects.toThrow('symlink');
    expect(await readFile(path.join(outside, 'AGENTS.md'), 'utf8')).toBe('keep');
  });

  it('filters generated skill files and preserves executable mode', async () => {
    const { home, repo } = await makeRoots();
    const skills = path.join(home, 'skills');
    await mkdir(path.join(skills, 'demo', '__pycache__'), { recursive: true });
    await writeFile(path.join(skills, 'demo', 'SKILL.md'), '# Demo\n');
    await writeFile(path.join(skills, 'demo', 'run.sh'), '#!/bin/sh\nexit 0\n');
    await chmod(path.join(skills, 'demo', 'run.sh'), 0o755);
    await writeFile(path.join(skills, 'demo', '__pycache__', 'cache.pyc'), 'cache');
    await writeFile(path.join(skills, 'demo', 'SKILL.md:Zone.Identifier'), 'metadata');
    await writeFile(path.join(skills, '.DS_Store'), 'metadata');

    const destination = path.join(repo, 'config', 'skills');
    const plan = makePlan(home, repo, [
      {
        localPath: skills,
        repoPath: destination,
        type: 'dir',
        isSecret: false,
        isConfigFile: false,
        strategy: 'skills',
      },
    ]);

    await syncLocalToRepo(plan, null);

    expect(await readFile(path.join(destination, 'demo', 'SKILL.md'), 'utf8')).toBe('# Demo\n');
    await expect(lstat(path.join(destination, 'demo', '__pycache__'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      lstat(path.join(destination, 'demo', 'SKILL.md:Zone.Identifier'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(path.join(destination, '.DS_Store'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await lstat(path.join(destination, 'demo', 'run.sh'))).mode & 0o777).toBe(0o755);
  });

  it('rejects sensitive files in skills', async () => {
    const { home, repo } = await makeRoots();
    const skills = path.join(home, 'skills');
    await mkdir(path.join(skills, 'demo'), { recursive: true });
    await writeFile(path.join(skills, 'demo', '.env'), 'TOKEN=private\n');
    const plan = makePlan(home, repo, [
      {
        localPath: skills,
        repoPath: path.join(repo, 'config', 'skills'),
        type: 'dir',
        isSecret: false,
        isConfigFile: false,
        strategy: 'skills',
      },
    ]);

    await expect(syncLocalToRepo(plan, null)).rejects.toThrow('sensitive skill path');
  });

  it('scans skill files larger than one MiB for secret-like content', async () => {
    const { home, repo } = await makeRoots();
    const skills = path.join(home, 'skills');
    await mkdir(path.join(skills, 'demo'), { recursive: true });
    const leakedKey = `ghp_${'a'.repeat(36)}`;
    await writeFile(
      path.join(skills, 'demo', 'large.md'),
      `${'x'.repeat(1024 * 1024)}${leakedKey}`
    );
    const plan = makePlan(home, repo, [
      {
        localPath: skills,
        repoPath: path.join(repo, 'config', 'skills'),
        type: 'dir',
        isSecret: false,
        isConfigFile: false,
        strategy: 'skills',
      },
    ]);

    await expect(syncLocalToRepo(plan, null)).rejects.toThrow('secret-like skill content');
  });

  it('writes only the favorite projection to the repository', async () => {
    const { home, repo } = await makeRoots();
    const source = path.join(home, 'model.json');
    const destination = path.join(repo, 'state', 'model-favorites.json');
    await writeFile(
      source,
      JSON.stringify({
        favorite: [{ providerID: 'provider', modelID: 'model' }],
        recent: [{ providerID: 'local', modelID: 'recent' }],
        variant: { local: 'high' },
      })
    );

    const plan = makePlan(home, repo, [
      {
        localPath: source,
        repoPath: destination,
        type: 'file',
        isSecret: false,
        isConfigFile: false,
        strategy: 'model-favorites',
      },
    ]);

    await syncLocalToRepo(plan, null);

    expect(JSON.parse(await readFile(destination, 'utf8'))).toEqual({
      favorite: [{ providerID: 'provider', modelID: 'model' }],
    });
  });

  it('applies favorites while preserving local recent and variant state', async () => {
    const { home, repo } = await makeRoots();
    const destination = path.join(home, 'model.json');
    const source = path.join(repo, 'state', 'model-favorites.json');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(
      source,
      JSON.stringify({ favorite: [{ providerID: 'remote', modelID: 'model' }] })
    );
    await writeFile(
      destination,
      JSON.stringify({
        favorite: [{ providerID: 'old', modelID: 'model' }],
        recent: [{ providerID: 'local', modelID: 'recent' }],
        variant: { local: 'high' },
      })
    );

    const plan = makePlan(home, repo, [
      {
        localPath: destination,
        repoPath: source,
        type: 'file',
        isSecret: false,
        isConfigFile: false,
        strategy: 'model-favorites',
      },
    ]);

    await syncRepoToLocal(plan, null);

    expect(JSON.parse(await readFile(destination, 'utf8'))).toEqual({
      favorite: [{ providerID: 'remote', modelID: 'model' }],
      recent: [{ providerID: 'local', modelID: 'recent' }],
      variant: { local: 'high' },
    });
  });

  it('applies a remote favorites deletion without deleting local recent state', async () => {
    const { home, repo } = await makeRoots();
    const destination = path.join(home, 'model.json');
    await writeFile(
      destination,
      JSON.stringify({
        favorite: [{ providerID: 'old', modelID: 'model' }],
        recent: [{ providerID: 'local', modelID: 'recent' }],
      })
    );
    const plan = makePlan(home, repo, [
      {
        localPath: destination,
        repoPath: path.join(repo, 'state', 'model-favorites.json'),
        type: 'file',
        isSecret: false,
        isConfigFile: false,
        strategy: 'model-favorites',
      },
    ]);

    await syncRepoToLocal(plan, null);

    expect(JSON.parse(await readFile(destination, 'utf8'))).toEqual({
      favorite: [],
      recent: [{ providerID: 'local', modelID: 'recent' }],
    });
  });

  it('rejects a symlinked local destination during pull', async () => {
    const { home, repo } = await makeRoots();
    const outside = path.join(home, 'outside.txt');
    const destination = path.join(home, 'config.txt');
    const source = path.join(repo, 'config', 'config.txt');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(outside, 'keep');
    await symlink(outside, destination);
    await writeFile(source, 'remote');

    const plan = makePlan(home, repo, [
      {
        localPath: destination,
        repoPath: source,
        type: 'file',
        isSecret: false,
        isConfigFile: false,
      },
    ]);

    await expect(syncRepoToLocal(plan, null)).rejects.toThrow('symlink');
    expect(await readFile(outside, 'utf8')).toBe('keep');
  });

  it('applies a remote deletion to the local managed file', async () => {
    const { home, repo } = await makeRoots();
    const destination = path.join(home, 'obsolete.txt');
    await writeFile(destination, 'obsolete');
    const plan = makePlan(home, repo, [
      {
        localPath: destination,
        repoPath: path.join(repo, 'config', 'obsolete.txt'),
        type: 'file',
        isSecret: false,
        isConfigFile: false,
      },
    ]);

    await syncRepoToLocal(plan, null);

    await expect(readFile(destination, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls back earlier local items when a later remote item is invalid', async () => {
    const { home, repo } = await makeRoots();
    const localA = path.join(home, 'a.txt');
    const localB = path.join(home, 'b.txt');
    const remoteA = path.join(repo, 'config', 'a.txt');
    const remoteB = path.join(repo, 'config', 'b.txt');
    const outside = path.join(repo, 'outside.txt');
    await mkdir(path.dirname(remoteA), { recursive: true });
    await writeFile(localA, 'local-a');
    await writeFile(localB, 'local-b');
    await writeFile(remoteA, 'remote-a');
    await writeFile(outside, 'outside');
    await symlink(outside, remoteB);
    const plan = makePlan(home, repo, [
      { localPath: localA, repoPath: remoteA, type: 'file', isSecret: false, isConfigFile: false },
      { localPath: localB, repoPath: remoteB, type: 'file', isSecret: false, isConfigFile: false },
    ]);

    await expect(syncRepoToLocal(plan, null)).rejects.toThrow('symlink');
    expect(await readFile(localA, 'utf8')).toBe('local-a');
    expect(await readFile(localB, 'utf8')).toBe('local-b');
  });

  it('rejects malformed remote config before replacing the local config', async () => {
    const { home, repo } = await makeRoots();
    const localConfig = path.join(home, 'opencode.json');
    const remoteConfig = path.join(repo, 'config', 'opencode.json');
    await mkdir(path.dirname(remoteConfig), { recursive: true });
    await writeFile(localConfig, '{"theme":"local"}\n');
    await writeFile(remoteConfig, '{"theme":');
    const plan = makePlan(home, repo, [
      {
        localPath: localConfig,
        repoPath: remoteConfig,
        type: 'file',
        isSecret: false,
        isConfigFile: true,
      },
    ]);

    await expect(syncRepoToLocal(plan, null)).rejects.toThrow();
    expect(await readFile(localConfig, 'utf8')).toBe('{"theme":"local"}\n');
  });

  it('copies valid prompt JSONL snapshots byte-for-byte', async () => {
    const { home, repo } = await makeRoots();
    const source = path.join(home, 'prompt-history.jsonl');
    const destination = path.join(repo, 'state', 'prompts', 'prompt-history.jsonl');
    const content =
      '{"input":"one","mode":"build","parts":[]}\n{"input":"two","mode":"plan","parts":[]}\n';
    await writeFile(source, content);
    const plan = makePlan(home, repo, [
      {
        localPath: source,
        repoPath: destination,
        type: 'file',
        isSecret: true,
        isConfigFile: false,
        strategy: 'prompt-snapshot',
      },
    ]);

    await syncLocalToRepo(plan, null);

    expect(await readFile(destination, 'utf8')).toBe(content);
    expect((await lstat(destination)).mode & 0o777).toBe(0o600);
    expect((await lstat(path.dirname(destination))).mode & 0o777).toBe(0o700);
  });

  it('rejects malformed prompt JSONL before it reaches the repository', async () => {
    const { home, repo } = await makeRoots();
    const source = path.join(home, 'prompt-history.jsonl');
    const destination = path.join(repo, 'state', 'prompts', 'prompt-history.jsonl');
    await writeFile(source, '{"input":"valid"}\n{"input":\n');
    const plan = makePlan(home, repo, [
      {
        localPath: source,
        repoPath: destination,
        type: 'file',
        isSecret: true,
        isConfigFile: false,
        strategy: 'prompt-snapshot',
      },
    ]);

    await expect(syncLocalToRepo(plan, null)).rejects.toThrow('Invalid prompt JSONL');
    await expect(readFile(destination, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
