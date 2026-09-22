import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { PluginInput } from '@opencode-ai/plugin';
import { describe, expect, it, vi } from 'vitest';

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

import pluginDefault, { opencodeConfigSync, opencodeSyncedV2 } from './index.js';
import { resolveSyncLocations } from './sync/paths.js';
import { parseCommandRepoArg, setupV2 } from './v2.js';

const ENV_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'] as const;

interface RecordedTool {
  name: string;
  description: string;
  input: { required?: string[] };
  execute: (_input: Record<string, unknown>) => Promise<{ content: string }>;
}

interface RecordedCommand {
  name: string;
  description?: string;
  execute: (_input: { sessionID: string; prompt: { text?: string } }) => Promise<void>;
}

interface MockCtx {
  toolAdds: RecordedTool[];
  commandAdds: RecordedCommand[];
  mcpSets: [string, Record<string, unknown>][];
  mcpUpdates: [string, Record<string, unknown>][];
  subscribed: boolean;
  synthetics: { sessionID: string; text: string }[];
  ctx: unknown;
}

function createMockCtx(): MockCtx {
  const mock: MockCtx = {
    toolAdds: [],
    commandAdds: [],
    mcpSets: [],
    mcpUpdates: [],
    subscribed: false,
    synthetics: [],
    ctx: null,
  };
  mock.ctx = {
    tool: {
      transform: async (callback: (_editor: unknown) => void) => {
        callback({
          add: (definition: RecordedTool) => {
            mock.toolAdds.push(definition);
          },
        });
        return { dispose: async () => {} };
      },
    },
    command: {
      transform: async (callback: (_editor: unknown) => void) => {
        callback({
          add: (definition: RecordedCommand) => {
            mock.commandAdds.push(definition);
          },
        });
        return { dispose: async () => {} };
      },
    },
    mcp: {
      transform: async (callback: (_editor: unknown) => void) => {
        const draft = new Map<string, Record<string, unknown>>();
        callback({
          list: () => [...draft.entries()],
          get: (name: string) => draft.get(name),
          set: (name: string, config: Record<string, unknown>) => {
            mock.mcpSets.push([name, config]);
            draft.set(name, config);
          },
          update: (name: string, update: (_draft: Record<string, unknown>) => void) => {
            const current = draft.get(name) ?? {};
            update(current);
            mock.mcpUpdates.push([name, current]);
            draft.set(name, current);
          },
          remove: (name: string) => {
            draft.delete(name);
          },
        });
        return { dispose: async () => {} };
      },
    },
    agent: {
      transform: async () => ({ dispose: async () => {} }),
    },
    model: {
      default: async () => null,
      transform: async () => ({ dispose: async () => {} }),
    },
    provider: {
      transform: async () => ({ dispose: async () => {} }),
    },
    generate: {
      text: async () => ({ text: 'Sync opencode config' }),
    },
    session: {
      synthetic: async (input: { sessionID: string; text: string }) => {
        mock.synthetics.push(input);
        return {};
      },
    },
    event: {
      subscribe: () => {
        mock.subscribed = true;
        async function* empty(): AsyncGenerator<never> {}
        return empty();
      },
    },
  };
  return mock;
}

