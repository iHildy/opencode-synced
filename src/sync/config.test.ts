import { describe, expect, it } from 'vitest';

import { canCommitMcpSecrets, deepMerge, normalizeSyncConfig, stripOverrides } from './config.js';

describe('deepMerge', () => {
  it('merges nested objects and replaces arrays', () => {
    const base = { a: 1, nested: { x: 1, y: 2 }, list: [1] };
    const override = { b: 2, nested: { y: 3 }, list: [2] };

    const merged = deepMerge(base, override);

    expect(merged).toEqual({
      a: 1,
      b: 2,
      nested: { x: 1, y: 3 },
      list: [2],
    });
  });
});

describe('stripOverrides', () => {
  it('removes override keys and restores base values', () => {
    const base = {
      theme: 'opencode',
      provider: { openai: { apiKey: 'base', models: { tiny: true } } },
    };
    const overrides = {
      provider: { openai: { apiKey: 'local' } },
    };
    const local = deepMerge(base, overrides) as Record<string, unknown>;

    const stripped = stripOverrides(local, overrides, base);

    expect(stripped).toEqual(base);
  });

  it('drops override-only keys not present in base', () => {
    const base = { theme: 'opencode' };
    const overrides = { theme: 'local', editor: 'vim' };
    const local = { theme: 'local', editor: 'vim', other: true };

    const stripped = stripOverrides(local, overrides, base);

    expect(stripped).toEqual({ theme: 'opencode', other: true });
  });
});

describe('normalizeSyncConfig', () => {
  it('disables MCP secrets when secrets are disabled', () => {
    const normalized = normalizeSyncConfig({
      includeSecrets: false,
      includeMcpSecrets: true,
    });
    expect(normalized.includeMcpSecrets).toBe(false);
  });

  it('allows MCP secrets when secrets are enabled', () => {
    const normalized = normalizeSyncConfig({
      includeSecrets: true,
      includeMcpSecrets: true,
    });
    expect(normalized.includeMcpSecrets).toBe(true);
  });
});

describe('canCommitMcpSecrets', () => {
  it('requires includeSecrets and includeMcpSecrets', () => {
    expect(canCommitMcpSecrets({ includeSecrets: false, includeMcpSecrets: true })).toBe(false);
    expect(canCommitMcpSecrets({ includeSecrets: true, includeMcpSecrets: false })).toBe(false);
    expect(canCommitMcpSecrets({ includeSecrets: true, includeMcpSecrets: true })).toBe(true);
  });
});
