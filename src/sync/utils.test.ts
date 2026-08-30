import type { PluginInput } from '@opencode-ai/plugin';
import { describe, expect, it, vi } from 'vitest';

import { resolveSmallModel } from './utils.js';

type Client = PluginInput['client'];

function createClient(config: { small_model?: string; model?: string } | null): Client {
  return {
    config: {
      get: vi.fn().mockResolvedValue(config ? { data: config } : { data: null }),
    },
  } as unknown as Client;
}

describe('resolveSmallModel', () => {
  it('resolves a standard small_model selector', async () => {
    const client = createClient({ small_model: 'openai/gpt-5.5-fast' });

    await expect(resolveSmallModel(client)).resolves.toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.5-fast',
    });
  });

  it('preserves nested model IDs in small_model', async () => {
    const client = createClient({ small_model: 'openrouter/openrouter/free:exacto' });

    await expect(resolveSmallModel(client)).resolves.toEqual({
      providerID: 'openrouter',
      modelID: 'openrouter/free:exacto',
    });
  });

  it('falls back to model when small_model is missing', async () => {
    const client = createClient({ model: 'openrouter/models/with/multiple/segments' });

    await expect(resolveSmallModel(client)).resolves.toEqual({
      providerID: 'openrouter',
      modelID: 'models/with/multiple/segments',
    });
  });

  it.each([
    { label: 'missing separator', value: 'openai' },
    { label: 'leading separator', value: '/gpt-5.5-fast' },
    { label: 'trailing separator', value: 'openai/' },
  ])('returns null for $label', async ({ value }) => {
    const client = createClient({ small_model: value });

    await expect(resolveSmallModel(client)).resolves.toBeNull();
  });
});