function createV1Input(): PluginInput {
  return {
    $: (() => {
      throw new Error('Shell execution is not expected in v2 server tests.');
    }) as unknown as PluginInput['$'],
    client: {
      app: { log: async () => ({}) },
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

async function withIsolatedHome(run: () => Promise<void>): Promise<void> {
  const original = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  const homeDir = await fs.mkdtemp(path.join(tmpdir(), 'opencode-synced-v2-'));
  process.env.HOME = homeDir;
  process.env.XDG_CONFIG_HOME = path.join(homeDir, 'config');
  process.env.XDG_DATA_HOME = path.join(homeDir, 'data');
  process.env.XDG_STATE_HOME = path.join(homeDir, 'state');

  try {
    await run();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

describe('v2 dual export', () => {
  it('exposes setup for v2 and server for v1 from one default export', () => {
    expect(opencodeSyncedV2.id).toBe('opencode-synced');
    expect(typeof opencodeSyncedV2.setup).toBe('function');
    expect(typeof opencodeConfigSync).toBe('function');
    expect(pluginDefault.id).toBe('opencode-synced');
    expect(typeof pluginDefault.setup).toBe('function');
    expect(typeof pluginDefault.server).toBe('function');
  });

  it('server() returns the v1 hooks', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (() => 0) as unknown as typeof setTimeout;
    try {
      const hooks = await pluginDefault.server(createV1Input());
      expect(hooks.tool?.opencode_sync).toBeDefined();
      expect(typeof hooks.event).toBe('function');
      expect(typeof hooks.config).toBe('function');
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});

describe('v2 setup', () => {
  it('registers the sync tool and owned commands, with a status round-trip', async () => {
    await withIsolatedHome(async () => {
      const mock = createMockCtx();
      const cleanup = await setupV2(mock.ctx as never);
      try {
        expect(mock.toolAdds).toHaveLength(1);
        expect(mock.toolAdds[0].name).toBe('opencode_sync');
        expect(mock.toolAdds[0].input.required).toEqual(['command']);

        expect(mock.commandAdds.length).toBeGreaterThan(0);
        expect(mock.commandAdds.map((command) => command.name)).toContain('sync-status');

        const result = await mock.toolAdds[0].execute({ command: 'status' });
        expect(result.content).toContain('opencode-synced is not configured');
        expect(mock.subscribed).toBe(true);
      } finally {
        cleanup();
      }
    });
  });

  it('disables an mcp server with an unresolvable env placeholder', async () => {
    await withIsolatedHome(async () => {
      const locations = resolveSyncLocations();
      await fs.mkdir(locations.configRoot, { recursive: true });
      await fs.writeFile(
        locations.overridesPath,
        '{"mcp":{"github":{"type":"remote","url":"https://example.test/mcp","headers":{"Authorization":"Bearer {env:V2_MISSING_PAT}"}}}}\n',
        'utf8'
      );
      delete process.env.V2_MISSING_PAT;

      const errors: unknown[][] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args);
      };
      try {
        const mock = createMockCtx();
        const cleanup = await setupV2(mock.ctx as never);
        try {
          expect(mock.mcpSets).toHaveLength(1);
          expect(mock.mcpSets[0][0]).toBe('github');
          expect(mock.mcpSets[0][1]).toMatchObject({ disabled: true });
          expect(JSON.stringify(mock.mcpSets)).not.toContain('{env:');
          expect(errors.some((args) => JSON.stringify(args).includes('V2_MISSING_PAT'))).toBe(true);
        } finally {
          cleanup();
        }
      } finally {
        console.error = originalError;
      }
    });
  });

  it('posts command results via session.synthetic', async () => {
    await withIsolatedHome(async () => {
      const mock = createMockCtx();
      const cleanup = await setupV2(mock.ctx as never);
      try {
        const statusCommand = mock.commandAdds.find((command) => command.name === 'sync-status');
        expect(statusCommand).toBeDefined();
        await statusCommand?.execute({ sessionID: 'session-1', prompt: { text: '' } });
        expect(mock.synthetics).toHaveLength(1);
        expect(mock.synthetics[0].sessionID).toBe('session-1');
        expect(mock.synthetics[0].text).toContain('opencode-synced is not configured');
      } finally {
        cleanup();
      }
    });
  });
});

describe('parseCommandRepoArg', () => {
  it('parses bare repo args and slash-prefixed invocations', () => {
    expect(parseCommandRepoArg('owner/repo', 'sync-link')).toBe('owner/repo');
    expect(parseCommandRepoArg('/sync-link owner/repo', 'sync-link')).toBe('owner/repo');
    expect(parseCommandRepoArg('', 'sync-link')).toBeUndefined();
    expect(parseCommandRepoArg('/sync-link', 'sync-link')).toBeUndefined();
  });
});
