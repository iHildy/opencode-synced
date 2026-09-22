import { Plugin } from '@opencode/plugin';
import type { Context as V2Context } from '@opencode/plugin/promise/plugin';
import type { PluginInput } from '@opencode-ai/plugin';

import {
  buildSyncToolInputSchema,
  executeSyncCommand,
  loadCommands,
  type ParsedCommand,
  SYNC_TOOL_COMMANDS,
  type SyncToolArgs,
  type SyncToolCommand,
} from './shared.js';
import { createNodeShell } from './shell-node.js';
import type { AiProvider } from './sync/ai.js';
import {
  blankEnvPlaceholders,
  deepMerge,
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

/** Prefix all v2 console output so it is greppable; v2 has no toast/log sink. */
function v2Log(message: string): void {
  console.log(`[opencode-synced] ${message}`);
}

function v2Warn(message: string): void {
  console.warn(`[opencode-synced] ${message}`);
}

function v2Error(message: string): void {
  console.error(`[opencode-synced] ${message}`);
}

interface OverrideFailure {
  fieldPath: readonly string[];
  message: string;
}

interface ResolvedOverrides {
  /** Raw document as loaded (used for secret-free fallback configs). */
  raw: Record<string, unknown>;
  /** Per-top-level-key resolved values; keys with failures are omitted. */
  values: Record<string, unknown>;
  /** Field paths (e.g. ['overrides','mcp','github',...]) that failed {env:…} resolution. */
  failures: OverrideFailure[];
}

/**
 * Load overrides once and resolve `{env:…}` per top-level key.
 * Single read avoids TOCTOU drift between the resolved values and the raw
 * fallback used for disabled MCP servers.
 */
async function loadResolvedOverrides(): Promise<ResolvedOverrides | null> {
  const raw = await loadOverrides(resolveSyncLocations());
  if (!raw) return null;

  const values: Record<string, unknown> = {};
  const failures: OverrideFailure[] = [];
  for (const [key, value] of Object.entries(raw)) {
    try {
      values[key] = resolveEnvPlaceholders(value, process.env, ['overrides', key]);
    } catch (error) {
      if (error instanceof EnvPlaceholderResolutionError) {
        failures.push({ fieldPath: error.fieldPath, message: error.message });
        v2Error(error.message);
      } else {
        throw error;
      }
    }
  }
  return { raw, values, failures };
}

/**
 * Merge `partial` into a mutable domain-editor draft in place.
 * Reuses the shared `deepMerge` so v1 (`applyOverridesToRuntimeConfig`) and
 * v2 transforms share merge semantics (including prototype-safe assignment).
 */
function mergeIntoDraft(draft: Record<string, unknown>, partial: Record<string, unknown>): void {
  const merged = deepMerge(draft, partial) as Record<string, unknown>;
  for (const [key, value] of Object.entries(merged)) {
    if (key === '__proto__') continue;
    (draft as Record<string, unknown>)[key] = value;
  }
}

function failedServerNames(failures: OverrideFailure[]): Set<string> {
  const names = new Set<string>();
  for (const failure of failures) {
    if (failure.fieldPath[0] === 'overrides' && failure.fieldPath[1] === 'mcp') {
      const serverName = failure.fieldPath[2];
      if (typeof serverName === 'string' && serverName) names.add(serverName);
    }
  }
  return names;
}

async function registerMcpTransform(ctx: V2Context, resolved: ResolvedOverrides): Promise<void> {
  const mcp = isPlainObject(resolved.values.mcp)
    ? (resolved.values.mcp as Record<string, unknown>)
    : null;
  const failed = failedServerNames(resolved.failures);
  const rawMcp = isPlainObject(resolved.raw.mcp)
    ? (resolved.raw.mcp as Record<string, unknown>)
    : null;
  if (!mcp && failed.size === 0) return;

  // Snapshot plain-object configs up front so the replay callback is pure:
  // no I/O, no logging, no closure mutation when core replays it.
  const upserts = new Map<string, Record<string, unknown>>();
  if (mcp) {
    for (const [name, config] of Object.entries(mcp)) {
      if (isPlainObject(config)) upserts.set(name, config as Record<string, unknown>);
    }
  }
  for (const name of failed) {
    const rawConfig =
      rawMcp && isPlainObject(rawMcp[name]) ? (rawMcp[name] as Record<string, unknown>) : {};
    upserts.set(name, {
      ...(blankEnvPlaceholders(rawConfig) as Record<string, unknown>),
      disabled: true,
    });
  }

  await ctx.mcp.transform((editor) => {
    for (const [name, config] of upserts) {
      if (editor.get(name)) {
        editor.update(name, (draft) => {
          mergeIntoDraft(draft as unknown as Record<string, unknown>, config);
        });
      } else {
        editor.set(name, config as never);
      }
    }
  });
}

/** Structural warnings that need no runtime state; unknown IDs are checked below. */
function collectAgentWarnings(agents: unknown): string[] {
  if (!isPlainObject(agents)) return [];
  const warnings: string[] = [];
  for (const [id, partial] of Object.entries(agents)) {
    if (!isPlainObject(partial))
      warnings.push(`Ignoring agent override for "${id}": not an object.`);
  }
  return warnings;
}

/** Unwrap `{data: [...]}` envelopes or plain arrays from list() APIs. */
function asListItems(value: unknown): unknown[] {
  const unwrapped =
    isPlainObject(value) && 'data' in value ? (value as { data?: unknown }).data : value;
  return Array.isArray(unwrapped) ? unwrapped : [];
}

function idOf(item: unknown): string | null {
  if (typeof item === 'string') return item;
  if (!isPlainObject(item)) return null;
  const direct = (item as Record<string, unknown>).id;
  if (typeof direct === 'string') return direct;
  const provider = (item as Record<string, unknown>).provider;
  if (isPlainObject(provider) && typeof provider.id === 'string') return provider.id;
  const providerID = (item as Record<string, unknown>).providerID;
  if (typeof providerID === 'string') return providerID;
  return null;
}

/** Best-effort known-ID lookup; returns null when the host API is unavailable. */
async function knownIds(listFn: () => Promise<unknown>): Promise<Set<string> | null> {
  try {
    const result = await listFn();
    const ids = new Set<string>();
    for (const item of asListItems(result)) {
      const id = idOf(item);
      if (id) ids.add(id);
    }
    return ids;
  } catch {
    return null;
  }
}

async function registerAgentTransform(ctx: V2Context, resolved: ResolvedOverrides): Promise<void> {
  const agents = resolved.values.agent;
  if (!isPlainObject(agents)) return;
  const snapshot = new Map<string, Record<string, unknown>>();
  for (const [id, partial] of Object.entries(agents)) {
    if (isPlainObject(partial)) snapshot.set(id, partial as Record<string, unknown>);
  }
  if (snapshot.size === 0) return;

  // Best-effort unknown-agent warning outside the replay callback so replays
  // stay side-effect-free. Agents cannot be created via the editor (update-only),
  // so unknown IDs are skipped silently inside the transform.
  const known = await knownIds(() => ctx.agent.list() as unknown as Promise<unknown>);
  if (known) {
    for (const id of snapshot.keys()) {
      if (!known.has(id)) v2Warn(`Ignoring override for unknown agent "${id}".`);
    }
  }
  for (const warning of collectAgentWarnings(agents)) v2Warn(warning);

  await ctx.agent.transform((editor) => {
    for (const [id, partial] of snapshot) {
      if (editor.get(id)) {
        editor.update(id, (draft) => {
          mergeIntoDraft(draft as unknown as Record<string, unknown>, partial);
        });
      }
    }
  });
}

async function registerModelTransform(ctx: V2Context, resolved: ResolvedOverrides): Promise<void> {
  const models = resolved.values.model;
  if (!isPlainObject(models)) return;

  const snapshot = new Map<string, Map<string, Record<string, unknown>>>();
  const structuralWarnings: string[] = [];
  for (const [providerID, providerModels] of Object.entries(models)) {
    if (!isPlainObject(providerModels)) {
      structuralWarnings.push(
        `Ignoring model override for "${providerID}". ${OVERRIDES_DOC_POINTER}: model`
      );
      continue;
    }
    const perModel = new Map<string, Record<string, unknown>>();
    for (const [modelID, partial] of Object.entries(providerModels)) {
      if (isPlainObject(partial)) perModel.set(modelID, partial as Record<string, unknown>);
    }
    if (perModel.size > 0) snapshot.set(providerID, perModel);
  }
  if (snapshot.size === 0) {
    for (const warning of structuralWarnings) v2Warn(warning);
    return;
  }

  // Provider inventory lives on ctx.provider (ModelDomain has no provider
  // accessor); warn outside the replay callback, guard with editor.get inside.
  const knownProviders = await knownIds(() => ctx.provider.list() as unknown as Promise<unknown>);
  if (knownProviders) {
    for (const providerID of snapshot.keys()) {
      if (!knownProviders.has(providerID)) {
        v2Warn(`Ignoring override for unknown model provider "${providerID}".`);
      }
    }
  }
  for (const warning of structuralWarnings) v2Warn(warning);

  await ctx.model.transform((editor) => {
    for (const [providerID, perModel] of snapshot) {
      for (const [modelID, partial] of perModel) {
        if (editor.get(providerID, modelID)) {
          editor.update(providerID, modelID, (draft) => {
            mergeIntoDraft(draft as unknown as Record<string, unknown>, partial);
          });
        }
      }
    }
  });
  // Unknown model IDs are skipped silently inside the replay callback (v2 has
  // no model editor "has" bulk API); structural + provider warnings above cover
  // the actionable cases without spamming on every replay.
}

async function registerProviderTransform(
  ctx: V2Context,
  resolved: ResolvedOverrides
): Promise<void> {
  const providers = resolved.values.provider;
  if (!isPlainObject(providers)) return;
  const snapshot = new Map<string, Record<string, unknown>>();
  for (const [providerID, partial] of Object.entries(providers)) {
    if (isPlainObject(partial)) snapshot.set(providerID, partial as Record<string, unknown>);
  }
  if (snapshot.size === 0) return;

  const known = await knownIds(() => ctx.provider.list() as unknown as Promise<unknown>);
  if (known) {
    for (const id of snapshot.keys()) {
      if (!known.has(id)) v2Warn(`Ignoring override for unknown provider "${id}".`);
    }
  }

  await ctx.provider.transform((editor) => {
    for (const [providerID, partial] of snapshot) {
      if (editor.get(providerID)) {
        editor.update(providerID, (draft) => {
          mergeIntoDraft(draft as unknown as Record<string, unknown>, partial);
        });
      }
    }
  });
}

function warnOnRemainingOverrides(resolved: ResolvedOverrides): void {
  for (const key of Object.keys(resolved.values)) {
    if (key === 'mcp' || key === 'agent' || key === 'model' || key === 'provider') continue;
    if (key === 'command') {
      v2Warn(
        'Ignoring "command" overrides in v2: sync commands are owned by this plugin. ' +
          'See https://opencode.ai/v2/docs/build/plugins/migrate-v1'
      );
      continue;
    }
    v2Warn(`Ignoring unsupported override key "${key}". ${OVERRIDES_DOC_POINTER}: ${key}`);
  }
  for (const failure of resolved.failures) {
    if (failure.fieldPath[1] !== 'mcp') {
      v2Warn(
        `Ignoring override with unresolvable placeholder at "${failure.fieldPath.join('.')}": ${failure.message}`
      );
    }
  }
}

/**
 * Minimal v1 client facade over v2 capabilities.
 *
 * V2 has no toasts and no session-status API, so toasts are no-ops (the service
 * also logs via app.log, which maps to console here). Session status returns an
 * empty map, which `areAllSessionsIdle` treats as "no busy sessions" after its
 * double-poll: Turso idle-gating is therefore intentionally skipped and Turso
 * syncs run immediately in v2. Covered by `v2.test.ts` ("turso gating").
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

const SYNC_COMMAND_NAMES = new Set<string>(SYNC_TOOL_COMMANDS as readonly string[]);

function toolCommandForName(name: string): SyncToolCommand | null {
  const suffix = name.startsWith('sync-') ? name.slice('sync-'.length) : name;
  return SYNC_COMMAND_NAMES.has(suffix) ? (suffix as SyncToolCommand) : null;
}

/**
 * Parse a bare repo argument from a slash-command invocation
 * (e.g. `/sync-link owner/repo`).
 *
 * V2 slash commands only carry free text (`prompt.text`), not structured tool
 * args, so only a single bare `owner/repo` (or URL) is supported. Quoted
 * multi-word input uses the first token; anything beyond `init`/`link` repo
 * and `sessions-backend` backend is intentionally ignored (documented limit).
 */
export function parseCommandRepoArg(
  text: string | undefined,
  commandName: string
): string | undefined {
  if (!text) return undefined;
  let arg = text.trim();
  if (!arg) return undefined;
  if (arg.startsWith('/')) {
    const firstSpace = arg.indexOf(' ');
    if (firstSpace === -1) return undefined;
    arg = arg.slice(firstSpace + 1).trim();
  } else if (arg.startsWith(commandName)) {
    arg = arg.slice(commandName.length).trim();
  }
  if (arg.startsWith('$ARGUMENTS')) arg = arg.slice('$ARGUMENTS'.length).trim();
  if (!arg) return undefined;
  // Strip surrounding quotes, then take the first whitespace-separated token.
  arg = arg.replace(/^["']+|["']+$/g, '').trim();
  const firstToken = arg.split(/\s+/)[0];
  return firstToken || undefined;
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
  // NOTE: transforms are re-applied by core and never re-read disk; a config
  // change requires host restart (or host-triggered `reload()`). No file
  // watcher here by design — see docs/v2.md.
  const resolved = await loadResolvedOverrides();

  await ctx.tool.transform((editor) => {
    editor.add({
      name: 'opencode_sync',
      description: 'Manage opencode config sync with a GitHub repo',
      input: buildSyncToolInputSchema() as never,
      execute: async (input) => {
        const result = await executeSyncCommand(service, input as unknown as SyncToolArgs);
        // Tool.Result.content accepts string | Content[]; plain string keeps
        // large status outputs readable without manual TextContent wrapping.
        return { content: result };
      },
    });
  });

  // V2 `CommandDefinition` only carries name/description/execute (no
  // template/agent/model/subtask like v1 `config.command`). The markdown
  // template is therefore executed directly via `executeV2Command` + synthetic
  // reply instead of being registered as a prompt template.
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
    await registerMcpTransform(ctx, resolved);
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
        v2Error(`Event handling failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  })();

  const timer = setTimeout(() => {
    void service.startupSync().catch((error: unknown) => {
      v2Error(`Startup sync failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 1000);

  v2Log('v2 setup complete');
  return () => {
    clearTimeout(timer);
    controller.abort();
    service.dispose();
  };
}

export const opencodeSyncedV2 = Plugin.define({
  id: PLUGIN_ID,
  setup: setupV2,
});
