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
        .enum(['status', 'init', 'link', 'pull', 'push'])
        .describe('Sync command to execute'),
      repo: tool.schema.string().optional().describe('Repo owner/name or URL'),
      owner: tool.schema.string().optional().describe('Repo owner'),
      name: tool.schema.string().optional().describe('Repo name'),
      url: tool.schema.string().optional().describe('Repo URL'),
      branch: tool.schema.string().optional().describe('Repo branch'),
      includeSkills: tool.schema.boolean().optional().describe('Sync global OpenCode skills'),
      includePromptHistory: tool.schema
        .boolean()
        .optional()
        .describe('Sync plaintext prompt history in a private repository'),
      includePromptStash: tool.schema
        .boolean()
        .optional()
        .describe('Sync plaintext prompt stash in a private repository'),
      includeModelFavorites: tool.schema
        .boolean()
        .optional()
        .describe('Sync only the favorite projection from state/model.json'),
      includeModelSelectors: tool.schema
        .boolean()
        .optional()
        .describe('Sync main-model.txt, cheap-model.txt, and frontier-model.txt'),
      acknowledgePlaintextPromptRisk: tool.schema
        .boolean()
        .optional()
        .describe('Required acknowledgement when prompt synchronization is enabled'),
      create: tool.schema.boolean().optional().describe('Create repo if missing'),
      private: tool.schema.boolean().optional().describe('Create repo as private'),
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
            includeSkills: args.includeSkills,
            includePromptHistory: args.includePromptHistory,
            includePromptStash: args.includePromptStash,
            includeModelFavorites: args.includeModelFavorites,
            includeModelSelectors: args.includeModelSelectors,
            acknowledgePlaintextPromptRisk: args.acknowledgePlaintextPromptRisk,
            create: args.create,
            private: args.private,
          });
        }
        if (args.command === 'link') {
          return await service.link({
            repo: args.repo ?? args.name,
            includeSkills: args.includeSkills,
            includePromptHistory: args.includePromptHistory,
            includePromptStash: args.includePromptStash,
            includeModelFavorites: args.includeModelFavorites,
            includeModelSelectors: args.includeModelSelectors,
            acknowledgePlaintextPromptRisk: args.acknowledgePlaintextPromptRisk,
          });
        }
        if (args.command === 'pull') {
          return await service.pull();
        }
        if (args.command === 'push') {
          return await service.push();
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

  // Import prompt/model state before OpenCode mounts in-memory TUI stores.
  await service.startupSync();

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

export const opencodeSynced = opencodeConfigSync;
export default opencodeConfigSync;

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
