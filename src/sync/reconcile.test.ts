import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SyncItem, SyncPlan } from './paths.js';
import { applyLocalProjection, createLocalProjection } from './reconcile.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(): Promise<{
  root: string;
  home: string;
  repo: string;
  stage: string;
  rollback: string;
  plan: SyncPlan;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-synced-reconcile-'));
  tempDirs.push(root);
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  const stage = path.join(root, 'stage');
  const rollback = path.join(root, 'rollback');
  await mkdir(path.join(home, 'config'), { recursive: true });
  await mkdir(path.join(repo, 'config'), { recursive: true });
  const items: SyncItem[] = ['a.txt', 'b.txt'].map((name) => ({
    localPath: path.join(home, 'config', name),
    repoPath: path.join(repo, 'config', name),
    type: 'file',
    isSecret: false,
    isConfigFile: false,
  }));
  return {
    root,
    home,
    repo,
    stage,
    rollback,
    plan: {
      items,
      repoRoot: repo,
      homeDir: home,
      platform: 'linux',
    },
  };
}

describe('local projection reconciliation', () => {
  it('keeps unrelated remote changes while applying changed local items', async () => {
    const { home, repo, stage, rollback, plan } = await setup();
    await writeFile(path.join(home, 'config', 'a.txt'), 'local-a');
    await writeFile(path.join(home, 'config', 'b.txt'), 'base-b');
    await writeFile(path.join(repo, 'config', 'a.txt'), 'base-a');
    await writeFile(path.join(repo, 'config', 'b.txt'), 'base-b');

    const projection = await createLocalProjection(plan, null, stage);
    expect(projection.changedItemIndexes).toEqual([0]);

    await writeFile(path.join(repo, 'config', 'b.txt'), 'remote-b');
    await applyLocalProjection(plan, projection, rollback);

    expect(await readFile(path.join(repo, 'config', 'a.txt'), 'utf8')).toBe('local-a');
    expect(await readFile(path.join(repo, 'config', 'b.txt'), 'utf8')).toBe('remote-b');
  });

  it('lets the current local sync win and backs up a concurrent remote version', async () => {
    const { home, repo, stage, rollback, plan } = await setup();
    await writeFile(path.join(home, 'config', 'a.txt'), 'local-a');
    await writeFile(path.join(home, 'config', 'b.txt'), 'base-b');
    await writeFile(path.join(repo, 'config', 'a.txt'), 'base-a');
    await writeFile(path.join(repo, 'config', 'b.txt'), 'base-b');

    const projection = await createLocalProjection(plan, null, stage);
    await writeFile(path.join(repo, 'config', 'a.txt'), 'remote-a');
    await applyLocalProjection(plan, projection, rollback);

    expect(await readFile(path.join(repo, 'config', 'a.txt'), 'utf8')).toBe('local-a');
    expect(await readFile(path.join(rollback, 'config', 'a.txt'), 'utf8')).toBe('remote-a');
  });

  it('propagates a local deletion while retaining the displaced remote file', async () => {
    const { home, repo, stage, rollback, plan } = await setup();
    await writeFile(path.join(home, 'config', 'b.txt'), 'base-b');
    await writeFile(path.join(repo, 'config', 'a.txt'), 'base-a');
    await writeFile(path.join(repo, 'config', 'b.txt'), 'base-b');

    const projection = await createLocalProjection(plan, null, stage);
    expect(projection.changedItemIndexes).toEqual([0]);
    await applyLocalProjection(plan, projection, rollback);

    await expect(readFile(path.join(repo, 'config', 'a.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(path.join(rollback, 'config', 'a.txt'), 'utf8')).toBe('base-a');
  });

  it('restores earlier items when a later projection replacement fails', async () => {
    const { root, repo, stage, rollback, plan } = await setup();
    await writeFile(path.join(repo, 'config', 'a.txt'), 'base-a');
    await writeFile(path.join(repo, 'config', 'b.txt'), 'base-b');
    await mkdir(path.join(stage, 'config'), { recursive: true });
    await writeFile(path.join(stage, 'config', 'a.txt'), 'local-a');
    const outside = path.join(root, 'outside.txt');
    await writeFile(outside, 'outside');
    await symlink(outside, path.join(stage, 'config', 'b.txt'));
    const projectionPlan: SyncPlan = {
      ...plan,
      repoRoot: stage,
      items: plan.items.map((item) => ({
        ...item,
        repoPath: path.join(stage, 'config', path.basename(item.repoPath)),
      })),
    };

    await expect(
      applyLocalProjection(plan, { plan: projectionPlan, changedItemIndexes: [0, 1] }, rollback)
    ).rejects.toThrow('symlink');

    expect(await readFile(path.join(repo, 'config', 'a.txt'), 'utf8')).toBe('base-a');
    expect(await readFile(path.join(repo, 'config', 'b.txt'), 'utf8')).toBe('base-b');
  });

  it('persists newly extracted MCP secrets while creating the projection', async () => {
    const { home, repo, stage, plan } = await setup();
    const configPath = path.join(home, 'config', 'opencode.json');
    const repoConfigPath = path.join(repo, 'config', 'opencode.json');
    const overridesPath = path.join(home, 'config', 'opencode-synced.overrides.jsonc');
    plan.items = [
      {
        localPath: configPath,
        repoPath: repoConfigPath,
        type: 'file',
        isSecret: false,
        isConfigFile: true,
      },
    ];
    await writeFile(
      configPath,
      JSON.stringify({ mcp: { demo: { headers: { Authorization: 'Bearer local-secret' } } } })
    );
    await writeFile(repoConfigPath, '{}\n');

    const projection = await createLocalProjection(plan, null, stage, { overridesPath });

    expect(projection.changedItemIndexes).toEqual([0]);
    expect(await readFile(overridesPath, 'utf8')).toContain('Bearer local-secret');
    expect(await readFile(projection.plan.items[0].repoPath, 'utf8')).not.toContain(
      'Bearer local-secret'
    );
  });

  it('does not treat unchanged override keys as shared config deletions', async () => {
    const { home, repo, stage, plan } = await setup();
    const configPath = path.join(home, 'config', 'opencode.json');
    const repoConfigPath = path.join(repo, 'config', 'opencode.json');
    plan.items = [
      {
        localPath: configPath,
        repoPath: repoConfigPath,
        type: 'file',
        isSecret: false,
        isConfigFile: true,
      },
    ];
    await writeFile(configPath, '{"shared":"base","theme":"local-only"}\n');
    await writeFile(repoConfigPath, '{"shared":"base","theme":"remote-base"}\n');

    const projection = await createLocalProjection(plan, { theme: 'local-only' }, stage);

    expect(projection.changedItemIndexes).toEqual([]);
    expect(JSON.parse(await readFile(projection.plan.items[0].repoPath, 'utf8'))).toEqual({
      shared: 'base',
      theme: 'remote-base',
    });
  });

  it('ignores non-executable permission differences that Git cannot represent', async () => {
    const { home, repo, stage, plan } = await setup();
    const local = path.join(home, 'config', 'a.txt');
    const tracked = path.join(repo, 'config', 'a.txt');
    await writeFile(local, 'same');
    await writeFile(tracked, 'same');
    await chmod(local, 0o600);
    await chmod(tracked, 0o644);
    plan.items = [plan.items[0]];

    const projection = await createLocalProjection(plan, null, stage);

    expect(projection.changedItemIndexes).toEqual([]);
  });
});
