import { describe, expect, it } from 'vitest';

import { extractMcpSecrets, McpSecretExtractionError } from './mcp-secrets.js';

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

  it('rejects an own __proto__ server name before creating scrubbed output', () => {
    const input = JSON.parse(
      '{"mcp":{"__proto__":{"headers":{"Authorization":"Bearer secret"}}}}'
    ) as Record<string, unknown>;

    expect(() => extractMcpSecrets(input)).toThrow(
      'Unsafe MCP server field "mcp.__proto__" is not allowed during secret scrubbing.'
    );
    expect(({} as Record<string, unknown>).headers).toBeUndefined();
  });

  it.each([
    [0],
    [false],
    [null],
    [[]],
    [{}],
  ])('rejects a non-string header credential %j with field context', (invalidValue) => {
    const input = {
      mcp: {
        github: {
          headers: { Authorization: invalidValue },
        },
      },
    };

    expect(() => extractMcpSecrets(input)).toThrow(
      new McpSecretExtractionError(
        'MCP credential field "mcp.github.headers.Authorization" must be a string before it ' +
          'can be synchronized.'
      )
    );
  });

  it('rejects an empty header credential with field context', () => {
    const input = {
      mcp: { github: { headers: { Authorization: '' } } },
    };

    expect(() => extractMcpSecrets(input)).toThrow(
      'MCP credential field "mcp.github.headers.Authorization" must not be empty before it can be ' +
        'synchronized.'
    );
  });

  it('rejects a non-string OAuth client secret with field context', () => {
    const input = {
      mcp: {
        github: {
          oauth: { clientSecret: ['not', 'a', 'string'] },
        },
      },
    };

    expect(() => extractMcpSecrets(input)).toThrow(
      'MCP credential field "mcp.github.oauth.clientSecret" must be a string before it can be ' +
        'synchronized.'
    );
  });

  it('rejects an empty OAuth client secret with field context', () => {
    const input = {
      mcp: { github: { oauth: { clientSecret: '' } } },
    };

    expect(() => extractMcpSecrets(input)).toThrow(
      'MCP credential field "mcp.github.oauth.clientSecret" must not be empty before it can be ' +
        'synchronized.'
    );
  });
});
