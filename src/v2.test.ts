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
import { setupV2 } from './v2.js';

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

type TransformCallback = (_editor: unknown) => void;

interface MockCtx {
  toolAdds: RecordedTool[];
  commandAdds: RecordedCommand[];
  mcpSets: [string, Record<string, unknown>][];
  mcpUpdates: [string, Record<string, unknown>][];
  agentUpdates: [string, Record<string, unknown>][];
  providerUpdates: [string, Record<string, unknown>][];
  modelUpdates: [string, string, Record<string, unknown>][];
  transformCallbacks: Record<string, TransformCallback[]>;
  subscribed: boolean;
  synthetics: { sessionID: string; text: string; resume?: boolean }[];
  knownAgents: { id: string }[];
  knownProviders: { provider: { id: string } }[];
  ctx: unknown;
}

function createMockCtx(): MockCtx {
  const mock: MockCtx = {
    toolAdds: [],
    commandAdds: [],
    mcpSets: [],
    mcpUpdates: [],
    agentUpdates: [],
    providerUpdates: [],
    modelUpdates: [],
    transformCallbacks: { mcp: [], agent: [], model: [], provider: [], tool: [], command: [] },
    subscribed: false,
    synthetics: [],
    knownAgents: [],
    knownProviders: [],
    ctx: null,
  };
  const recordTransform = (domain: string, callback: TransformCallback): void => {
    mock.transformCallbacks[domain].push(callback);
  };
  mock.ctx = {
    tool: {
      transform: async (callback: (_editor: unknown) => void) => {
        recordTransform('tool', callback);
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
        recordTransform('command', callback);
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
        recordTransform('mcp', callback);
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
      list: async () => mock.knownAgents,
      transform: async (callback: (_editor: unknown) => void) => {
        recordTransform('agent', callback);
        const draft = new Map<string, Record<string, unknown>>();
        callback({
          list: () => [...draft.values()],
          get: (id: string) => draft.get(id) ?? mock.knownAgents.find((a) => a.id === id),
          update: (id: string, update: (_draft: Record<string, unknown>) => void) => {
            const current = draft.get(id) ?? {};
            update(current);
            mock.agentUpdates.push([id, current]);
            draft.set(id, current);
          },
        });
        return { dispose: async () => {} };
      },
    },
    model: {
      default: async () => null,
      provider: {
        list: async () => mock.knownProviders,
      },
      transform: async (callback: (_editor: unknown) => void) => {
        recordTransform('model', callback);
        const draft = new Map<string, Record<string, unknown>>();
        callback({
          get: (providerID: string, modelID: string) => draft.get(`${providerID}/${modelID}`),
          update: (
            providerID: string,
            modelID: string,
            update: (_draft: Record<string, unknown>) => void
          ) => {
            const key = `${providerID}/${modelID}`;
            const current = draft.get(key) ?? {};
            update(current);
            mock.modelUpdates.push([providerID, modelID, current]);
            draft.set(key, current);
          },
        });
        return { dispose: async () => {} };
      },
    },
    provider: {
      list: async () => mock.knownProviders,
      transform: async (callback: (_editor: unknown) => void) => {
        recordTransform('provider', callback);
        const draft = new Map<string, Record<string, unknown>>();
        callback({
          list: () => [...draft.entries()],
          get: (id: string) => draft.get(id) ?? undefined,
          update: (id: string, update: (_draft: Record<string, unknown>) => void) => {
            const current = draft.get(id) ?? {};
            update(current);
            mock.providerUpdates.push([id, current]);
            draft.set(id, current);
          },
        });
        return { dispose: async () => {} };
      },
    },
    generate: {
      text: async () => ({ text: 'Sync opencode config' }),
    },
    session: {
      synthetic: async (input: { sessionID: string; text: string; resume?: boolean }) => {
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
  it('exposes setup for v2 and server for v1 from one explicit default export', () => {
    expect(opencodeSyncedV2.id).toBe('opencode-synced');
    expect(typeof opencodeSyncedV2.setup).toBe('function');
    expect(typeof opencodeConfigSync).toBe('function');
    expect(pluginDefault.id).toBe('opencode-synced');
    expect(typeof pluginDefault.setup).toBe('function');
    expect(typeof pluginDefault.server).toBe('function');
    // No spread leakage: exactly the documented fields.
    expect(Object.keys(pluginDefault).sort()).toEqual(['id', 'server', 'setup']);
    expect(pluginDefault.setup).toBe(opencodeSyncedV2.setup);
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
  it('exposes status through the tool without registering model-resuming slash commands', async () => {
    await withIsolatedHome(async () => {
      const mock = createMockCtx();
      const cleanup = await setupV2(mock.ctx as never);
      try {
        expect(mock.toolAdds).toHaveLength(1);
        expect(mock.toolAdds[0].name).toBe('opencode_sync');
        expect(mock.toolAdds[0].input.required).toEqual(['command']);

        expect(mock.commandAdds).toHaveLength(0);

        const result = await mock.toolAdds[0].execute({ command: 'status' });
        expect(typeof result.content).toBe('string');
        expect(result.content).toContain('opencode-synced is not configured');
        expect(result.content).toContain('opencode_sync with {"command":"init"}');
        expect(result.content).not.toContain('/sync-init');
        expect(mock.synthetics).toHaveLength(0);
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

  it('warns once for unknown agent/provider overrides and keeps replays pure', async () => {
    await withIsolatedHome(async () => {
      const locations = resolveSyncLocations();
      await fs.mkdir(locations.configRoot, { recursive: true });
      await fs.writeFile(
        locations.overridesPath,
        JSON.stringify({
          agent: { ghost: { temperature: 0.1 } },
          provider: { ghost: { name: 'x' } },
        }),
        'utf8'
      );

      const warnings: unknown[][] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args);
      };
      try {
        const mock = createMockCtx();
        const cleanup = await setupV2(mock.ctx as never);
        try {
          expect(warnings.some((a) => JSON.stringify(a).includes('ghost'))).toBe(true);
          const warnedCount = warnings.length;
          // Replaying captured transform callbacks must not warn again.
          for (const domain of ['agent', 'provider'] as const) {
            for (const callback of mock.transformCallbacks[domain]) {
              callback({
                get: () => undefined,
                update: () => {
                  throw new Error('should not update unknown id');
                },
                list: () => [],
              });
            }
          }
          expect(warnings.length).toBe(warnedCount);
        } finally {
          cleanup();
        }
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  it('cleanup is idempotent and stops background work', async () => {
    await withIsolatedHome(async () => {
      const mock = createMockCtx();
      const cleanup = await setupV2(mock.ctx as never);
      expect(typeof cleanup).toBe('function');
      cleanup();
      expect(() => cleanup()).not.toThrow();
    });
  });
});
