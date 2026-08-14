import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { PluginInput } from '@opencode-ai/plugin';
import { afterEach, describe, expect, it } from 'vitest';

import { loadState, writeSyncConfig } from './config.js';
import { resolveSyncLocations } from './paths.js';
import { createSyncService } from './service.js';

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];
const originalEnv = { ...process.env };

afterEach(async () => {
  process.env = { ...originalEnv };
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SyncService local-wins integration', () => {
  it('does not wait for TUI to exist when startup sync is not configured', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-synced-startup-'));
    tempDirs.push(root);
    process.env.HOME = path.join(root, 'home');
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_STATE_HOME;
    delete process.env.opencode_config_dir;
    await mkdir(process.env.HOME, { recursive: true });
    const client = {
      app: { log: async () => ({}) },
      tui: { showToast: () => new Promise(() => {}) },
    } as unknown as PluginInput['client'];
    const service = createSyncService({ client, $: createShell() });

    const result = await Promise.race([
      service.startupSync().then(() => 'completed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 500)),
    ]);

    expect(result).toBe('completed');
  });

  it('preserves unrelated remote changes and backs up a displaced same-file change', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-synced-service-'));
    tempDirs.push(root);
    const home = path.join(root, 'home');
    const origin = path.join(root, 'origin.git');
    const seed = path.join(root, 'seed');
    const remoteWriter = path.join(root, 'remote-writer');
    await mkdir(home, { recursive: true });
    process.env.HOME = home;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_STATE_HOME;
    delete process.env.opencode_config_dir;

    await run('git', ['init', '--bare', origin]);
    await run('git', ['clone', origin, seed]);
    await configureGit(seed);
    await mkdir(path.join(seed, 'config'), { recursive: true });
    await writeFile(path.join(seed, 'config', 'AGENTS.md'), 'base-agents\n');
    await writeFile(path.join(seed, 'config', 'opencode.json'), '{"theme":"base"}\n');
    await run('git', ['-C', seed, 'add', '--all']);
    await run('git', ['-C', seed, 'commit', '-m', 'base']);
    await run('git', ['-C', seed, 'branch', '-M', 'main']);
    await run('git', ['-C', seed, 'push', '--set-upstream', 'origin', 'main']);
    await run('git', ['--git-dir', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

    const locations = resolveSyncLocations();
    await mkdir(path.dirname(locations.defaultRepoDir), { recursive: true });
    await run('git', ['clone', origin, locations.defaultRepoDir]);
    await configureGit(locations.defaultRepoDir);
    await mkdir(locations.configRoot, { recursive: true });
    await writeFile(path.join(locations.configRoot, 'AGENTS.md'), 'base-agents\n');
    await writeFile(path.join(locations.configRoot, 'opencode.json'), '{"theme":"base"}\n');
    await writeSyncConfig(locations, {
      repo: { url: origin, branch: 'main' },
      includeModelFavorites: false,
    });

    await writeFile(path.join(locations.configRoot, 'AGENTS.md'), 'local-agents\n');

    await run('git', ['clone', origin, remoteWriter]);
    await configureGit(remoteWriter);
    await writeFile(path.join(remoteWriter, 'config', 'AGENTS.md'), 'remote-agents\n');
    await writeFile(path.join(remoteWriter, 'config', 'opencode.json'), '{"theme":"remote"}\n');
    await run('git', ['-C', remoteWriter, 'add', '--all']);
    await run('git', ['-C', remoteWriter, 'commit', '-m', 'remote update']);
    await run('git', ['-C', remoteWriter, 'push']);

    const service = createSyncService({ client: createClient(), $: createShell() });
    await expect(service.push()).resolves.toContain('Pushed changes');

    expect(await readFile(path.join(locations.configRoot, 'AGENTS.md'), 'utf8')).toBe(
      'local-agents\n'
    );
    expect(await readFile(path.join(locations.configRoot, 'opencode.json'), 'utf8')).toContain(
      'remote'
    );
    expect(await gitShow(origin, 'main:config/AGENTS.md')).toBe('local-agents\n');
    expect(await gitShow(origin, 'main:config/opencode.json')).toContain('remote');

    const rollbackBase = path.join(
      path.dirname(locations.statePath),
      'opencode-synced',
      'rollbacks'
    );
    const rollbackDirs = await readdir(rollbackBase);
    expect(rollbackDirs).toHaveLength(1);
    expect(
      await readFile(path.join(rollbackBase, rollbackDirs[0], 'config', 'AGENTS.md'), 'utf8')
    ).toBe('remote-agents\n');

    expect(await loadState(locations)).toMatchObject({ lastOutcome: 'pushed' });
    expect(
      (await run('git', ['-C', locations.defaultRepoDir, 'status', '--porcelain'])).stdout
    ).toBe('');

    await writeFile(path.join(locations.configRoot, 'AGENTS.md'), 'pending-local-agents\n');
    await writeFile(
      path.join(locations.defaultRepoDir, 'config', 'AGENTS.md'),
      'pending-local-agents\n'
    );
    await run('git', ['-C', locations.defaultRepoDir, 'add', '--all']);
    await run('git', ['-C', locations.defaultRepoDir, 'commit', '-m', 'pending local commit']);

    await run('git', ['-C', remoteWriter, 'pull', '--ff-only']);
    await rm(path.join(remoteWriter, 'config', 'AGENTS.md'));
    await writeFile(path.join(remoteWriter, 'config', 'opencode.json'), '{"theme":"remote-two"}\n');
    await run('git', ['-C', remoteWriter, 'add', '--all']);
    await run('git', ['-C', remoteWriter, 'commit', '-m', 'second remote update']);
    await run('git', ['-C', remoteWriter, 'push']);

    await expect(service.push()).resolves.toContain('Pushed');
    expect(await gitShow(origin, 'main:config/AGENTS.md')).toBe('pending-local-agents\n');
    expect(await gitShow(origin, 'main:config/opencode.json')).toContain('remote-two');

    await writeFile(path.join(locations.configRoot, 'AGENTS.md'), 'stale-local-value\n');
    await expect(service.pull()).resolves.toContain('Remote config applied');
    expect(await readFile(path.join(locations.configRoot, 'AGENTS.md'), 'utf8')).toBe(
      'pending-local-agents\n'
    );
  });

  it('rejects an existing clone with a different origin', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-synced-origin-'));
    tempDirs.push(root);
    const home = path.join(root, 'home');
    const oldOrigin = path.join(root, 'old-origin.git');
    const configuredOrigin = path.join(root, 'configured-origin.git');
    await mkdir(home, { recursive: true });
    process.env.HOME = home;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_STATE_HOME;
    delete process.env.opencode_config_dir;
    await run('git', ['init', '--bare', oldOrigin]);
    await run('git', ['init', '--bare', configuredOrigin]);

    const locations = resolveSyncLocations();
    await mkdir(path.dirname(locations.defaultRepoDir), { recursive: true });
    await run('git', ['clone', oldOrigin, locations.defaultRepoDir]);
    await writeSyncConfig(locations, {
      repo: { url: configuredOrigin, branch: 'main' },
      includeModelFavorites: false,
    });

    const service = createSyncService({ client: createClient(), $: createShell() });
    await expect(service.push()).rejects.toThrow('origin does not match configured repo');
  });
});

