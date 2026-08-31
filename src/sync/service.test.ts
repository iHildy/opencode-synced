import { exec } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { PluginInput } from '@opencode-ai/plugin';
import { describe, expect, it } from 'vitest';
import { loadState, loadSyncConfig, writeSyncConfig } from './config.js';
import { resolveSyncLocations } from './paths.js';
import { createSyncService } from './service.js';

const GIT_CONTEXT_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
] as const;

const ENV_KEYS = [
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'opencode_config_dir',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  ...GIT_CONTEXT_KEYS,
] as const;

const execAsync = promisify(exec);
type ExecResult = Awaited<ReturnType<typeof execAsync>>;

interface TestShellCommand extends Promise<ExecResult> {
  quiet: () => TestShellCommand;
  text: () => Promise<string>;
}

function createTestShell(): PluginInput['$'] {
  const shell = (strings: TemplateStringsArray, ...values: unknown[]): TestShellCommand => {
    const env = { ...process.env };
    for (const key of GIT_CONTEXT_KEYS) delete env[key];
    const command = strings.reduce(
      (result, segment, index) =>
        result + segment + (index < values.length ? shellQuote(values[index]) : ''),
      ''
    );
    const execution = execAsync(command, { env }) as TestShellCommand;
    execution.quiet = () => execution;
    execution.text = async () => (await execution).stdout;
    return execution;
  };
  return shell as unknown as PluginInput['$'];
}

