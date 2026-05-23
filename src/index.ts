import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';

import { applyOverridesToRuntimeConfig, loadOverrides } from './sync/config.js';
import { SyncCommandError, SyncConfigMissingError } from './sync/errors.js';
import { resolveSyncLocations } from './sync/paths.js';
import { createSyncService } from './sync/service.js';

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

function getModuleDir(): string {
  // Works in both Bun and Node.js
  if (typeof import.meta.dir === 'string') {
    return import.meta.dir;
  }
  // Node.js fallback
  return path.dirname(fileURLToPath(import.meta.url));
}

async function scanMdFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }
  }

  await walk(dir);
  return files;
}

async function loadCommands(): Promise<ParsedCommand[]> {
  const commands: ParsedCommand[] = [];
  const commandDir = path.join(getModuleDir(), 'command');

  try {
    const stats = await fs.stat(commandDir);
    if (!stats.isDirectory()) {
      return commands;
    }
  } catch {
    return commands;
  }

  const files = await scanMdFiles(commandDir);
  for (const file of files) {
    try {
      const content = await fs.readFile(file, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(content);
      const relativePath = path.relative(commandDir, file);
      const name = relativePath.replace(/\.md$/, '').replace(/\//g, '-');

      commands.push({
        name,
        frontmatter,
        template: body,
      });
    } catch {}
  }

  return commands;
}

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
            includeMcpSecrets: args.includeMcpSecrets,
            includeSessions: args.includeSessions,
            sessionBackend: args.sessionBackend,
            includePromptStash: args.includePromptStash,
            includeModelFavorites: args.includeModelFavorites,
            setupTurso: args.setupTurso,
            migrateSessions: args.migrateSessions,
            includeOpencodeSkills: args.includeOpencodeSkills,
            includeAgentsDir: args.includeAgentsDir,
            create: args.create,
            private: args.private,
            extraSecretPaths: args.extraSecretPaths,
            extraConfigPaths: args.extraConfigPaths,
            localRepoPath: args.localRepoPath,
          });
        }
        if (args.command === 'link') {
          return await service.link({
            repo: args.repo ?? args.name,
          });
        }
        if (args.command === 'pull') {
          return await service.pull();
        }
        if (args.command === 'push') {
          return await service.push();
        }
        if (args.command === 'secrets-pull') {
          return await service.secretsPull();
        }
        if (args.command === 'secrets-push') {
          return await service.secretsPush();
        }
        if (args.command === 'secrets-status') {
          return await service.secretsStatus();
        }
        if (args.command === 'enable-secrets') {
          return await service.enableSecrets({
            extraSecretPaths: args.extraSecretPaths,
            includeMcpSecrets: args.includeMcpSecrets,
          });
        }
        if (args.command === 'sessions-backend') {
          return await service.sessionsBackend({
            backend: args.sessionBackend,
            setupTurso: args.setupTurso,
            migrateSessions: args.migrateSessions,
          });
        }
        if (args.command === 'sessions-setup-turso') {
          return await service.sessionsSetupTurso({
            forceTokenRefresh: args.setupTurso,
          });
        }
        if (args.command === 'sessions-migrate-turso') {
          return await service.sessionsMigrateTurso({
            setupTurso: args.setupTurso,
          });
        }
        if (args.command === 'sessions-cleanup-git') {
          return await service.sessionsCleanupGit();
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

export const opencodeSynced = opencodeConfigSync;
export default opencodeConfigSync;

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
