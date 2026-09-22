import { Plugin } from '@opencode/plugin';
import type { Context as V2Context } from '@opencode/plugin/promise/plugin';
import type { PluginInput } from '@opencode-ai/plugin';

import {
  buildSyncToolInputSchema,
  disableMcpServerForResolutionFailure,
  executeSyncCommand,
  loadCommands,
  type ParsedCommand,
  type SyncToolArgs,
} from './shared.js';
import { createNodeShell } from './shell-node.js';
import type { AiProvider } from './sync/ai.js';
import {
  EnvPlaceholderResolutionError,
  isPlainObject,
  loadOverrides,
  resolveEnvPlaceholders,
} from './sync/config.js';
import { resolveSyncLocations } from './sync/paths.js';
import { createSyncService, type SyncService } from './sync/service.js';

const PLUGIN_ID = 'opencode-synced';
const OVERRIDES_DOC_POINTER =
  'opencode-synced: ignoring unsupported override key (v2 applies only mcp/agent/model/provider via domain transforms; see https://opencode.ai/v2/docs/build/plugins/migrate-v1)';

interface ResolvedOverrides {
  values: Record<string, unknown>;
  /** Field paths (e.g. ['overrides','mcp','github',...]) that failed {env:…} resolution. */
  failures: { fieldPath: readonly string[]; message: string }[];
}

async function loadResolvedOverrides(): Promise<ResolvedOverrides | null> {
  const overrides = await loadOverrides(resolveSyncLocations());
  if (!overrides) return null;

  const values: Record<string, unknown> = {};
  const failures: ResolvedOverrides['failures'] = [];
  for (const [key, value] of Object.entries(overrides)) {
    try {
      values[key] = resolveEnvPlaceholders(value, process.env, ['overrides', key]);
    } catch (error) {
      if (error instanceof EnvPlaceholderResolutionError) {
        failures.push({ fieldPath: error.fieldPath, message: error.message });
        console.error(`[opencode-synced] ${error.message}`);
      } else {
        throw error;
      }
    }
  }
  return { values, failures };
}

function applyDeepMerge(target: Record<string, unknown>, source: unknown): void {
  if (!isPlainObject(source)) return;
  for (const [key, value] of Object.entries(source)) {
    if (key === '__proto__') continue;
    const current = target[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      applyDeepMerge(current as Record<string, unknown>, value);
    } else {
      Object.defineProperty(target, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
}

/** Blank any unresolvable {env:…} placeholders so a disabled server holds no secrets. */
function blankPlaceholders(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\{env:[^}]+\}/g, '');
  if (Array.isArray(value)) return value.map(blankPlaceholders);
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key === '__proto__') continue;
      result[key] = blankPlaceholders(nested);
    }
    return result;
  }
  return value;
}

function failedServerNames(failures: ResolvedOverrides['failures']): Set<string> {
  const names = new Set<string>();
  for (const failure of failures) {
    if (failure.fieldPath[0] === 'overrides' && failure.fieldPath[1] === 'mcp') {
      const serverName = failure.fieldPath[2];
      if (serverName) names.add(serverName);
    }
  }
  return names;
}

async function registerMcpTransform(
  ctx: V2Context,
  resolved: ResolvedOverrides,
  raw: Record<string, unknown> | null
): Promise<void> {
  const mcp = isPlainObject(resolved.values.mcp)
    ? (resolved.values.mcp as Record<string, unknown>)
    : null;
  const failed = failedServerNames(resolved.failures);
  const rawMcp = raw && isPlainObject(raw.mcp) ? (raw.mcp as Record<string, unknown>) : null;
  if (!mcp && failed.size === 0) return;

  await ctx.mcp.transform((editor) => {
    if (mcp) {
      for (const [name, config] of Object.entries(mcp)) {
        if (!isPlainObject(config)) continue;
        if (editor.get(name)) {
          editor.update(name, (draft) => {
            applyDeepMerge(draft as unknown as Record<string, unknown>, config);
          });
        } else {
          editor.set(name, config as never);
        }
      }
    }
    for (const name of failed) {
      const rawConfig = rawMcp && isPlainObject(rawMcp[name]) ? rawMcp[name] : {};
      const disabledConfig = {
        ...(blankPlaceholders(rawConfig) as Record<string, unknown>),
        disabled: true,
      };
      if (editor.get(name)) {
        editor.update(name, (draft) => {
          applyDeepMerge(draft as unknown as Record<string, unknown>, disabledConfig);
        });
      } else {
        editor.set(name, disabledConfig as never);
      }
      // Mirror the v1 runtime-config fallback so status output stays consistent.
      disableMcpServerForResolutionFailure({ mcp: { [name]: {} } }, ['overrides', 'mcp', name]);
    }
  });
}

