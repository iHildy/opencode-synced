import type { PluginInput } from '@opencode-ai/plugin';

import { extractTextFromResponse, resolveSmallModel, unwrapData } from './utils.js';

export interface AiModelRef {
  providerID: string;
  modelID: string;
}

export interface AiProvider {
  resolveModel: () => Promise<AiModelRef | null>;
  generateText: (_model: AiModelRef, _prompt: string) => Promise<string | null>;
}

export interface ResolutionDecision {
  action: 'commit' | 'reset' | 'manual';
  message?: string;
  reason?: string;
}

type V1Client = PluginInput['client'];

/** Throwaway-session AI flow used on opencode v1. */
export function createV1AiProvider(client: V1Client): AiProvider {
  return {
    resolveModel: () => resolveSmallModel(client),
    generateText: async (model, prompt) => {
      let sessionId: string | null = null;
      try {
        const sessionResult = await client.session.create({ body: { title: 'opencode-synced' } });
        const session = unwrapData<{ id: string }>(sessionResult);
        sessionId = session?.id ?? null;
        if (!sessionId) return null;

        const response = await client.session.prompt({
          path: { id: sessionId },
          body: {
            model,
            parts: [{ type: 'text', text: prompt }],
          },
        });

        return extractTextFromResponse(unwrapData(response) ?? response);
      } catch {
        return null;
      } finally {
        if (sessionId) {
          try {
            await client.session.delete({ path: { id: sessionId } });
          } catch {}
        }
      }
    },
  };
}

export function buildCommitPrompt(diffSummary: string): string {
  return [
    'Generate a concise single-line git commit message (max 72 chars).',
    'Focus on opencode config sync changes.',
    'Return only the message, no quotes.',
    '',
    'Diff summary:',
    diffSummary,
  ].join('\n');
}

export function sanitizeCommitMessage(message: string): string {
  const firstLine = message.split('\n')[0].trim();
  const trimmed = firstLine.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!trimmed) return '';
  if (trimmed.length <= 72) return trimmed;
  return trimmed.slice(0, 72).trim();
}

export function commitFallbackMessage(date: Date = new Date()): string {
  return `Sync opencode config (${formatDate(date)})`;
}

export function buildResolvePrompt(statusOutput: string, diffPreview: string): string {
  return [
    'You are analyzing uncommitted changes in an opencode-synced repository.',
    'Decide whether to commit these changes or discard them.',
    '',
    'IMPORTANT: Only choose "commit" if the changes appear to be legitimate config updates.',
    'Choose "discard" if the changes look like temporary files, cache, or corruption.',
    '',
    'Respond with ONLY a JSON object in this exact format:',
    '{"action": "commit", "message": "your commit message here"}',
    'OR',
    '{"action": "discard", "reason": "explanation why discarding"}',
    '',
    'Status:',
    statusOutput,
    '',
    'Diff preview (first 2000 chars):',
    diffPreview,
  ].join('\n');
}

export function parseResolutionDecision(text: string): ResolutionDecision {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { action: 'manual', reason: 'Could not parse AI response' };
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      action?: string;
      message?: string;
      reason?: string;
    };

    if (parsed.action === 'commit' && parsed.message) {
      return { action: 'commit', message: parsed.message };
    }

    if (parsed.action === 'discard') {
      return { action: 'reset', reason: parsed.reason };
    }

    return { action: 'manual', reason: 'Unexpected AI response format' };
  } catch {
    return { action: 'manual', reason: 'Failed to parse AI decision' };
  }
}

function formatDate(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
