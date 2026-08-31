import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { PluginInput } from '@opencode-ai/plugin';
import type { Config } from '@opencode-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@opencode-ai/plugin', () => {
  const createSchemaChain = (): Record<string, () => unknown> => {
    const chain = {
      describe: () => chain,
      optional: () => chain,
    };
    return chain;
  };
  return {
    tool: Object.assign(<T>(definition: T): T => definition, {
      schema: {
        enum: () => createSchemaChain(),
        string: () => createSchemaChain(),
        boolean: () => createSchemaChain(),
        array: () => createSchemaChain(),
      },
    }),
  };
});

import { opencodeConfigSync } from './index.js';
import { syncLocalToRepo } from './sync/apply.js';
import { normalizeSyncConfig, parseJsonc } from './sync/config.js';
import { buildSyncPlan, resolveSyncLocations } from './sync/paths.js';

const ENV_KEYS = [
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'PR47_GITHUB_PAT',
  'MISSING_PAT',
] as const;

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function createPluginInput(logs: unknown[]): PluginInput {
  return {
    $: (() => {
      throw new Error('Shell execution is not expected in config-hook tests.');
    }) as unknown as PluginInput['$'],
    client: {
      app: { log: async (entry: unknown) => logs.push(entry) },
      config: { get: async () => ({ data: {} }) },
      session: {
        create: async () => ({ data: null }),
        delete: async () => ({}),
        prompt: async () => ({ data: null }),
        status: async () => ({ data: {} }),
      },
      tui: { showToast: async () => ({}) },
    } as unknown as PluginInput['client'],
  } as PluginInput;
}

async function withIsolatedPluginHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const original = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  const homeDir = await fs.mkdtemp(path.join(tmpdir(), 'opencode-sync-plugin-'));
  process.env.HOME = homeDir;
  process.env.XDG_CONFIG_HOME = path.join(homeDir, 'config');
  process.env.XDG_DATA_HOME = path.join(homeDir, 'data');
  process.env.XDG_STATE_HOME = path.join(homeDir, 'state');

  try {
    await run(homeDir);
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

describe('opencode plugin config hook', () => {
  it('resolves a local placeholder at runtime without exposing it to the synced repo or logs', async () => {
    await withIsolatedPluginHome(async (homeDir) => {
      vi.useFakeTimers();
      const locations = resolveSyncLocations();
      const repoRoot = path.join(homeDir, 'sync-repo');
      const localConfigPath = path.join(locations.configRoot, 'opencode.json');
      const repoConfigPath = path.join(repoRoot, 'config', 'opencode.json');
      const secret = 'runtime-only-secret-sentinel';
      await fs.mkdir(locations.configRoot, { recursive: true });
      await fs.writeFile(
        localConfigPath,
        JSON.stringify({
          mcp: {
            github: {
              type: 'remote',
              url: 'https://example.test/mcp',
              enabled: true,
              headers: { Authorization: `Bearer ${secret}` },
            },
          },
        }),
        'utf8'
      );
      const syncConfig = normalizeSyncConfig({
        repo: { owner: 'acme', name: 'config' },
        includeOpencodeSkills: false,
        includeAgentsDir: false,
        includeModelFavorites: false,
      });
      const plan = buildSyncPlan(syncConfig, locations, repoRoot, 'linux');
      await syncLocalToRepo(plan, null, { overridesPath: locations.overridesPath });

      await fs.writeFile(
        locations.overridesPath,
        `{
          // Parsed after OpenCode's file-level environment substitution.
          "mcp": {
            "github": {
              "headers": { "Authorization": "Bearer {env:PR47_GITHUB_PAT}" },
            },
          },
        }\n`,
        'utf8'
      );
      process.env.PR47_GITHUB_PAT = secret;
      const logs: unknown[] = [];
      const hooks = await opencodeConfigSync(createPluginInput(logs));
      const unrelated = { keep: true };
      const runtime = parseJsonc<Config & { unrelated: typeof unrelated }>(
        await fs.readFile(repoConfigPath, 'utf8')
      );
      runtime.unrelated = unrelated;

      await hooks.config?.(runtime);

      expect(runtime.unrelated).toBe(unrelated);
      expect(runtime.mcp).toEqual({
        github: {
          type: 'remote',
          url: 'https://example.test/mcp',
          enabled: true,
          headers: { Authorization: `Bearer ${secret}` },
        },
      });
      expect(await fs.readFile(repoConfigPath, 'utf8')).not.toContain(secret);
      expect(await fs.readFile(locations.overridesPath, 'utf8')).not.toContain(secret);
      expect(JSON.stringify(logs)).not.toContain(secret);
    });
  });

  it('rejects a missing placeholder with field context and without exposing other env values', async () => {
    await withIsolatedPluginHome(async () => {
      vi.useFakeTimers();
      const locations = resolveSyncLocations();
      await fs.mkdir(locations.configRoot, { recursive: true });
      await fs.writeFile(
        locations.overridesPath,
        '{"mcp":{"github":{"headers":{"Authorization":"{env:MISSING_PAT}"}}}}\n',
        'utf8'
      );
      delete process.env.MISSING_PAT;
      const logs: unknown[] = [];
      const hooks = await opencodeConfigSync(createPluginInput(logs));
      const runtime: Config & { keep: boolean } = {
        keep: true,
        mcp: {
          github: {
            type: 'remote',
            url: 'https://example.test/mcp',
            enabled: true,
            headers: { Authorization: '' },
          },
        },
      };

      try {
        await hooks.config?.(runtime);
      } catch {
        // OpenCode isolates plugin-hook failures and continues with the mutated runtime config.
      }
      expect(runtime).toEqual({
        keep: true,
        command: expect.any(Object),
        mcp: {
          github: {
            type: 'remote',
            url: 'https://example.test/mcp',
            enabled: false,
            headers: { Authorization: '' },
          },
        },
      });
      expect(JSON.stringify(logs)).toContain(
        'Missing environment variable \\"MISSING_PAT\\" required by local override ' +
          '\\"overrides.mcp.github.headers.Authorization\\".'
      );
      expect(JSON.stringify(logs)).not.toContain('runtime-only-secret-sentinel');
    });
  });
});