async function registerAgentTransform(ctx: V2Context, resolved: ResolvedOverrides): Promise<void> {
  const agents = resolved.values.agent;
  if (!isPlainObject(agents)) return;

  await ctx.agent.transform((editor) => {
    for (const [id, partial] of Object.entries(agents)) {
      if (!isPlainObject(partial)) continue;
      if (editor.get(id)) {
        editor.update(id, (draft) => {
          applyDeepMerge(draft as unknown as Record<string, unknown>, partial);
        });
      } else {
        console.warn(`[opencode-synced] Ignoring override for unknown agent "${id}".`);
      }
    }
  });
}

async function registerModelTransform(ctx: V2Context, resolved: ResolvedOverrides): Promise<void> {
  const models = resolved.values.model;
  if (!isPlainObject(models)) return;

  await ctx.model.transform((editor) => {
    for (const [providerID, providerModels] of Object.entries(models)) {
      if (!isPlainObject(providerModels)) {
        console.warn(
          `[opencode-synced] Ignoring model override for "${providerID}". ${OVERRIDES_DOC_POINTER}: model`
        );
        continue;
      }
      for (const [modelID, partial] of Object.entries(providerModels)) {
        if (!isPlainObject(partial)) continue;
        if (editor.get(providerID, modelID)) {
          editor.update(providerID, modelID, (draft) => {
            applyDeepMerge(draft as unknown as Record<string, unknown>, partial);
          });
        } else {
          console.warn(
            `[opencode-synced] Ignoring override for unknown model "${providerID}/${modelID}".`
          );
        }
      }
    }
  });
}

async function registerProviderTransform(
  ctx: V2Context,
  resolved: ResolvedOverrides
): Promise<void> {
  const providers = resolved.values.provider;
  if (!isPlainObject(providers)) return;

  await ctx.provider.transform((editor) => {
    for (const [providerID, partial] of Object.entries(providers)) {
      if (!isPlainObject(partial)) continue;
      if (editor.get(providerID)) {
        editor.update(providerID, (draft) => {
          applyDeepMerge(draft as unknown as Record<string, unknown>, partial);
        });
      } else {
        console.warn(`[opencode-synced] Ignoring override for unknown provider "${providerID}".`);
      }
    }
  });
}

function warnOnRemainingOverrides(resolved: ResolvedOverrides): void {
  for (const key of Object.keys(resolved.values)) {
    if (key === 'mcp' || key === 'agent' || key === 'model' || key === 'provider') continue;
    if (key === 'command') {
      console.warn(
        '[opencode-synced] Ignoring "command" overrides in v2: sync commands are owned by this plugin. ' +
          'See https://opencode.ai/v2/docs/build/plugins/migrate-v1'
      );
      continue;
    }
    console.warn(
      `[opencode-synced] Ignoring unsupported override key "${key}". ${OVERRIDES_DOC_POINTER}: ${key}`
    );
  }
}

/**
 * Minimal v1 client facade over v2 capabilities.
 *
 * V2 has no toasts and no session-status API, so toasts are no-ops (the service
 * also logs via app.log, which maps to console here) and session status always
 * reports idle, which skips Turso idle-gating and syncs immediately.
 */
function createV2ClientFacade(): PluginInput['client'] {
  return {
    app: {
      log: async (entry: unknown) => {
        const body = (entry as { body?: { level?: string; message?: string } })?.body;
        const level = body?.level === 'error' ? 'error' : 'log';
        console[level](`[opencode-synced] ${body?.message ?? JSON.stringify(entry)}`);
        return {};
      },
    },
    config: {
      get: async () => ({ data: {} }),
    },
    session: {
      status: async () => ({ data: {} }),
    },
    tui: {
      showToast: async () => ({}),
    },
  } as unknown as PluginInput['client'];
}

function createV2AiProvider(ctx: V2Context): AiProvider {
  return {
    resolveModel: async () => {
      try {
        const raw = (await ctx.model.default()) as unknown;
        const ref = (raw as { data?: unknown })?.data ?? raw;
        const record = ref as { providerID?: unknown; modelID?: unknown; id?: unknown };
        const providerID = typeof record?.providerID === 'string' ? record.providerID : null;
        const modelID =
          typeof record?.modelID === 'string'
            ? record.modelID
            : typeof record?.id === 'string'
              ? record.id
              : null;
        if (!providerID || !modelID) return null;
        return { providerID, modelID };
      } catch {
        return null;
      }
    },
    generateText: async (model, prompt) => {
      try {
        const output = (await ctx.generate.text({
          model: { providerID: model.providerID, id: model.modelID },
          prompt,
        })) as unknown;
        if (typeof output === 'string') return output;
        const record = output as { text?: unknown; data?: { text?: unknown } };
        if (typeof record?.text === 'string') return record.text;
        if (typeof record?.data?.text === 'string') return record.data.text;
        return null;
      } catch {
        return null;
      }
    },
  };
}

