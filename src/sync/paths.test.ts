import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { SyncConfig } from './config.js';
import { normalizeSyncConfig } from './config.js';
import {
  buildSyncPlan,
  expandHome,
  normalizePath,
  resolveExtraPath,
  resolveHomeDir,
  resolveRepoRoot,
  resolveSyncLocations,
  resolveXdgPaths,
} from './paths.js';

describe('resolveHomeDir', () => {
  it('uses USERPROFILE as the Windows home', () => {
    const env = {
      USERPROFILE: 'C:\\Users\\Test',
      HOME: 'D:\\legacy-home',
      HOMEDRIVE: 'E:',
      HOMEPATH: '\\fallback-home',
    } as NodeJS.ProcessEnv;

    expect(resolveHomeDir(env, 'win32')).toBe('C:\\Users\\Test');
  });
});

describe('resolveXdgPaths', () => {
  it('resolves linux defaults', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const paths = resolveXdgPaths(env, 'linux');

    expect(paths.configDir).toBe('/home/test/.config');
    expect(paths.dataDir).toBe('/home/test/.local/share');
  });

  it('resolves windows defaults', () => {
    const env = {
      USERPROFILE: 'C:\\Users\\Test',
      APPDATA: 'C:\\Users\\Test\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
    } as NodeJS.ProcessEnv;
    const paths = resolveXdgPaths(env, 'win32');

    expect(paths).toEqual({
      homeDir: 'C:\\Users\\Test',
      configDir: 'C:\\Users\\Test\\.config',
      dataDir: 'C:\\Users\\Test\\.local\\share',
      stateDir: 'C:\\Users\\Test\\.local\\state',
    });
  });

  it('preserves explicit XDG overrides on Windows', () => {
    const env = {
      USERPROFILE: 'C:\\Users\\Test',
      XDG_CONFIG_HOME: 'D:\\xdg\\config',
      XDG_DATA_HOME: 'E:\\xdg\\data',
      XDG_STATE_HOME: 'F:\\xdg\\state',
    } as NodeJS.ProcessEnv;

    expect(resolveXdgPaths(env, 'win32')).toEqual({
      homeDir: 'C:\\Users\\Test',
      configDir: 'D:\\xdg\\config',
      dataDir: 'E:\\xdg\\data',
      stateDir: 'F:\\xdg\\state',
    });
  });
});

describe('resolveSyncLocations', () => {
  it('respects opencode_config_dir', () => {
    const env = {
      HOME: '/home/test',
      opencode_config_dir: '/custom/opencode',
    } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');

    expect(locations.configRoot).toBe('/custom/opencode');
    expect(locations.syncConfigPath).toBe('/custom/opencode/opencode-synced.jsonc');
    expect(locations.overridesPath).toBe('/custom/opencode/opencode-synced.overrides.jsonc');
  });

  it('uses exact Windows semantics for every modeled OpenCode location', () => {
    const env = {
      USERPROFILE: 'C:\\Users\\Test',
      APPDATA: 'C:\\Users\\Test\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
    } as NodeJS.ProcessEnv;

    const locations = resolveSyncLocations(env, 'win32');

    expect(locations).toEqual({
      xdg: {
        homeDir: 'C:\\Users\\Test',
        configDir: 'C:\\Users\\Test\\.config',
        dataDir: 'C:\\Users\\Test\\.local\\share',
        stateDir: 'C:\\Users\\Test\\.local\\state',
      },
      configRoot: 'C:\\Users\\Test\\.config\\opencode',
      syncConfigPath: 'C:\\Users\\Test\\.config\\opencode\\opencode-synced.jsonc',
      overridesPath: 'C:\\Users\\Test\\.config\\opencode\\opencode-synced.overrides.jsonc',
      statePath: 'C:\\Users\\Test\\.local\\share\\opencode\\sync-state.json',
      defaultRepoDir: 'C:\\Users\\Test\\.local\\share\\opencode\\opencode-synced\\repo',
    });
  });
});

