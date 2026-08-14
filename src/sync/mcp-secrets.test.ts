import { describe, expect, it } from 'vitest';

import { assertNoLiteralSecrets, extractMcpSecrets } from './mcp-secrets.js';

describe('extractMcpSecrets', () => {
  it('moves MCP header secrets into overrides and adds env placeholders', () => {
    const input = {
      mcp: {
        context7: {
          type: 'remote',
          url: 'https://mcp.context7.com/mcp',
          headers: {
            CONTEXT7_API_KEY: 'ctx7-secret',
          },
        },
      },
    };

    const { sanitizedConfig, secretOverrides } = extractMcpSecrets(input);

    expect(secretOverrides).toEqual({
      mcp: {
        context7: {
          headers: {
            CONTEXT7_API_KEY: 'ctx7-secret',
          },
        },
      },
    });

    expect(sanitizedConfig).toEqual({
      mcp: {
        context7: {
          type: 'remote',
          url: 'https://mcp.context7.com/mcp',
          headers: {
            CONTEXT7_API_KEY: '{env:CONTEXT7_API_KEY}',
          },
        },
      },
    });
  });

  it('leaves env placeholders intact and skips overrides', () => {
    const input = {
      mcp: {
        context7: {
          headers: {
            CONTEXT7_API_KEY: '{env:CONTEXT7_API_KEY}',
          },
        },
      },
    };

    const { sanitizedConfig, secretOverrides } = extractMcpSecrets(input);

    expect(secretOverrides).toEqual({});
    expect(sanitizedConfig).toEqual(input);
  });

  it('leaves file placeholders intact and skips overrides', () => {
    const input = {
      mcp: {
        context7: {
          headers: {
            CONTEXT7_API_KEY: '{file:~/.config/opencode/secrets/context7}',
          },
        },
      },
    };

    const { sanitizedConfig, secretOverrides } = extractMcpSecrets(input);

    expect(secretOverrides).toEqual({});
    expect(sanitizedConfig).toEqual(input);
  });

  it('handles bearer authorization and oauth client secrets', () => {
    const input = {
      mcp: {
        github: {
          headers: {
            Authorization: 'Bearer ghp_example',
          },
          oauth: {
            clientId: 'public',
            clientSecret: 'super-secret',
          },
        },
      },
    };

    const { sanitizedConfig, secretOverrides } = extractMcpSecrets(input);

    expect(secretOverrides).toEqual({
      mcp: {
        github: {
          headers: {
            Authorization: 'Bearer ghp_example',
          },
          oauth: {
            clientSecret: 'super-secret',
          },
        },
      },
    });

    expect(sanitizedConfig).toEqual({
      mcp: {
        github: {
          headers: {
            Authorization: 'Bearer {env:opencode_mcp_GITHUB_AUTHORIZATION}',
          },
          oauth: {
            clientId: 'public',
            clientSecret: '{env:opencode_mcp_GITHUB_OAUTH_CLIENT_SECRET}',
          },
        },
      },
    });
  });

  it('preserves other authorization schemes', () => {
    const input = {
      mcp: {
        gitlab: {
          headers: {
            Authorization: 'Token glpat-secret',
          },
        },
      },
    };

    const { sanitizedConfig } = extractMcpSecrets(input);

    expect(sanitizedConfig).toEqual({
      mcp: {
        gitlab: {
          headers: {
            Authorization: 'Token {env:opencode_mcp_GITLAB_AUTHORIZATION}',
          },
        },
      },
    });
  });
});

describe('assertNoLiteralSecrets', () => {
  it('allows environment and file references', () => {
    expect(() =>
      assertNoLiteralSecrets({
        provider: { demo: { options: { apiKey: '{env:DEMO_API_KEY}' } } },
        mcp: { demo: { environment: { DEMO_TOKEN: '{file:/private/demo-token}' } } },
      })
    ).not.toThrow();
  });

  it('rejects literal provider and MCP environment credentials without exposing values', () => {
    expect(() =>
      assertNoLiteralSecrets({
        provider: { demo: { options: { apiKey: 'literal-provider-key' } } },
      })
    ).toThrow('provider.demo.options.apiKey');
    expect(() =>
      assertNoLiteralSecrets({ mcp: { demo: { environment: { DEMO_TOKEN: 'literal-token' } } } })
    ).toThrow('mcp.demo.environment.DEMO_TOKEN');
  });

  it('rejects literal text surrounding an embedded reference', () => {
    expect(() =>
      assertNoLiteralSecrets({ provider: { demo: { options: { apiKey: '{env:DECOY} leaked' } } } })
    ).toThrow('provider.demo.options.apiKey');
    expect(() =>
      assertNoLiteralSecrets({
        mcp: { demo: { headers: { Authorization: 'Bearer {env:TOKEN} leaked' } } },
      })
    ).toThrow('mcp.demo.headers.Authorization');
  });
});