function toolCommandForName(name: string): SyncToolArgs['command'] | null {
  const suffix = name.startsWith('sync-') ? name.slice('sync-'.length) : name;
  switch (suffix) {
    case 'status':
    case 'pull':
    case 'push':
    case 'resolve':
    case 'secrets-pull':
    case 'secrets-push':
    case 'secrets-status':
    case 'sessions-cleanup-git':
      return suffix;
    case 'init':
    case 'link':
      return suffix;
    case 'enable-secrets':
      return 'enable-secrets';
    case 'sessions-backend':
    case 'sessions-setup-turso':
    case 'sessions-migrate-turso':
      return suffix;
    default:
      return null;
  }
}

/** Parse a bare repo argument from a slash-command invocation (e.g. `/sync-link owner/repo`). */
export function parseCommandRepoArg(
  text: string | undefined,
  commandName: string
): string | undefined {
  if (!text) return undefined;
  let arg = text.trim();
  if (arg.startsWith('/')) {
    const firstSpace = arg.indexOf(' ');
    if (firstSpace === -1) return undefined;
    arg = arg.slice(firstSpace + 1).trim();
  } else if (arg.startsWith(commandName)) {
    arg = arg.slice(commandName.length).trim();
  }
  if (arg.startsWith('$ARGUMENTS')) arg = arg.slice('$ARGUMENTS'.length).trim();
  return arg || undefined;
}

async function executeV2Command(
  service: SyncService,
  command: ParsedCommand,
  invocation: { sessionID: string; prompt?: { text?: string }; text?: string }
): Promise<string> {
  const toolCommand = toolCommandForName(command.name);
  if (!toolCommand) return `Unknown sync command: ${command.name}`;

  const rawText = invocation.prompt?.text ?? invocation.text;
  const repo = parseCommandRepoArg(rawText, command.name);

  switch (toolCommand) {
    case 'status':
      return await service.status();
    case 'init':
      return await service.init({ repo });
    case 'link':
      return await service.link({ repo });
    case 'pull':
      return await service.pull();
    case 'push':
      return await service.push();
    case 'resolve':
      return await service.resolve();
    case 'secrets-pull':
      return await service.secretsPull();
    case 'secrets-push':
      return await service.secretsPush();
    case 'secrets-status':
      return await service.secretsStatus();
    case 'enable-secrets':
      return await service.enableSecrets({});
    case 'sessions-backend': {
      const backend = repo === 'git' || repo === 'turso' ? repo : undefined;
      return await service.sessionsBackend({ backend });
    }
    case 'sessions-setup-turso':
      return await service.sessionsSetupTurso({});
    case 'sessions-migrate-turso':
      return await service.sessionsMigrateTurso({});
    case 'sessions-cleanup-git':
      return await service.sessionsCleanupGit();
  }
}

export async function setupV2(ctx: V2Context): Promise<() => void> {
  const commands = await loadCommands();
  const service = createSyncService({
    client: createV2ClientFacade(),
    $: createNodeShell(),
    ai: createV2AiProvider(ctx),
  });

  // Load + resolve {env:…} once before registering replayable transforms.
  const resolved = await loadResolvedOverrides();
  const raw = await loadOverrides(resolveSyncLocations());

  await ctx.tool.transform((editor) => {
    editor.add({
      name: 'opencode_sync',
      description: 'Manage opencode config sync with a GitHub repo',
      input: buildSyncToolInputSchema() as never,
      execute: async (input) => {
        const result = await executeSyncCommand(service, input as unknown as SyncToolArgs);
        return { content: result } as never;
      },
    });
  });

  await ctx.command.transform((editor) => {
    for (const command of commands) {
      editor.add({
        name: command.name,
        description: command.frontmatter.description,
        execute: async ({ sessionID, prompt }) => {
          const result = await executeV2Command(service, command, {
            sessionID,
            prompt: prompt as { text?: string },
          });
          await ctx.session.synthetic({ sessionID, text: result });
        },
      });
    }
  });

  if (resolved) {
    await registerMcpTransform(ctx, resolved, raw);
    await registerAgentTransform(ctx, resolved);
    await registerModelTransform(ctx, resolved);
    await registerProviderTransform(ctx, resolved);
    warnOnRemainingOverrides(resolved);
  }

  const controller = new AbortController();
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      try {
        await service.handleEvent(event);
      } catch (error) {
        console.error(
          `[opencode-synced] Event handling failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  })();

  const timer = setTimeout(() => {
    void service.startupSync().catch((error: unknown) => {
      console.error(
        `[opencode-synced] Startup sync failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }, 1000);

  return () => {
    clearTimeout(timer);
    controller.abort();
  };
}

export const opencodeSyncedV2 = Plugin.define({
  id: PLUGIN_ID,
  setup: setupV2,
});