describe('Windows path semantics', () => {
  const env = { USERPROFILE: 'C:\\Users\\Test' } as NodeJS.ProcessEnv;
  const locations = resolveSyncLocations(env, 'win32');

  it('expands and normalizes Windows paths without host-platform leakage', () => {
    expect(expandHome('~/shared/config.json', locations.xdg.homeDir, 'win32')).toBe(
      'C:\\Users\\Test\\shared\\config.json'
    );
    expect(normalizePath('C:\\Users\\Test\\.CONFIG\\OpenCode', '', 'win32')).toBe(
      'c:\\users\\test\\.config\\opencode'
    );
    expect(
      resolveRepoRoot(
        { repo: { owner: 'acme', name: 'config' }, localRepoPath: '~/sync-repo' },
        locations,
        'win32'
      )
    ).toBe('C:\\Users\\Test\\sync-repo');
  });

  it('builds config, data, state, and repository paths with Windows separators', () => {
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: true,
      includeSessions: true,
      includePromptStash: true,
      extraSecretPaths: ['C:\\Users\\Test\\private\\token.json'],
    };

    const plan = buildSyncPlan(normalizeSyncConfig(config), locations, 'C:\\sync-repo', 'win32');

    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          localPath: 'C:\\Users\\Test\\.config\\opencode\\opencode.json',
          repoPath: 'C:\\sync-repo\\config\\opencode.json',
        }),
        expect.objectContaining({
          localPath: 'C:\\Users\\Test\\.local\\share\\opencode\\auth.json',
          repoPath: 'C:\\sync-repo\\data\\auth.json',
        }),
        expect.objectContaining({
          localPath: 'C:\\Users\\Test\\.local\\share\\opencode\\opencode.db',
          repoPath: 'C:\\sync-repo\\data\\opencode.db',
        }),
        expect.objectContaining({
          localPath: 'C:\\Users\\Test\\.local\\state\\opencode\\model.json',
          repoPath: 'C:\\sync-repo\\state\\model.json',
        }),
      ])
    );
    expect(plan.extraSecrets.allowlist).toEqual(['c:\\users\\test\\private\\token.json']);
    expect(plan.extraSecrets.manifestPath).toBe('C:\\sync-repo\\secrets\\extra-manifest.json');
    expect(
      plan.extraSecrets.entries[0]?.repoPath.startsWith('C:\\sync-repo\\secrets\\extra\\')
    ).toBe(true);
  });
});

