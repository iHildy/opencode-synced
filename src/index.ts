import path from 'node:path';
import type { Plugin } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';

import { applyOverridesToRuntimeConfig, loadOverrides } from './sync/config.ts';
import { SyncCommandError, SyncConfigMissingError } from './sync/errors.ts';
import { resolveSyncLocations } from './sync/paths.ts';
import { createSyncService } from './sync/service.ts';

interface CommandFrontmatter {
  description?: string;
  agent?: string;
  model?: string;
  subtask?: boolean;
}

interface ParsedCommand {
  name: string;
  frontmatter: CommandFrontmatter;
  template: string;
}

function parseFrontmatter(content: string): { frontmatter: CommandFrontmatter; body: string } {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { frontmatter: {}, body: content.trim() };
  }

  const [, yamlContent, body] = match;
  const frontmatter: CommandFrontmatter = {};

  for (const line of yamlContent.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (key === 'description') frontmatter.description = value;
    if (key === 'agent') frontmatter.agent = value;
    if (key === 'model') frontmatter.model = value;
    if (key === 'subtask') frontmatter.subtask = value === 'true';
  }

  return { frontmatter, body: body.trim() };
}

async function loadCommands(): Promise<ParsedCommand[]> {
  const commands: ParsedCommand[] = [];
  const commandDir = path.join(import.meta.dir, 'command');
  const glob = new Bun.Glob('**/*.md');

  for await (const file of glob.scan({ cwd: commandDir, absolute: true })) {
    const content = await Bun.file(file).text();
    const { frontmatter, body } = parseFrontmatter(content);
    const relativePath = path.relative(commandDir, file);
    const name = relativePath.replace(/\.md$/, '').replace(/\//g, '-');

    commands.push({
      name,
      frontmatter,
      template: body,
    });
  }

  return commands;
}

export const OpencodeConfigSync: Plugin = async (ctx) => {
  const commands = await loadCommands();
  const service = createSyncService(ctx);

  const syncTool = tool({
    description: 'Manage OpenCode config sync with a GitHub repo',
    args: {
      command: tool.schema
        .enum(['status', 'init', 'pull', 'push', 'enable-secrets', 'resolve'])
        .describe('Sync command to execute'),
      repo: tool.schema.string().optional().describe('Repo owner/name or URL'),
      owner: tool.schema.string().optional().describe('Repo owner'),
      name: tool.schema.string().optional().describe('Repo name'),
      url: tool.schema.string().optional().describe('Repo URL'),
      branch: tool.schema.string().optional().describe('Repo branch'),
      includeSecrets: tool.schema.boolean().optional().describe('Enable secrets sync'),
      includeSessions: tool.schema
        .boolean()
        .optional()
        .describe('Enable session sync (requires includeSecrets)'),
      includePromptStash: tool.schema
        .boolean()
        .optional()
        .describe('Enable prompt stash/history sync (requires includeSecrets)'),
      create: tool.schema.boolean().optional().describe('Create repo if missing'),
      private: tool.schema.boolean().optional().describe('Create repo as private'),
      extraSecretPaths: tool.schema.array(tool.schema.string()).optional(),
      localRepoPath: tool.schema.string().optional().describe('Override local repo path'),
    },
    async execute(args) {
      try {
        if (args.command === 'status') {
          return await service.status();
        }
        if (args.command === 'init') {
          return await service.init({
            repo: args.repo,
            owner: args.owner,
            name: args.name,
            url: args.url,
            branch: args.branch,
            includeSecrets: args.includeSecrets,
            includeSessions: args.includeSessions,
            includePromptStash: args.includePromptStash,
            create: args.create,
            private: args.private,
            extraSecretPaths: args.extraSecretPaths,
            localRepoPath: args.localRepoPath,
          });
        }
        if (args.command === 'pull') {
          return await service.pull();
        }
        if (args.command === 'push') {
          return await service.push();
        }
        if (args.command === 'enable-secrets') {
          return await service.enableSecrets(args.extraSecretPaths);
        }
        if (args.command === 'resolve') {
          return await service.resolve();
        }

        return 'Unknown command.';
      } catch (error) {
        if (error instanceof SyncConfigMissingError || error instanceof SyncCommandError) {
          return error.message;
        }
        return formatError(error);
      }
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

      try {
        const overrides = await loadOverrides(resolveSyncLocations());
        if (overrides) {
          applyOverridesToRuntimeConfig(config as Record<string, unknown>, overrides);
        }
      } catch {
        return;
      }
    },
  };
};

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
