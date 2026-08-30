import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import type { SyncConfig } from './config.js';
import {
  canCommitMcpSecrets,
  chmodIfExists,
  deepMerge,
  isTursoSessionBackend,
  normalizeSecretsBackend,
  normalizeSessionBackend,
  normalizeSyncConfig,
  parseJsonc,
  sanitizeRepoUrl,
  stripOverrides,
} from './config.js';

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

  it('strips override object keys missing from local config even when present in base', () => {
    const base = {
      mcp: { context7: { url: 'https://example.com' } },
      server: { port: 8080, hostname: '0.0.0.0' },
    };
    const overrides = {
      mcp: { context7: { headers: { apiKey: 'local-key' } } },
      server: { port: 8080, hostname: '0.0.0.0' },
    };
    const local = {
      mcp: { context7: { url: 'https://example.com', headers: { apiKey: 'local-key' } } },
    };

    const stripped = stripOverrides(local, overrides, base);

    expect(stripped).not.toHaveProperty('server');
    expect(stripped).toEqual({
      mcp: { context7: { url: 'https://example.com' } },
    });
  });

  it('strips override scalar keys missing from local config even when present in base', () => {
    const base = { theme: 'dark', port: 3000 };
    const overrides = { theme: 'light', port: 8080 };
    const local = { theme: 'light' };

    const stripped = stripOverrides(local, overrides, base);

    expect(stripped).not.toHaveProperty('port');
    expect(stripped).toEqual({ theme: 'dark' });
  });

  it('strips override keys from local when present in local and base', () => {
    const base = { theme: 'dark', editor: 'vim' };
    const overrides = { theme: 'light', editor: 'code' };
    const local = { theme: 'light', editor: 'code', extra: true };

    const stripped = stripOverrides(local, overrides, base);

    expect(stripped).toEqual({ theme: 'dark', editor: 'vim', extra: true });
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

  it('enables model favorites by default', () => {
    const normalized = normalizeSyncConfig({});
    expect(normalized.includeModelFavorites).toBe(true);
  });

  it('enables skills and home .agents by default', () => {
    const normalized = normalizeSyncConfig({});
    expect(normalized.includeOpencodeSkills).toBe(true);
    expect(normalized.includeAgentsDir).toBe(true);
  });

  it('allows disabling skills and home .agents', () => {
    const normalized = normalizeSyncConfig({
      includeOpencodeSkills: false,
      includeAgentsDir: false,
    });
    expect(normalized.includeOpencodeSkills).toBe(false);
    expect(normalized.includeAgentsDir).toBe(false);
  });

  it('defaults extra path lists when omitted', () => {
    const normalized = normalizeSyncConfig({ includeSecrets: true });
    expect(normalized.extraSecretPaths).toEqual([]);
    expect(normalized.extraConfigPaths).toEqual([]);
  });

  it('defaults session backend to git', () => {
    const normalized = normalizeSyncConfig({ includeSessions: true });
    expect(normalized.sessionBackend.type).toBe('git');
    expect(normalized.sessionBackend.turso.syncIntervalSec).toBe(15);
    expect(normalized.sessionBackend.turso.autoSetup).toBe(true);
  });

  it('does not accept a synced privacy acknowledgement', () => {
    const normalized = normalizeSyncConfig({
      repo: {
        url: 'ssh://git@git.example.com/team/config.git',
        privateRemoteAcknowledged: true,
      },
    } as unknown as SyncConfig);

    expect(normalized.repo).toEqual({
      url: 'ssh://git@git.example.com/team/config.git',
      branch: undefined,
    });
  });

  it('treats an explicit URL as authoritative over owner/name metadata', () => {
    const normalized = normalizeSyncConfig({
      repo: {
        url: 'ssh://git@gitlab.example/team/config.git',
        owner: 'trusted-github-owner',
        name: 'trusted-private-repo',
      },
    });

    expect(normalized.repo).toEqual({
      url: 'ssh://git@gitlab.example/team/config.git',
      branch: undefined,
    });
  });

  it('normalizes turso backend settings', () => {
    const normalized = normalizeSyncConfig({
      includeSessions: true,
      sessionBackend: {
        type: 'turso',
        turso: {
          database: 'my-db',
          url: 'libsql://my-db.turso.io',
          syncIntervalSec: 8.7,
          autoSetup: false,
        },
      },
    });

    expect(normalized.sessionBackend).toEqual({
      type: 'turso',
      turso: {
        database: 'my-db',
        url: 'libsql://my-db.turso.io',
        syncIntervalSec: 8,
        autoSetup: false,
      },
    });
  });
});

