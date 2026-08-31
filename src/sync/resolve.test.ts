import { describe, expect, it } from 'vitest';

import { applyOverridesToRuntimeConfig, parseJsonc } from './config.js';

describe('applyOverridesToRuntimeConfig environment resolution', () => {
  it('resolves only local override values and preserves unrelated runtime identity', () => {
    const unrelated = {
      keep: true,
      rawPlaceholder: '{env:DO_NOT_RESOLVE}',
    };
    const config: Record<string, unknown> = {
      unrelated,
      mcp: {
        github: {
          enabled: true,
          headers: { Authorization: 'old-value' },
        },
      },
    };
    const overrides = {
      mcp: {
        github: {
          headers: { Authorization: 'Bearer {env:GITHUB_PAT}' },
          values: ['{env:GITHUB_PAT}', 42, false, null],
        },
      },
    };

    applyOverridesToRuntimeConfig(config, overrides, { GITHUB_PAT: 'secret-value' });

    expect(config.unrelated).toBe(unrelated);
    expect(config.unrelated).toEqual({
      keep: true,
      rawPlaceholder: '{env:DO_NOT_RESOLVE}',
    });
    expect(config.mcp).toEqual({
      github: {
        enabled: true,
        headers: { Authorization: 'Bearer secret-value' },
        values: ['secret-value', 42, false, null],
      },
    });
  });

  it('parses JSONC overrides before resolving placeholders', () => {
    const overrides = parseJsonc<Record<string, unknown>>(`
      {
        // Local MCP credential
        "mcp": {
          "github": {
            "headers": ["Bearer {env:GITHUB_PAT}", 7, true,],
          },
        },
      }
    `);
    const config: Record<string, unknown> = {};

    applyOverridesToRuntimeConfig(config, overrides, { GITHUB_PAT: 'jsonc-secret' });

    expect(config).toEqual({
      mcp: {
        github: {
          headers: ['Bearer jsonc-secret', 7, true],
        },
      },
    });
  });

  it('rejects a missing environment variable with its override field path', () => {
    const config = { untouched: true };
    const overrides = {
      mcp: {
        github: {
          headers: { Authorization: 'Bearer {env:MISSING_PAT}' },
        },
      },
    };

    expect(() => applyOverridesToRuntimeConfig(config, overrides, {})).toThrow(
      'Missing environment variable "MISSING_PAT" required by local override ' +
        '"overrides.mcp.github.headers.Authorization".'
    );
    expect(config).toEqual({ untouched: true });
  });

  it('rejects an empty environment variable with its array field path', () => {
    const config: Record<string, unknown> = {};
    const overrides = { headers: ['{env:EMPTY_TOKEN}'] };

    expect(() => applyOverridesToRuntimeConfig(config, overrides, { EMPTY_TOKEN: '' })).toThrow(
      'Environment variable "EMPTY_TOKEN" required by local override ' +
        '"overrides.headers[0]" is empty.'
    );
  });

  it('rejects __proto__ override keys without mutating object prototypes', () => {
    const config: Record<string, unknown> = {};
    const overrides = JSON.parse('{"__proto__":{"polluted":"yes"}}') as Record<string, unknown>;

    expect(() => applyOverridesToRuntimeConfig(config, overrides, {})).toThrow(
      'Unsafe local override field "overrides.__proto__" is not allowed.'
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(config)).toBe(Object.prototype);
  });
});
