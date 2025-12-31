import { describe, expect, it } from 'vitest';

import { extractMcpSecrets } from './mcp-secrets.js';

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
            Authorization: 'Bearer {env:OPENCODE_MCP_GITHUB_AUTHORIZATION}',
          },
          oauth: {
            clientId: 'public',
            clientSecret: '{env:OPENCODE_MCP_GITHUB_OAUTH_CLIENT_SECRET}',
          },
        },
      },
    });
  });
});