describe('sanitizeRepoUrl', () => {
  it('accepts credential-free HTTPS, SSH, SCP, file, and absolute remotes', () => {
    expect(sanitizeRepoUrl('https://gitlab.com/team/config.git')).toBe(
      'https://gitlab.com/team/config.git'
    );
    expect(sanitizeRepoUrl('ssh://git@gitlab.com/team/config.git')).toBe(
      'ssh://git@gitlab.com/team/config.git'
    );
    expect(sanitizeRepoUrl('git@gitlab.com:team/config.git')).toBe(
      'git@gitlab.com:team/config.git'
    );
    expect(sanitizeRepoUrl('file:///tmp/config.git')).toBe('file:///tmp/config.git');
    expect(sanitizeRepoUrl('/tmp/config.git')).toBe('/tmp/config.git');
  });

  it('rejects embedded credentials and URL parameters', () => {
    expect(() => sanitizeRepoUrl('https://user:secret@gitlab.com/team/config.git')).toThrow(
      'must not contain embedded credentials'
    );
    expect(() => sanitizeRepoUrl('https://gitlab.com/team/config.git?token=secret')).toThrow(
      'must not contain embedded credentials'
    );
    expect(() => sanitizeRepoUrl('ssh://git:secret@gitlab.com/team/config.git')).toThrow(
      'must not contain embedded passwords'
    );
    expect(() => sanitizeRepoUrl('https://gitlab.com/team/config.git\nsecret')).toThrow(
      'control characters'
    );
  });
});

describe('normalizeSessionBackend', () => {
  it('falls back to git when type is missing or invalid', () => {
    expect(normalizeSessionBackend(undefined).type).toBe('git');
    expect(
      normalizeSessionBackend({
        type: 'git',
      }).type
    ).toBe('git');
  });
});

describe('isTursoSessionBackend', () => {
  it('requires includeSessions and turso type', () => {
    expect(
      isTursoSessionBackend({
        includeSessions: false,
        sessionBackend: { type: 'turso' },
      })
    ).toBe(false);
    expect(
      isTursoSessionBackend({
        includeSessions: true,
        sessionBackend: { type: 'git' },
      })
    ).toBe(false);
    expect(
      isTursoSessionBackend({
        includeSessions: true,
        sessionBackend: { type: 'turso' },
      })
    ).toBe(true);
  });
});

describe('normalizeSecretsBackend', () => {
  it('returns undefined when backend is missing', () => {
    expect(normalizeSecretsBackend(undefined)).toBeUndefined();
  });

  it('preserves unknown backend types for validation', () => {
    const unknownBackend = { type: 'unknown' } as unknown as SyncConfig['secretsBackend'];
    expect(normalizeSecretsBackend(unknownBackend)).toEqual({ type: 'unknown' });
  });

  it('normalizes 1password documents', () => {
    const raw = {
      type: '1password',
      vault: 'Personal',
      documents: {
        authJson: 'auth.json',
        mcpAuthJson: 'mcp-auth.json',
        extra: 'ignored',
      },
    } as unknown as SyncConfig['secretsBackend'];

    expect(normalizeSecretsBackend(raw)).toEqual({
      type: '1password',
      vault: 'Personal',
      documents: {
        authJson: 'auth.json',
        mcpAuthJson: 'mcp-auth.json',
      },
    });
  });
});

describe('canCommitMcpSecrets', () => {
  it('requires includeSecrets and includeMcpSecrets', () => {
    expect(canCommitMcpSecrets({ includeSecrets: false, includeMcpSecrets: true })).toBe(false);
    expect(canCommitMcpSecrets({ includeSecrets: true, includeMcpSecrets: false })).toBe(false);
    expect(canCommitMcpSecrets({ includeSecrets: true, includeMcpSecrets: true })).toBe(true);
  });
});

describe('parseJsonc', () => {
  it('parses JSONC with comments and trailing commas', () => {
    const input = `{
      // comment
      "repo": {
        "owner": "me",
        "name": "opencode-config",
      },
      "includeSecrets": false,
      "extraSecretPaths": [
        "foo",
      ],
      "extraConfigPaths": [
        "bar",
      ],
    }`;

    expect(parseJsonc(input)).toEqual({
      repo: { owner: 'me', name: 'opencode-config' },
      includeSecrets: false,
      extraSecretPaths: ['foo'],
      extraConfigPaths: ['bar'],
    });
  });
});

describe('chmodIfExists', () => {
  it('ignores missing paths', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-sync-'));
    try {
      const missingPath = path.join(tempDir, 'missing.txt');
      await expect(chmodIfExists(missingPath, 0o600)).resolves.toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