function shellQuote(value: unknown): string {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function createClient(): PluginInput['client'] {
  return {
    app: { log: async () => ({}) },
    config: { get: async () => ({ data: {} }) },
    session: {
      create: async () => ({ data: null }),
      delete: async () => ({}),
      prompt: async () => ({ data: null }),
      status: async () => ({ data: {} }),
    },
    tui: { showToast: async () => ({}) },
  } as unknown as PluginInput['client'];
}

function useIsolatedHome(homeDir: string): void {
  process.env.HOME = homeDir;
  process.env.XDG_CONFIG_HOME = path.join(homeDir, 'config');
  process.env.XDG_DATA_HOME = path.join(homeDir, 'data');
  process.env.XDG_STATE_HOME = path.join(homeDir, 'state');
  delete process.env.opencode_config_dir;
}

async function withIsolatedEnvironment(run: (root: string) => Promise<void>): Promise<void> {
  const original = new Map<string, string | undefined>(
    ENV_KEYS.map((key) => [key, process.env[key]])
  );
  const root = await fs.mkdtemp(path.join(tmpdir(), 'opencode-sync-service-'));
  process.env.GIT_AUTHOR_NAME = 'opencode-synced test';
  process.env.GIT_AUTHOR_EMAIL = 'opencode-synced@example.invalid';
  process.env.GIT_COMMITTER_NAME = 'opencode-synced test';
  process.env.GIT_COMMITTER_EMAIL = 'opencode-synced@example.invalid';
  for (const key of GIT_CONTEXT_KEYS) delete process.env[key];

  try {
    await run(root);
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe('explicit Git remote service flow', () => {
  it('initializes, links, pushes, and pulls through a local bare remote', async () => {
    await withIsolatedEnvironment(async (root) => {
      const testShell = createTestShell();
      const remotePath = path.join(root, 'sync-remote.git');
      const replacementRemotePath = path.join(root, 'replacement-remote.git');
      await testShell`git init --bare ${remotePath}`.quiet();
      await testShell`git init --bare ${replacementRemotePath}`.quiet();

      const machineAHome = path.join(root, 'machine-a');
      useIsolatedHome(machineAHome);
      const machineALocations = resolveSyncLocations();
      await fs.mkdir(machineALocations.configRoot, { recursive: true });
      await fs.writeFile(
        path.join(machineALocations.configRoot, 'opencode.json'),
        '{"theme":"machine-a"}\n',
        'utf8'
      );
      const machineAService = createSyncService({ client: createClient(), $: testShell });

      const initResult = await machineAService.init({
        repo: remotePath,
        branch: 'sync/config',
      });
      expect(initResult).toContain(`Repo: ${remotePath}`);
      expect(initResult).toContain('Branch: sync/config');
      await testShell`git --git-dir ${remotePath} show-ref --verify refs/heads/sync/config`.quiet();

      const machineAConfig = await loadSyncConfig(machineALocations);
      expect(machineAConfig?.repo).toEqual({ url: remotePath, branch: 'sync/config' });

      const machineBHome = path.join(root, 'machine-b');
      useIsolatedHome(machineBHome);
      const machineBLocations = resolveSyncLocations();
      const machineBService = createSyncService({ client: createClient(), $: testShell });
      const linkResult = await machineBService.link({
        repo: remotePath,
        branch: 'sync/config',
      });

      expect(linkResult).toContain(`Linked to existing sync repo: ${remotePath}`);
      expect(linkResult).toContain('Remote privacy was not verified');
      await expect(
        fs.readFile(path.join(machineBLocations.configRoot, 'opencode.json'), 'utf8')
      ).resolves.toContain('machine-a');

      await fs.writeFile(
        path.join(machineBLocations.configRoot, 'opencode.json'),
        '{"theme":"machine-b"}\n',
        'utf8'
      );
      await machineBService.push();

      useIsolatedHome(machineAHome);
      await machineAService.pull();
      await expect(
        fs.readFile(path.join(machineALocations.configRoot, 'opencode.json'), 'utf8')
      ).resolves.toContain('machine-b');

      useIsolatedHome(path.join(root, 'machine-c'));
      const machineCService = createSyncService({ client: createClient(), $: testShell });
      await expect(
        machineCService.init({ repo: remotePath, branch: 'sync/config' })
      ).rejects.toThrow('Use /sync-link <url> instead');

      useIsolatedHome(machineBHome);
      await expect(machineBService.enableSecrets()).rejects.toThrow('privacy cannot be verified');
      await expect(machineBService.enableSecrets({ acknowledgePrivateRemote: true })).resolves.toBe(
        'Secrets sync enabled for this repo.'
      );

      const state = await loadState(machineBLocations);
      expect(state.privateRemoteAcknowledgement?.remoteFingerprint).toMatch(/^[a-f0-9]{64}$/u);
      const acknowledgedConfig = await loadSyncConfig(machineBLocations);
      expect(acknowledgedConfig?.repo).toEqual({ url: remotePath, branch: 'sync/config' });

      if (!acknowledgedConfig) throw new Error('Expected machine B sync config.');
      await writeSyncConfig(machineBLocations, {
        ...acknowledgedConfig,
        repo: { url: replacementRemotePath, branch: 'sync/config' },
      });
      await expect(machineBService.enableSecrets()).rejects.toThrow('privacy cannot be verified');

      useIsolatedHome(path.join(root, 'machine-d'));
      const machineDService = createSyncService({ client: createClient(), $: testShell });
      await expect(
        machineDService.init({
          repo: replacementRemotePath,
          branch: 'sync/config',
          includeSessions: true,
        })
      ).rejects.toThrow('privacy cannot be verified');
      await expect(
        machineDService.init({
          repo: replacementRemotePath,
          branch: 'sync/config',
          includeSessions: true,
          acknowledgePrivateRemote: true,
        })
      ).resolves.toContain('opencode-synced configured');
    });
  }, 30_000);

  it('fails closed with recovery instructions for an oversized unpushed session commit', async () => {
    await withIsolatedEnvironment(async (root) => {
      const testShell = createTestShell();
      const remotePath = path.join(root, 'sync-remote.git');
      await testShell`git init --bare ${remotePath}`.quiet();

      const machineHome = path.join(root, 'machine');
      useIsolatedHome(machineHome);
      const locations = resolveSyncLocations();
      await fs.mkdir(locations.configRoot, { recursive: true });
      await fs.writeFile(path.join(locations.configRoot, 'opencode.json'), '{}\n');
      const service = createSyncService({ client: createClient(), $: testShell });
      await service.init({
        repo: remotePath,
        branch: 'main',
        includeSecrets: true,
        includeSessions: true,
        acknowledgePrivateRemote: true,
      });

      const config = await loadSyncConfig(locations);
      if (!config) throw new Error('Expected sync config.');
      const repoRoot = config.localRepoPath ?? locations.defaultRepoDir;
      const repoMessage = path.join(repoRoot, 'data', 'storage', 'message', 'failed.json');
      const localMessage = path.join(
        locations.xdg.dataDir,
        'opencode',
        'storage',
        'message',
        'failed.json'
      );
      await fs.mkdir(path.dirname(repoMessage), { recursive: true });
      await fs.mkdir(path.dirname(localMessage), { recursive: true });
      await fs.writeFile(repoMessage, '');
      await fs.truncate(repoMessage, 96 * 1024 * 1024);
      await fs.copyFile(repoMessage, localMessage);
      await testShell`git -C ${repoRoot} add -A`.quiet();
      await testShell`git -C ${repoRoot} commit -m ${'sync oversized session'}`.quiet();

      let message = '';
      try {
        await service.push();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/Push stopped:.*data\/storage\/message\/failed\.json/su);
      expect(message).toMatch(/git branch opencode-synced-oversized-backup-/u);
      expect(message).toMatch(/git reset --soft origin\/main/u);

      await testShell`git -C ${repoRoot} add -A`.quiet();
      await testShell`git -C ${repoRoot} commit -m ${'sync chunk representation'}`.quiet();
      await writeSyncConfig(locations, {
        ...config,
        sessionBackend: { type: 'turso' },
      });
      let cleanupMessage = '';
      try {
        await service.sessionsCleanupGit();
      } catch (error) {
        cleanupMessage = error instanceof Error ? error.message : String(error);
      }
      expect(cleanupMessage).toMatch(/Push stopped:.*data\/storage\/message\/failed\.json/su);
      expect(cleanupMessage).toContain(
        'The working tree has removed the deprecated Git session paths.'
      );
    });
  }, 30_000);
});
