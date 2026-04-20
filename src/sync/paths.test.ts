import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { SyncConfig } from './config.js';
import { normalizeSyncConfig } from './config.js';
import {
  buildSyncPlan,
  fromPortablePath,
  resolveSyncLocations,
  resolveXdgPaths,
  toPortablePath,
} from './paths.js';

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

    expect(paths.configDir).toBe('C:\\Users\\Test\\AppData\\Roaming');
    expect(paths.dataDir).toBe('C:\\Users\\Test\\AppData\\Local');
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
        `${locations.configRoot}/opencode.json`,
        customConfigPath,
      ],
    };

    const plan = buildSyncPlan(normalizeSyncConfig(config), locations, '/repo', 'linux');

    expect(plan.extraConfigs.allowlist).toEqual([customConfigPath]);
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

describe('toPortablePath', () => {
  it('converts configRoot-absolute path to relative', () => {
    const configRoot = '/home/test/.config/opencode';
    const homeDir = '/home/test';
    const result = toPortablePath('/home/test/.config/opencode/tui.json', configRoot, homeDir);
    expect(result).toBe('tui.json');
  });

  it('converts nested configRoot path to relative', () => {
    const configRoot = '/home/test/.config/opencode';
    const homeDir = '/home/test';
    const result = toPortablePath(
      '/home/test/.config/opencode/sub/plugin.json',
      configRoot,
      homeDir
    );
    expect(result).toBe(path.join('sub', 'plugin.json'));
  });

  it('converts path outside configRoot but inside homeDir to ~/ prefix', () => {
    const configRoot = '/home/test/.config/opencode';
    const homeDir = '/home/test';
    const result = toPortablePath('/home/test/.ssh/id_rsa', configRoot, homeDir);
    expect(result).toBe('~/.ssh/id_rsa');
  });

  it('keeps absolute path if outside both configRoot and homeDir', () => {
    const configRoot = '/home/test/.config/opencode';
    const homeDir = '/home/test';
    const result = toPortablePath('/opt/some/config.json', configRoot, homeDir);
    expect(result).toBe('/opt/some/config.json');
  });

  it('handles homeDir itself as ~', () => {
    const configRoot = '/home/test/.config/opencode';
    const homeDir = '/home/test';
    const result = toPortablePath('/home/test', configRoot, homeDir);
    expect(result).toBe('~');
  });
});

describe('fromPortablePath', () => {
  it('resolves relative path against configRoot', () => {
    const configRoot = '/home/test/.config/opencode';
    const homeDir = '/home/test';
    const result = fromPortablePath('tui.json', configRoot, homeDir);
    expect(result).toBe('/home/test/.config/opencode/tui.json');
  });

  it('resolves nested relative path against configRoot', () => {
    const configRoot = '/home/test/.config/opencode';
    const homeDir = '/home/test';
    const result = fromPortablePath(path.join('sub', 'plugin.json'), configRoot, homeDir);
    expect(result).toBe(path.join('/home/test/.config/opencode', 'sub', 'plugin.json'));
  });

  it('expands ~/ to homeDir', () => {
    const configRoot = '/home/test/.config/opencode';
    const homeDir = '/home/test';
    const result = fromPortablePath('~/.ssh/id_rsa', configRoot, homeDir);
    expect(result).toBe('/home/test/.ssh/id_rsa');
  });

  it('expands ~ to homeDir', () => {
    const configRoot = '/home/test/.config/opencode';
    const homeDir = '/home/test';
    const result = fromPortablePath('~', configRoot, homeDir);
    expect(result).toBe('/home/test');
  });

  it('keeps absolute path as-is (backwards compat)', () => {
    const configRoot = '/home/test/.config/opencode';
    const homeDir = '/home/test';
    const result = fromPortablePath(
      '/Users/khangnghiem/.config/opencode/tui.json',
      configRoot,
      homeDir
    );
    expect(result).toBe('/Users/khangnghiem/.config/opencode/tui.json');
  });

  it('round-trips configRoot path correctly', () => {
    const configRoot = '/home/test/.config/opencode';
    const homeDir = '/home/test';
    const original = '/home/test/.config/opencode/tui.json';
    const portable = toPortablePath(original, configRoot, homeDir);
    const restored = fromPortablePath(portable, configRoot, homeDir);
    expect(restored).toBe(original);
  });

  it('round-trips homeDir path correctly', () => {
    const configRoot = '/home/test/.config/opencode';
    const homeDir = '/home/test';
    const original = '/home/test/.ssh/id_rsa';
    const portable = toPortablePath(original, configRoot, homeDir);
    const restored = fromPortablePath(portable, configRoot, homeDir);
    expect(restored).toBe(original);
  });

  it('round-trips across different machines (macOS push, Linux pull)', () => {
    // Push on macOS
    const macConfigRoot = '/Users/khangnghiem/.config/opencode';
    const macHomeDir = '/Users/khangnghiem';
    const macPath = '/Users/khangnghiem/.config/opencode/tui.json';
    const portable = toPortablePath(macPath, macConfigRoot, macHomeDir);
    expect(portable).toBe('tui.json');

    // Pull on Linux
    const linuxConfigRoot = '/home/linuxuser/.config/opencode';
    const linuxHomeDir = '/home/linuxuser';
    const linuxPath = fromPortablePath(portable, linuxConfigRoot, linuxHomeDir);
    expect(linuxPath).toBe('/home/linuxuser/.config/opencode/tui.json');
  });

  it('round-trips across different machines with ~/ path (macOS push, Windows pull)', () => {
    // Push on macOS (path outside configRoot, inside homeDir)
    const macConfigRoot = '/Users/khangnghiem/.config/opencode';
    const macHomeDir = '/Users/khangnghiem';
    const macPath = '/Users/khangnghiem/.ssh/id_rsa';
    const portable = toPortablePath(macPath, macConfigRoot, macHomeDir);
    expect(portable).toBe('~/.ssh/id_rsa');

    // Pull on Windows (~/ expands to local USERPROFILE)
    const winConfigRoot = 'C:\\Users\\test\\AppData\\Roaming\\opencode';
    const winHomeDir = 'C:\\Users\\test';
    const winPath = fromPortablePath(portable, winConfigRoot, winHomeDir);
    expect(winPath).toBe(path.join('C:\\Users\\test', '.ssh', 'id_rsa'));
  });
});
