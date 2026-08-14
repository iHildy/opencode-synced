import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  canCommitMcpSecrets,
  chmodIfExists,
  deepMerge,
  loadState,
  normalizeSyncConfig,
  parseJsonc,
  stripOverrides,
  writeJsonFile,
  writeState,
  writeSyncConfig,
} from './config.js';
import { resolveSyncLocations } from './paths.js';

describe('deepMerge', () => {
  it('merges nested objects and replaces arrays', () => {
    const base = { a: 1, nested: { x: 1, y: 2 }, list: [1] };
    const override = { b: 2, nested: { y: 3 }, list: [2] };

    const merged = deepMerge(base, override);

    expect(merged).toEqual({
      a: 1,
      b: 2,
      nested: { x: 1, y: 3 },
      list: [2],
    });
  });
});

describe('stripOverrides', () => {
  it('removes override keys and restores base values', () => {
    const base = {
      theme: 'opencode',
      provider: { openai: { apiKey: 'base', models: { tiny: true } } },
    };
    const overrides = {
      provider: { openai: { apiKey: 'local' } },
    };
    const local = deepMerge(base, overrides) as Record<string, unknown>;

    const stripped = stripOverrides(local, overrides, base);

    expect(stripped).toEqual(base);
  });

  it('drops override-only keys not present in base', () => {
    const base = { theme: 'opencode' };
    const overrides = { theme: 'local', editor: 'vim' };
    const local = { theme: 'local', editor: 'vim', other: true };

    const stripped = stripOverrides(local, overrides, base);

    expect(stripped).toEqual({ theme: 'opencode', other: true });
  });
});

describe('normalizeSyncConfig', () => {
  it('keeps all secret sync disabled', () => {
    const normalized = normalizeSyncConfig({
      includeSecrets: false,
      includeMcpSecrets: false,
    });
    expect(normalized.includeSecrets).toBe(false);
    expect(normalized.includeMcpSecrets).toBe(false);
  });

  it('rejects MCP secrets even when secrets are enabled', () => {
    expect(() =>
      normalizeSyncConfig({
        includeSecrets: true,
        includeMcpSecrets: true,
      })
    ).toThrow('not supported by this fork');
  });

  it('enables model favorites by default', () => {
    const normalized = normalizeSyncConfig({});
    expect(normalized.includeModelFavorites).toBe(true);
  });

  it('keeps extended sync features opt-in', () => {
    const normalized = normalizeSyncConfig({});

    expect(normalized.includeSkills).toBe(false);
    expect(normalized.includePromptHistory).toBe(false);
    expect(normalized.includePromptStash).toBe(false);
    expect(normalized.includeModelSelectors).toBe(false);
  });

  it('allows acknowledged plaintext prompt snapshots', () => {
    const normalized = normalizeSyncConfig({
      includePromptHistory: true,
      includePromptStash: true,
      acknowledgePlaintextPromptRisk: true,
    });

    expect(normalized.includePromptHistory).toBe(true);
    expect(normalized.includePromptStash).toBe(true);
    expect(normalized.acknowledgePlaintextPromptRisk).toBe(true);
  });

  it('rejects prompt sync without plaintext risk acknowledgement', () => {
    expect(() =>
      normalizeSyncConfig({
        includePromptHistory: true,
      })
    ).toThrow('acknowledgePlaintextPromptRisk');
  });

  it.each([
    { includeSecrets: true },
    { includeMcpSecrets: true },
    { includeSessions: true },
    { extraSecretPaths: ['/tmp/secret'] },
    { extraConfigPaths: ['/tmp/config'] },
    { localRepoPath: '/tmp/repo' },
  ])('rejects unsupported dangerous scope: %j', (input) => {
    expect(() => normalizeSyncConfig(input)).toThrow('not supported by this fork');
  });
});

describe('canCommitMcpSecrets', () => {
  it('never allows MCP secrets in the hardened fork', () => {
    expect(canCommitMcpSecrets({ includeSecrets: false, includeMcpSecrets: true })).toBe(false);
    expect(canCommitMcpSecrets({ includeSecrets: true, includeMcpSecrets: false })).toBe(false);
    expect(canCommitMcpSecrets({ includeSecrets: true, includeMcpSecrets: true })).toBe(false);
  });
});

describe('parseJsonc', () => {
  it('parses JSONC with comments and trailing commas', () => {
    const input = `{
      // comment
      "repo": {
        "owner": "me",
        "name": "opencode-config",
      },
      "includeSecrets": false,
      "extraSecretPaths": [
        "foo",
      ],
      "extraConfigPaths": [
        "bar",
      ],
    }`;

    expect(parseJsonc(input)).toEqual({
      repo: { owner: 'me', name: 'opencode-config' },
      includeSecrets: false,
      extraSecretPaths: ['foo'],
      extraConfigPaths: ['bar'],
    });
  });
});

describe('chmodIfExists', () => {
  it('ignores missing paths', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-sync-'));
    try {
      const missingPath = path.join(tempDir, 'missing.txt');
      await expect(chmodIfExists(missingPath, 0o600)).resolves.toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('secure local files', () => {
  it('writes sync config with owner-only permissions', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-sync-'));
    try {
      const locations = resolveSyncLocations({ HOME: tempDir } as NodeJS.ProcessEnv, 'linux');
      await writeSyncConfig(locations, {
        repo: { owner: 'me', name: 'config' },
        includeSkills: true,
      });

      expect((await lstat(locations.syncConfigPath)).mode & 0o777).toBe(0o600);
      expect((await lstat(path.dirname(locations.syncConfigPath))).mode & 0o777).toBe(0o700);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('merges state updates instead of erasing prior timestamps', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-sync-'));
    try {
      const locations = resolveSyncLocations({ HOME: tempDir } as NodeJS.ProcessEnv, 'linux');
      await writeState(locations, { lastPull: 'pull-time' });
      await writeState(locations, { lastPush: 'push-time' });

      expect(await loadState(locations)).toMatchObject({
        lastPull: 'pull-time',
        lastPush: 'push-time',
      });
      expect((await lstat(locations.statePath)).mode & 0o777).toBe(0o600);
      expect((await lstat(path.dirname(locations.statePath))).mode & 0o777).toBe(0o700);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses to replace a symlink with generated JSON', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-sync-'));
    try {
      const outside = path.join(tempDir, 'outside.json');
      const targetDir = path.join(tempDir, 'config');
      const target = path.join(targetDir, 'state.json');
      await mkdir(targetDir, { recursive: true });
      await writeFile(outside, '{"keep":true}\n');
      await symlink(outside, target);

      await expect(writeJsonFile(target, { replace: true })).rejects.toThrow('symlink');
      expect(await readFile(outside, 'utf8')).toBe('{"keep":true}\n');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
