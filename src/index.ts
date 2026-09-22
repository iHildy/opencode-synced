import type { Plugin } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';
import {
  disableMcpServerForResolutionFailure,
  executeSyncCommand,
  loadCommands,
  type SyncToolArgs,
} from './shared.js';
import {
  applyOverridesToRuntimeConfig,
  EnvPlaceholderResolutionError,
  loadOverrides,
} from './sync/config.js';
import { resolveSyncLocations } from './sync/paths.js';
import { createSyncService } from './sync/service.js';
import { setupV2 } from './v2.js';

export const opencodeConfigSync: Plugin = async (ctx) => {
  const commands = await loadCommands();
  const service = createSyncService(ctx);

  const syncTool = tool({
    description: 'Manage opencode config sync with a GitHub repo',
    args: {
      command: tool.schema
        .enum([
          'status',
          'init',
          'link',
          'pull',
          'push',
          'enable-secrets',
          'resolve',
          'secrets-pull',
          'secrets-push',
          'secrets-status',
          'sessions-backend',
          'sessions-setup-turso',
          'sessions-migrate-turso',
          'sessions-cleanup-git',
        ])
        .describe('Sync command to execute'),
      repo: tool.schema.string().optional().describe('Repo owner/name or URL'),
      owner: tool.schema.string().optional().describe('Repo owner'),
      name: tool.schema.string().optional().describe('Repo name'),
      url: tool.schema.string().optional().describe('Repo URL'),
      branch: tool.schema.string().optional().describe('Repo branch'),
      includeSecrets: tool.schema.boolean().optional().describe('Enable secrets sync'),
      includeMcpSecrets: tool.schema
        .boolean()
        .optional()
        .describe('Allow MCP secrets to be committed (requires includeSecrets)'),
      includeSessions: tool.schema
        .boolean()
        .optional()
        .describe('Enable session sync (requires includeSecrets)'),
      sessionBackend: tool.schema
        .enum(['git', 'turso'])
        .optional()
        .describe('Session sync backend when includeSessions=true'),
      includePromptStash: tool.schema
        .boolean()
        .optional()
        .describe('Enable prompt stash/history sync (requires includeSecrets)'),
      includeModelFavorites: tool.schema
        .boolean()
        .optional()
        .describe('Sync model favorites (state/model.json)'),
      includeOpencodeSkills: tool.schema
        .boolean()
        .optional()
        .describe('Sync ~/.config/opencode/skills directory'),
      includeAgentsDir: tool.schema.boolean().optional().describe('Sync ~/.agents directory'),
      create: tool.schema.boolean().optional().describe('Create repo if missing'),
      private: tool.schema.boolean().optional().describe('Create repo as private'),
      extraSecretPaths: tool.schema.array(tool.schema.string()).optional(),
      extraConfigPaths: tool.schema.array(tool.schema.string()).optional(),
      localRepoPath: tool.schema.string().optional().describe('Override local repo path'),
      acknowledgePrivateRemote: tool.schema
        .boolean()
        .optional()
        .describe(
          'Acknowledge that an explicit non-GitHub remote is private (only after user confirmation)'
        ),
      setupTurso: tool.schema
        .boolean()
        .optional()
        .describe('Run Turso setup (install/auth/provision) when Turso backend is selected'),
      migrateSessions: tool.schema
        .boolean()
        .optional()
        .describe('Bootstrap remote Turso sessions from local session DB before switching backend'),
    },
    async execute(args) {
      return await executeSyncCommand(service, args as SyncToolArgs);
    },
  });

  // Delay startup sync slightly to ensure TUI is connected
  setTimeout(() => {
    void service.startupSync();
  }, 1000);

  return {
    tool: {
      opencode_sync: syncTool,
    },
    async event(input) {
      await service.handleEvent(input.event);
    },
    async config(config) {
      config.command = config.command ?? {};

      for (const cmd of commands) {
        config.command[cmd.name] = {
          template: cmd.template,
          description: cmd.frontmatter.description,
          agent: cmd.frontmatter.agent,
          model: cmd.frontmatter.model,
          subtask: cmd.frontmatter.subtask,
        };
      }

      const overrides = await loadOverrides(resolveSyncLocations());
      if (overrides) {
        try {
          applyOverridesToRuntimeConfig(config as Record<string, unknown>, overrides);
        } catch (error) {
          if (error instanceof EnvPlaceholderResolutionError) {
            disableMcpServerForResolutionFailure(
              config as Record<string, unknown>,
              error.fieldPath
            );
            await ctx.client.app.log({
              body: {
                service: 'opencode-synced',
                level: 'error',
                message: error.message,
              },
            });
          }
          throw error;
        }
      }
    },
  };
};

export const opencodeSynced = opencodeConfigSync;

export { opencodeSyncedV2 } from './v2.js';

/**
 * Dual v1 + v2 entrypoint.
 *
 * V2 calls `setup()` (registered via `Plugin.define`); v1 (>= 1.18.29 object
 * entrypoints) calls `server()` with the v1 plugin context. Fields are listed
 * explicitly (no spread) so adding a field to one runtime cannot silently leak
 * into the other.
 */
const pluginDefault = {
  id: 'opencode-synced' as const,
  setup: setupV2,
  async server(ctx: Parameters<Plugin>[0]) {
    return await opencodeConfigSync(ctx);
  },
};

export default pluginDefault;