describe('buildSyncPlan', () => {
  it('excludes secrets when includeSecrets is false', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: false,
      extraSecretPaths: ['/home/test/.ssh/id_rsa'],
      extraConfigPaths: ['/home/test/.config/opencode/custom.json'],
    };

    const plan = buildSyncPlan(normalizeSyncConfig(config), locations, '/repo', 'linux');
    const secretItems = plan.items.filter((item) => item.isSecret);

    expect(secretItems.length).toBe(0);
    expect(plan.extraSecrets.allowlist.length).toBe(0);
    expect(plan.extraConfigs.allowlist.length).toBe(1);
  });

  it('includes opencode-synced config file in items', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: false,
    };

    const plan = buildSyncPlan(normalizeSyncConfig(config), locations, '/repo', 'linux');
    const syncItem = plan.items.find((item) => item.localPath === locations.syncConfigPath);

    expect(syncItem).toBeTruthy();
  });

  it('filters sync config from extra config paths', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: false,
      extraConfigPaths: [locations.syncConfigPath],
    };

    const plan = buildSyncPlan(normalizeSyncConfig(config), locations, '/repo', 'linux');

    expect(plan.extraConfigs.allowlist.length).toBe(0);
  });

  it('filters default sync items from extra config paths', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const customConfigPath = `${locations.configRoot}/custom.json`;
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: false,
      extraConfigPaths: [
        `${locations.configRoot}/agent`,
        `${locations.configRoot}/agents`,
        `${locations.configRoot}/commands`,
        `${locations.configRoot}/modes`,
        `${locations.configRoot}/tools`,
        `${locations.configRoot}/plugins`,
        `${locations.configRoot}/opencode.json`,
        customConfigPath,
      ],
    };

    const plan = buildSyncPlan(normalizeSyncConfig(config), locations, '/repo', 'linux');

    expect(plan.extraConfigs.allowlist).toEqual([customConfigPath]);
  });

  it('resolves relative extra config and secret paths from the opencode config root', async () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const unrelatedCwd = await fs.mkdtemp(path.join(tmpdir(), 'opencode-sync-cwd-'));
    const originalCwd = process.cwd();
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: true,
      extraConfigPaths: ['SOUL.md', 'commands/custom'],
      extraSecretPaths: ['credentials/token.json', 'private-agents'],
    };

    try {
      process.chdir(unrelatedCwd);
      const plan = buildSyncPlan(normalizeSyncConfig(config), locations, '/repo', 'linux');

      expect(plan.extraConfigs.allowlist).toEqual([
        '/home/test/.config/opencode/SOUL.md',
        '/home/test/.config/opencode/commands/custom',
      ]);
      expect(plan.extraSecrets.allowlist).toEqual([
        '/home/test/.config/opencode/credentials/token.json',
        '/home/test/.config/opencode/private-agents',
      ]);
    } finally {
      process.chdir(originalCwd);
      await fs.rm(unrelatedCwd, { recursive: true, force: true });
    }
  });

  it('keeps home-relative and absolute extra path behavior', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: true,
      extraConfigPaths: ['~/shared/config.json', '/opt/opencode/config.json'],
      extraSecretPaths: ['~/.ssh/id_rsa', '/run/secrets/opencode'],
    };

    const plan = buildSyncPlan(normalizeSyncConfig(config), locations, '/repo', 'linux');

    expect(plan.extraConfigs.allowlist).toEqual([
      '/home/test/shared/config.json',
      '/opt/opencode/config.json',
    ]);
    expect(plan.extraSecrets.allowlist).toEqual([
      '/home/test/.ssh/id_rsa',
      '/run/secrets/opencode',
    ]);
  });

  it('uses the XDG opencode root for relative paths when a custom config dir is set', () => {
    const env = {
      HOME: '/home/test',
      XDG_CONFIG_HOME: '/srv/xdg-config',
      opencode_config_dir: '/custom/opencode',
    } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');

    expect(resolveExtraPath('custom.json', locations, 'linux')).toBe(
      '/srv/xdg-config/opencode/custom.json'
    );
  });

  it('deduplicates relative paths that are already default sync items', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: false,
      extraConfigPaths: ['agent', 'opencode.json', 'skills', '~/.agents', 'custom.json'],
    };

    const plan = buildSyncPlan(normalizeSyncConfig(config), locations, '/repo', 'linux');

    expect(plan.extraConfigs.allowlist).toEqual(['/home/test/.config/opencode/custom.json']);
  });

  it('includes canonical plural and legacy singular config directories exactly once', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: false,
      includeOpencodeSkills: false,
      includeAgentsDir: false,
    };

    const plan = buildSyncPlan(normalizeSyncConfig(config), locations, '/repo', 'linux');
    const directoryNames = plan.items
      .filter((item) => item.type === 'dir' && item.localPath.startsWith(locations.configRoot))
      .map((item) => item.localPath.slice(locations.configRoot.length + 1));

    expect(directoryNames).toEqual([
      'agent',
      'agents',
      'command',
      'commands',
      'mode',
      'modes',
      'tool',
      'tools',
      'themes',
      'plugin',
      'plugins',
    ]);
    expect(new Set(plan.items.map((item) => item.localPath)).size).toBe(plan.items.length);
    expect(new Set(plan.items.map((item) => item.repoPath)).size).toBe(plan.items.length);
  });

  it('uses Windows path semantics for relative, home-relative, and absolute entries', () => {
    const env = {
      USERPROFILE: 'C:\\Users\\Test',
      APPDATA: 'C:\\Users\\Test\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
    } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'win32');

    expect(resolveExtraPath('commands\\custom.md', locations, 'win32')).toBe(
      'c:\\users\\test\\.config\\opencode\\commands\\custom.md'
    );
    expect(resolveExtraPath('~/shared/config.json', locations, 'win32')).toBe(
      'c:\\users\\test\\shared\\config.json'
    );
    expect(resolveExtraPath('D:\\opencode\\config.json', locations, 'win32')).toBe(
      'd:\\opencode\\config.json'
    );
  });

  it('filters plural defaults from extra config paths case-insensitively on Windows', () => {
    const env = {
      USERPROFILE: 'C:\\Users\\Test',
      APPDATA: 'C:\\Users\\Test\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
    } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'win32');
    const pluralAgentsPath = `${locations.configRoot}/agents`;
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: false,
      extraConfigPaths: [pluralAgentsPath.toUpperCase()],
    };

    const plan = buildSyncPlan(normalizeSyncConfig(config), locations, 'C:\\repo', 'win32');

    expect(plan.extraConfigs.allowlist).toEqual([]);
  });

  it('keeps traversing relative paths exact and their repository paths contained', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: false,
      extraConfigPaths: ['../shared/config.json'],
    };

    const plan = buildSyncPlan(normalizeSyncConfig(config), locations, '/repo', 'linux');
    const entry = plan.extraConfigs.entries[0];

    expect(plan.extraConfigs.allowlist).toEqual(['/home/test/.config/shared/config.json']);
    expect(entry?.sourcePath).toBe('/home/test/.config/shared/config.json');
    expect(entry?.repoPath.startsWith('/repo/config/extra/')).toBe(true);
    expect(path.relative('/repo/config/extra', entry?.repoPath ?? '').startsWith('..')).toBe(false);
  });

  it('includes skills directory in default sync items', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: false,
    };

    const plan = buildSyncPlan(normalizeSyncConfig(config), locations, '/repo', 'linux');
    const skillsItem = plan.items.find((item) =>
      item.localPath.endsWith('/.config/opencode/skills')
    );

    expect(skillsItem).toBeTruthy();
    expect(skillsItem?.type).toBe('dir');

    const disabledPlan = buildSyncPlan(
      normalizeSyncConfig({ ...config, includeOpencodeSkills: false }),
      locations,
      '/repo',
      'linux'
    );
    const disabledSkillsItem = disabledPlan.items.find((item) =>
      item.localPath.endsWith('/.config/opencode/skills')
    );
    expect(disabledSkillsItem).toBeUndefined();
  });

  it('filters skills path from extra config paths', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: false,
      extraConfigPaths: [`${locations.configRoot}/skills`],
    };

    const plan = buildSyncPlan(normalizeSyncConfig(config), locations, '/repo', 'linux');

    expect(plan.extraConfigs.allowlist.length).toBe(0);
  });

  it('keeps non-default extra config paths when skills is also listed', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const customConfigPath = `${locations.configRoot}/custom.json`;
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: false,
      extraConfigPaths: [`${locations.configRoot}/skills`, customConfigPath],
    };

    const plan = buildSyncPlan(normalizeSyncConfig(config), locations, '/repo', 'linux');

    expect(plan.extraConfigs.allowlist).toEqual([customConfigPath]);
  });

  it('includes home .agents directory by default and allows disabling', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: false,
    };

    const plan = buildSyncPlan(normalizeSyncConfig(config), locations, '/repo', 'linux');
    const agentsItem = plan.items.find((item) => item.localPath.endsWith('/.agents'));

    expect(agentsItem).toBeTruthy();
    expect(agentsItem?.repoPath.endsWith('/config/.agents')).toBe(true);
    expect(agentsItem?.type).toBe('dir');

    const disabledPlan = buildSyncPlan(
      normalizeSyncConfig({ ...config, includeAgentsDir: false }),
      locations,
      '/repo',
      'linux'
    );
    const disabledAgentsItem = disabledPlan.items.find((item) =>
      item.localPath.endsWith('/.agents')
    );
    expect(disabledAgentsItem).toBeUndefined();
  });

  it('filters home .agents path from extra config paths', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: false,
      extraConfigPaths: ['~/.agents'],
    };

    const plan = buildSyncPlan(normalizeSyncConfig(config), locations, '/repo', 'linux');
    expect(plan.extraConfigs.allowlist.length).toBe(0);
  });

  it('keeps non-default extra config paths when home .agents is also listed', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const customConfigPath = `${locations.configRoot}/custom.json`;
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: false,
      extraConfigPaths: ['~/.agents', customConfigPath],
    };

    const plan = buildSyncPlan(normalizeSyncConfig(config), locations, '/repo', 'linux');
    expect(plan.extraConfigs.allowlist).toEqual([customConfigPath]);
  });

  it('includes secrets when includeSecrets is true', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: true,
      extraSecretPaths: ['/home/test/.ssh/id_rsa'],
      extraConfigPaths: ['/home/test/.config/opencode/custom.json'],
    };

    const plan = buildSyncPlan(normalizeSyncConfig(config), locations, '/repo', 'linux');
    const secretItems = plan.items.filter((item) => item.isSecret);

    expect(secretItems.length).toBe(2);
    expect(plan.extraSecrets.allowlist.length).toBe(1);
    expect(plan.extraConfigs.allowlist.length).toBe(1);
  });

  it('includes sqlite and legacy session paths when includeSessions is true', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: true,
      includeSessions: true,
    };

    const plan = buildSyncPlan(normalizeSyncConfig(config), locations, '/repo', 'linux');
    const expectedSessionPaths = [
      '/.local/share/opencode/opencode.db',
      '/.local/share/opencode/storage/session',
      '/.local/share/opencode/storage/message',
      '/.local/share/opencode/storage/part',
      '/.local/share/opencode/storage/session_diff',
    ];

    for (const suffix of expectedSessionPaths) {
      const sessionItem = plan.items.find((item) => item.localPath.endsWith(suffix));
      expect(sessionItem).toBeTruthy();
      expect(sessionItem?.isSecret).toBe(true);
      expect(sessionItem?.preserveWhenMissing).toBe(true);
    }
  });

  it('excludes git session paths when using turso session backend', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: true,
      includeSessions: true,
      sessionBackend: {
        type: 'turso',
      },
    };

    const plan = buildSyncPlan(normalizeSyncConfig(config), locations, '/repo', 'linux');
    const sessionItems = plan.items.filter(
      (item) =>
        item.localPath.endsWith('/.local/share/opencode/opencode.db') ||
        item.localPath.includes('/.local/share/opencode/storage/session') ||
        item.localPath.includes('/.local/share/opencode/storage/message') ||
        item.localPath.includes('/.local/share/opencode/storage/part') ||
        item.localPath.includes('/.local/share/opencode/storage/session_diff')
    );

    expect(sessionItems).toEqual([]);
  });

  it('excludes auth files when using 1password backend', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: true,
      secretsBackend: {
        type: '1password',
        vault: 'Personal',
        documents: {
          authJson: 'opencode-auth.json',
          mcpAuthJson: 'opencode-mcp-auth.json',
        },
      },
    };

    const plan = buildSyncPlan(normalizeSyncConfig(config), locations, '/repo', 'linux');

    const authItem = plan.items.find((item) =>
      item.localPath.endsWith('/.local/share/opencode/auth.json')
    );
    const mcpItem = plan.items.find((item) =>
      item.localPath.endsWith('/.local/share/opencode/mcp-auth.json')
    );

    expect(authItem).toBeUndefined();
    expect(mcpItem).toBeUndefined();
  });

  it('includes model favorites by default and allows disabling', () => {
    const env = { HOME: '/home/test' } as NodeJS.ProcessEnv;
    const locations = resolveSyncLocations(env, 'linux');
    const config: SyncConfig = {
      repo: { owner: 'acme', name: 'config' },
      includeSecrets: false,
    };

    const plan = buildSyncPlan(normalizeSyncConfig(config), locations, '/repo', 'linux');
    const favoritesItem = plan.items.find((item) =>
      item.localPath.endsWith('/.local/state/opencode/model.json')
    );

    expect(favoritesItem).toBeTruthy();

    const disabledPlan = buildSyncPlan(
      normalizeSyncConfig({ ...config, includeModelFavorites: false }),
      locations,
      '/repo',
      'linux'
    );
    const disabledItem = disabledPlan.items.find((item) =>
      item.localPath.endsWith('/.local/state/opencode/model.json')
    );

    expect(disabledItem).toBeUndefined();
  });
});