function createClient(): PluginInput['client'] {
  return {
    app: { log: async () => ({}) },
    tui: { showToast: async () => ({}) },
  } as unknown as PluginInput['client'];
}

function createShell(): PluginInput['$'] {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    let commandTemplate = strings[0];
    for (let index = 0; index < values.length; index += 1) {
      commandTemplate += `__OCSYNC_ARG_${index}__${strings[index + 1]}`;
    }
    const args = (commandTemplate.match(/\S+/g) ?? []).map((token) =>
      token.replace(/__OCSYNC_ARG_(\d+)__/g, (_match, index) => String(values[Number(index)]))
    );
    const [command, ...commandArgs] = args;
    let promise: Promise<{ stdout: string; stderr: string }> | null = null;
    const execute = () => {
      promise ??= run(command, commandArgs);
      return promise;
    };
    const text = async () => (await execute()).stdout;
    const result = {
      quiet: () => Object.assign(execute(), { text }),
      text,
    };
    return result;
  }) as unknown as PluginInput['$'];
}

async function configureGit(repo: string): Promise<void> {
  await run('git', ['-C', repo, 'config', 'user.name', 'Test User']);
  await run('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
}

async function gitShow(repo: string, object: string): Promise<string> {
  return (await run('git', ['--git-dir', repo, 'show', object])).stdout;
}

async function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFile(command, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr };
}
