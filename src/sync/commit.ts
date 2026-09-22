import type { PluginInput } from '@opencode-ai/plugin';

import {
  type AiProvider,
  buildCommitPrompt,
  commitFallbackMessage,
  createV1AiProvider,
  sanitizeCommitMessage,
} from './ai.js';

type Shell = PluginInput['$'];

interface CommitContext {
  client: PluginInput['client'];
  $: Shell;
  ai?: AiProvider;
}

export async function generateCommitMessage(
  ctx: CommitContext,
  repoDir: string,
  fallbackDate = new Date()
): Promise<string> {
  const fallback = commitFallbackMessage(fallbackDate);

  const diffSummary = await getDiffSummary(ctx.$, repoDir);
  if (!diffSummary) return fallback;

  const ai = ctx.ai ?? createV1AiProvider(ctx.client);
  const model = await ai.resolveModel();
  if (!model) return fallback;

  const message = await ai.generateText(model, buildCommitPrompt(diffSummary));
  if (!message) return fallback;

  const sanitized = sanitizeCommitMessage(message);
  return sanitized || fallback;
}

async function getDiffSummary($: Shell, repoDir: string): Promise<string> {
  try {
    const nameStatus = await $`git -C ${repoDir} diff --name-status`.quiet().text();
    const stats = await $`git -C ${repoDir} diff --stat`.quiet().text();
    return [nameStatus.trim(), stats.trim()].filter(Boolean).join('\n');
  } catch {
    return '';
  }
}
