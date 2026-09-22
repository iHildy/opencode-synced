import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SyncCommandError, SyncConfigMissingError } from './sync/errors.js';
import type { SyncService } from './sync/service.js';

export interface CommandFrontmatter {
  description?: string;
  agent?: string;
  model?: string;
  subtask?: boolean;
}

export interface ParsedCommand {
  name: string;
  frontmatter: CommandFrontmatter;
  template: string;
}

export function parseFrontmatter(content: string): {
  frontmatter: CommandFrontmatter;
  body: string;
} {
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

export function getModuleDir(): string {
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

export async function loadCommands(commandDir?: string): Promise<ParsedCommand[]> {
  const commands: ParsedCommand[] = [];
  const dir = commandDir ?? path.join(getModuleDir(), 'command');

  try {
    const stats = await fs.stat(dir);
    if (!stats.isDirectory()) {
      return commands;
    }
  } catch {
    return commands;
  }

  const files = await scanMdFiles(dir);
  for (const file of files) {
    try {
      const content = await fs.readFile(file, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(content);
      const relativePath = path.relative(dir, file);
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

export const SYNC_TOOL_COMMANDS = [
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
] as const;

export type SyncToolCommand = (typeof SYNC_TOOL_COMMANDS)[number];

export interface SyncToolArgs {
  command: SyncToolCommand;
  repo?: string;
  owner?: string;
  name?: string;
  url?: string;
  branch?: string;
  includeSecrets?: boolean;
  includeMcpSecrets?: boolean;
  includeSessions?: boolean;
  sessionBackend?: 'git' | 'turso';
  includePromptStash?: boolean;
  includeModelFavorites?: boolean;
  includeOpencodeSkills?: boolean;
  includeAgentsDir?: boolean;
  create?: boolean;
  private?: boolean;
  extraSecretPaths?: string[];
  extraConfigPaths?: string[];
  localRepoPath?: string;
  acknowledgePrivateRemote?: boolean;
  setupTurso?: boolean;
  migrateSessions?: boolean;
}

export function buildSyncToolInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      command: { type: 'string', enum: [...SYNC_TOOL_COMMANDS] },
      repo: { type: 'string' },
      owner: { type: 'string' },
      name: { type: 'string' },
      url: { type: 'string' },
      branch: { type: 'string' },
      includeSecrets: { type: 'boolean' },
      includeMcpSecrets: { type: 'boolean' },
      includeSessions: { type: 'boolean' },
      sessionBackend: { type: 'string', enum: ['git', 'turso'] },
      includePromptStash: { type: 'boolean' },
      includeModelFavorites: { type: 'boolean' },
      includeOpencodeSkills: { type: 'boolean' },
      includeAgentsDir: { type: 'boolean' },
      create: { type: 'boolean' },
      private: { type: 'boolean' },
      extraSecretPaths: { type: 'array', items: { type: 'string' } },
      extraConfigPaths: { type: 'array', items: { type: 'string' } },
      localRepoPath: { type: 'string' },
      acknowledgePrivateRemote: { type: 'boolean' },
      setupTurso: { type: 'boolean' },
      migrateSessions: { type: 'boolean' },
    },
    required: ['command'],
    additionalProperties: false,
  };
}

/** Runtime-independent dispatch shared by the v1 and v2 tool executors. */
export async function executeSyncCommand(
  service: SyncService,
  args: SyncToolArgs
): Promise<string> {
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
        acknowledgePrivateRemote: args.acknowledgePrivateRemote,
      });
    }
    if (args.command === 'link') {
      return await service.link({
        repo: args.repo ?? args.name,
        branch: args.branch,
        acknowledgePrivateRemote: args.acknowledgePrivateRemote,
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
        acknowledgePrivateRemote: args.acknowledgePrivateRemote,
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
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function hasOwn(target: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(target, key);
}

export function disableMcpServerForResolutionFailure(
  config: Record<string, unknown>,
  fieldPath: readonly string[]
): void {
  if (fieldPath[0] !== 'overrides' || fieldPath[1] !== 'mcp') return;
  const serverName = fieldPath[2];
  if (!serverName) return;

  const mcp = isPlainRecord(config.mcp) ? config.mcp : null;
  if (!mcp || !hasOwn(mcp, serverName) || !isPlainRecord(mcp[serverName])) return;

  Object.defineProperty(mcp[serverName], 'enabled', {
    value: false,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
