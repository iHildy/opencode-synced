import { exec, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PluginInput } from '@opencode-ai/plugin';
import { afterEach, describe, expect, it } from 'vitest';

import { inspectOversizedUnpushedHistory } from './repo.js';

const roots: string[] = [];
const execAsync = promisify(exec);
const shell = createTestShell();

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('oversized unpushed Git history inspection', () => {
  it('finds an oversized blob in commits ahead of the remote branch', async () => {
    const fixture = await createGitFixture();
    await fs.mkdir(path.join(fixture.local, 'data'), { recursive: true });
    await fs.writeFile(path.join(fixture.local, 'data', 'opencode.db'), Buffer.alloc(32, 1));
    git(fixture.local, 'add', '-A');
    git(fixture.local, 'commit', '-m', 'sync sessions');

    const result = await inspectOversizedUnpushedHistory(shell, fixture.local, 'main', 16);
    expect(result).toEqual({
      oversizedPaths: ['data/opencode.db'],
      unpushedCommits: 1,
      remoteExists: true,
    });
  });

  it('reports oversized paths containing newlines without truncating them', async () => {
    const fixture = await createGitFixture();
    const unusualPath = path.join(fixture.local, 'data', 'message\ncontinued.json');
    await fs.mkdir(path.dirname(unusualPath), { recursive: true });
    await fs.writeFile(unusualPath, Buffer.alloc(32, 1));
    git(fixture.local, 'add', '-A');
    git(fixture.local, 'commit', '-m', 'sync unusual session');

    const result = await inspectOversizedUnpushedHistory(shell, fixture.local, 'main', 16);
    expect(result.oversizedPaths).toEqual(['data/message\ncontinued.json']);
  });

  it('does not report oversized blobs that are already on the remote', async () => {
    const fixture = await createGitFixture();
    await fs.mkdir(path.join(fixture.local, 'data'), { recursive: true });
    await fs.writeFile(path.join(fixture.local, 'data', 'opencode.db'), Buffer.alloc(32, 1));
    git(fixture.local, 'add', '-A');
    git(fixture.local, 'commit', '-m', 'published sessions');
    git(fixture.local, 'push', 'origin', 'main');
    git(fixture.local, 'fetch', 'origin');

    const result = await inspectOversizedUnpushedHistory(shell, fixture.local, 'main', 16);
    expect(result.oversizedPaths).toEqual([]);
    expect(result.unpushedCommits).toBe(0);
  });

  it('inspects an unpublished initial branch without including other remote history', async () => {
    const fixture = await createGitFixture();
    git(fixture.local, 'checkout', '--orphan', 'sessions');
    git(fixture.local, 'rm', '-rf', '.');
    await fs.writeFile(path.join(fixture.local, 'message.json'), Buffer.alloc(32, 2));
    git(fixture.local, 'add', '-A');
    git(fixture.local, 'commit', '-m', 'initial sessions');

    const result = await inspectOversizedUnpushedHistory(shell, fixture.local, 'sessions', 16);
    expect(result).toEqual({
      oversizedPaths: ['message.json'],
      unpushedCommits: 1,
      remoteExists: false,
    });
  });
});

async function createGitFixture(): Promise<{ root: string; local: string; remote: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-synced-history-'));
  roots.push(root);
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const local = path.join(root, 'local');
  git(root, 'init', '--bare', remote);
  git(root, 'clone', remote, seed);
  git(seed, 'config', 'user.email', 'test@example.com');
  git(seed, 'config', 'user.name', 'Test User');
  await fs.writeFile(path.join(seed, 'README.md'), 'seed\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'seed');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'push', '-u', 'origin', 'main');
  git(root, 'clone', '--branch', 'main', remote, local);
  git(local, 'config', 'user.email', 'test@example.com');
  git(local, 'config', 'user.name', 'Test User');
  return { root, local, remote };
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
}

interface TestShellCommand extends Promise<{ stdout: string; stderr: string }> {
  quiet: () => TestShellCommand;
  text: () => Promise<string>;
}

function createTestShell(): PluginInput['$'] {
  const testShell = (strings: TemplateStringsArray, ...values: unknown[]): TestShellCommand => {
    const command = strings.reduce(
      (result, segment, index) =>
        result + segment + (index < values.length ? shellQuote(values[index]) : ''),
      ''
    );
    const execution = execAsync(command) as unknown as TestShellCommand;
    execution.quiet = () => execution;
    execution.text = async () => (await execution).stdout;
    return execution;
  };
  return testShell as unknown as PluginInput['$'];
}

function shellQuote(value: unknown): string {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}
