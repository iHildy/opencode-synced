import { describe, expect, it } from 'vitest';
import { normalizeSyncConfig } from './config.js';
import type { SyncLocations } from './paths.js';
import {
  estimateBase64EncodedLength,
  estimateSnapshotPayloadBase64Bytes,
  extractHeadlessLoginHints,
  extractRows,
  isRetryableTursoError,
  isSnapshotPayloadSizeAllowed,
  MAX_TURSO_SNAPSHOT_BASE64_BYTES,
  resolveSessionDbPaths,
  resolveTursoCredentialPath,
  resolveTursoDatabaseName,
} from './turso.js';

function createLocations(): SyncLocations {
  return {
    xdg: {
      homeDir: '/home/test',
      configDir: '/home/test/.config',
      dataDir: '/home/test/.local/share',
      stateDir: '/home/test/.local/state',
    },
    configRoot: '/home/test/.config/opencode',
    syncConfigPath: '/home/test/.config/opencode/opencode-synced.jsonc',
    overridesPath: '/home/test/.config/opencode/opencode-synced.overrides.jsonc',
    statePath: '/home/test/.local/share/opencode/sync-state.json',
    defaultRepoDir: '/home/test/.local/share/opencode/opencode-synced/repo',
  };
}

describe('resolveTursoDatabaseName', () => {
  it('uses explicit database name when configured', () => {
    const config = normalizeSyncConfig({
      repo: { owner: 'acme', name: 'my-opencode-config' },
      includeSessions: true,
      sessionBackend: {
        type: 'turso',
        turso: {
          database: 'Custom DB Name',
        },
      },
    });

    expect(resolveTursoDatabaseName(config)).toBe('custom-db-name');
  });

  it('derives database name from repo when not explicitly configured', () => {
    const config = normalizeSyncConfig({
      repo: { owner: 'acme', name: 'my-opencode-config' },
      includeSessions: true,
      sessionBackend: { type: 'turso' },
    });

    expect(resolveTursoDatabaseName(config)).toBe('my-opencode-config-sessions');
  });
});

describe('extractHeadlessLoginHints', () => {
  it('extracts login url and code from headless output', () => {
    const text = [
      'To authenticate, open:',
      'https://auth.turso.tech/activate',
      'Then enter code: ABCD-EFGH',
    ].join('\n');

    expect(extractHeadlessLoginHints(text)).toEqual({
      url: 'https://auth.turso.tech/activate',
      code: 'ABCD-EFGH',
    });
  });
});

describe('isRetryableTursoError', () => {
  it('detects retryable errors', () => {
    expect(isRetryableTursoError(new Error('database is busy'))).toBe(true);
    expect(isRetryableTursoError(new Error('HTTP 503'))).toBe(true);
    expect(isRetryableTursoError(new Error('rate limit exceeded'))).toBe(true);
  });

  it('does not mark non-retryable errors as retryable', () => {
    expect(isRetryableTursoError(new Error('invalid auth token'))).toBe(false);
  });
});

describe('path helpers', () => {
  it('resolves credential path and session db paths', () => {
    const locations = createLocations();
    expect(resolveTursoCredentialPath(locations)).toBe(
      '/home/test/.local/share/opencode/opencode-synced/turso-session.json'
    );
    expect(resolveSessionDbPaths(locations)).toEqual({
      dbPath: '/home/test/.local/share/opencode/opencode.db',
      walPath: '/home/test/.local/share/opencode/opencode.db-wal',
      shmPath: '/home/test/.local/share/opencode/opencode.db-shm',
    });
  });
});

describe('extractRows', () => {
  it('extracts rows from top-level execute result shape', () => {
    const rows = [[{ type: 'text', value: 'hello' }]];
    expect(extractRows({ rows })).toEqual(rows);
    expect(extractRows({ result: { rows } })).toEqual(rows);
  });

  it('extracts rows from Turso v2 pipeline execute envelope', () => {
    const rows = [[{ type: 'text', value: 'hello' }]];
    expect(
      extractRows({
        type: 'ok',
        response: {
          type: 'execute',
          result: {
            rows,
          },
        },
      })
    ).toEqual(rows);
  });

  it('returns empty list when result has no rows', () => {
    expect(extractRows({ type: 'ok' })).toEqual([]);
    expect(extractRows(null)).toEqual([]);
  });
});

describe('snapshot payload sizing', () => {
  it('estimates base64 length for byte counts', () => {
    expect(estimateBase64EncodedLength(0)).toBe(0);
    expect(estimateBase64EncodedLength(1)).toBe(4);
    expect(estimateBase64EncodedLength(2)).toBe(4);
    expect(estimateBase64EncodedLength(3)).toBe(4);
    expect(estimateBase64EncodedLength(4)).toBe(8);
  });

  it('estimates combined snapshot payload size', () => {
    const total = estimateSnapshotPayloadBase64Bytes({
      dbByteLength: 4,
      walByteLength: 3,
      shmByteLength: 1,
    });
    expect(total).toBe(16);
  });

  it('checks whether snapshot payload size is within limit', () => {
    expect(isSnapshotPayloadSizeAllowed(MAX_TURSO_SNAPSHOT_BASE64_BYTES)).toBe(true);
    expect(isSnapshotPayloadSizeAllowed(MAX_TURSO_SNAPSHOT_BASE64_BYTES + 1)).toBe(false);
  });
});
