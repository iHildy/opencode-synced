import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SyncConfig } from './config.js';
import { buildSyncPlan, resolveSyncLocations, resolveXdgPaths } from './paths.js';

describe('resolveXdgPaths', () => {
  it('resolves linux defaults', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const paths = resolveXdgPaths(env, 'linux');

    expect(paths.configDir).toBe(path.join('/home/test', '.config'));
    expect(paths.dataDir).toBe(path.join('/home/test', '.local', 'share'));
  });

  it('resolves windows defaults', () => {
    const env = {
      USERPROFILE: 'C:\\Users\\Test',
      APPDATA: 'C:\\Users\\Test\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
    } as NodeJS.ProcessEnv;
    const paths = resolveXdgPaths(env, 'win32');

    expect(paths.configDir).toBe('C:\\Users\\Test\\.config');
    expect(paths.dataDir).toBe('C:\\Users\\Test\\.local\\share');
    expect(paths.stateDir).toBe('C:\\Users\\Test\\.local\\state');
  });
});

describe('resolveSyncLocations', () => {
  it('respects the OpenCode uppercase config directory flag', () => {
    const env = {
      HOME: '/home/test',
      OPENCODE_CONFIG_DIR: '/official/opencode',
    } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');

    expect(locations.configRoot).toBe(path.resolve('/official/opencode'));
  });

  it('respects opencode_config_dir', () => {
    const env = {
      HOME: '/home/test',
      opencode_config_dir: '/custom/opencode',
    } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');

    expect(locations.configRoot).toBe(path.resolve('/custom/opencode'));
    expect(locations.syncConfigPath).toBe(
      path.join(path.resolve('/custom/opencode'), 'opencode-synced.jsonc')
    );
    expect(locations.overridesPath).toBe(
      path.join(path.resolve('/custom/opencode'), 'opencode-synced.overrides.jsonc')
    );
  });
});

describe('buildSyncPlan', () => {
  it('tracks redirected XDG roots instead of assuming everything is under HOME', () => {
    const env = {
      HOME: '/home/test',
      XDG_CONFIG_HOME: '/mnt/config',
      XDG_STATE_HOME: '/mnt/state',
    } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const plan = buildSyncPlan(
      { repo: { owner: 'acme', name: 'config' }, includeModelFavorites: true },
      locations,
      '/repo',
      'linux'
    );

    expect(plan.localRoots).toEqual([
      path.join('/mnt/config', 'opencode'),
      path.join('/mnt/state', 'opencode'),
    ]);
  });

  it('excludes secrets and arbitrary extra paths', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: false,
      extraSecretPaths: [],
      extraConfigPaths: [],
    };

    const plan = buildSyncPlan(config, locations, '/repo', 'linux');
    const secretItems = plan.items.filter((item) => item.isSecret);

    expect(secretItems.length).toBe(0);
  });

  it('rejects secrets and arbitrary extra paths', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: true,
      extraSecretPaths: ['/home/test/.ssh/id_rsa'],
      extraConfigPaths: ['/home/test/.config/opencode/custom.json'],
    };

    expect(() => buildSyncPlan(config, locations, '/repo', 'linux')).toThrow(
      'not supported by this fork'
    );
  });

  it('includes model favorites by default and allows disabling', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: false,
    };

    const plan = buildSyncPlan(config, locations, '/repo', 'linux');
    const favoritesItem = plan.items.find((item) =>
      item.localPath.endsWith(path.join('.local', 'state', 'opencode', 'model.json'))
    );

    expect(favoritesItem).toBeTruthy();

    const disabledPlan = buildSyncPlan(
      { ...config, includeModelFavorites: false },
      locations,
      '/repo',
      'linux'
    );
    const disabledItem = disabledPlan.items.find((item) =>
      item.localPath.endsWith(path.join('.local', 'state', 'opencode', 'model.json'))
    );

    expect(disabledItem).toBeUndefined();
  });

  it('adds skills only when explicitly enabled', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const base: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: false,
    };

    const disabled = buildSyncPlan(base, locations, '/repo', 'linux');
    expect(disabled.items.some((item) => item.localPath.endsWith('skills'))).toBe(false);

    const enabled = buildSyncPlan({ ...base, includeSkills: true }, locations, '/repo', 'linux');
    const skills = enabled.items.find((item) => item.localPath.endsWith('skills'));

    expect(skills).toMatchObject({
      repoPath: path.join('/repo', 'config', 'skills'),
      type: 'dir',
      strategy: 'skills',
    });
  });

  it('adds prompt snapshots independently of auth secrets', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: false,
      includePromptHistory: true,
      includePromptStash: true,
      acknowledgePlaintextPromptRisk: true,
    };

    const plan = buildSyncPlan(config, locations, '/repo', 'linux');
    const promptItems = plan.items.filter((item) => item.strategy === 'prompt-snapshot');

    expect(promptItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          localPath: path.join('/home/test', '.local', 'state', 'opencode', 'prompt-history.jsonl'),
          repoPath: path.join('/repo', 'state', 'prompts', 'prompt-history.jsonl'),
          isSecret: true,
        }),
        expect.objectContaining({
          localPath: path.join('/home/test', '.local', 'state', 'opencode', 'prompt-stash.jsonl'),
          repoPath: path.join('/repo', 'state', 'prompts', 'prompt-stash.jsonl'),
          isSecret: true,
        }),
      ])
    );

    expect(plan.items.some((item) => item.localPath.endsWith('auth.json'))).toBe(false);
    expect(plan.items.some((item) => item.localPath.endsWith('mcp-auth.json'))).toBe(false);
  });

  it('adds portable model selector files when enabled', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeModelSelectors: true,
    };

    const plan = buildSyncPlan(config, locations, '/repo', 'linux');
    const selectors = plan.items.filter((item) => item.strategy === 'model-selector');

    expect(selectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          localPath: path.join('/home/test', '.config', 'opencode', 'main-model.txt'),
          repoPath: path.join('/repo', 'state', 'model-selectors', 'main-model.txt'),
        }),
        expect.objectContaining({
          localPath: path.join('/home/test', '.config', 'opencode', 'cheap-model.txt'),
          repoPath: path.join('/repo', 'state', 'model-selectors', 'cheap-model.txt'),
        }),
        expect.objectContaining({
          localPath: path.join('/home/test', '.config', 'opencode', 'frontier-model.txt'),
          repoPath: path.join('/repo', 'state', 'model-selectors', 'frontier-model.txt'),
        }),
      ])
    );
  });

  it('marks model favorites for projection instead of raw file replacement', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const plan = buildSyncPlan(
      { repo: { owner: 'acme', name: 'config' }, includeModelFavorites: true },
      locations,
      '/repo',
      'linux'
    );

    const favorites = plan.items.find((item) => item.localPath.endsWith('model.json'));
    expect(favorites?.strategy).toBe('model-favorites');
    expect(favorites?.repoPath).toBe(path.join('/repo', 'state', 'model-favorites.json'));
  });
});
