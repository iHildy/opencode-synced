import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncLocalToRepo, syncRepoToLocal } from './apply.js';
import type { SyncConfig } from './config.js';
import { loadOverrides, normalizeSyncConfig, parseJsonc } from './config.js';
import type { ExtraPathPlan, SyncItem, SyncPlan } from './paths.js';
import { buildSyncPlan, resolveSyncLocations } from './paths.js';

const EMPTY_EXTRA_PLAN: ExtraPathPlan = {
  allowlist: [],
  manifestPath: '',
  entries: [],
};

afterEach(() => {
  vi.restoreAllMocks();
});

function createPlan(repoRoot: string, homeDir: string, items: SyncItem[]): SyncPlan {
  return {
    items,
    extraSecrets: {
      ...EMPTY_EXTRA_PLAN,
      manifestPath: path.join(repoRoot, 'secrets', 'extra.json'),
    },
    extraConfigs: {
      ...EMPTY_EXTRA_PLAN,
      manifestPath: path.join(repoRoot, 'config', 'extra.json'),
    },
    repoRoot,
    homeDir,
    platform: 'linux',
  };
}

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'opencode-sync-apply-'));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe('syncLocalToRepo preserveWhenMissing', () => {
  it('copies updated opencode.db from local to repo when present', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      const localRoot = path.join(root, 'local');
      const repoDbPath = path.join(repoRoot, 'data', 'opencode.db');
      const localDbPath = path.join(localRoot, 'opencode.db');
      await fs.mkdir(path.dirname(repoDbPath), { recursive: true });
      await fs.mkdir(path.dirname(localDbPath), { recursive: true });
      await fs.writeFile(repoDbPath, 'old-db-content', 'utf8');
      await fs.writeFile(localDbPath, 'new-db-content', 'utf8');

      const plan = createPlan(repoRoot, localRoot, [
        {
          localPath: localDbPath,
          repoPath: repoDbPath,
          type: 'file',
          isSecret: true,
          isConfigFile: false,
          preserveWhenMissing: true,
        },
      ]);

      await syncLocalToRepo(plan, null);

      const content = await fs.readFile(repoDbPath, 'utf8');
      expect(content).toBe('new-db-content');
    });
  });

  it('copies sqlite sidecars with opencode.db when present', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      const localRoot = path.join(root, 'local');
      const repoDbPath = path.join(repoRoot, 'data', 'opencode.db');
      const localDbPath = path.join(localRoot, 'opencode.db');
      await fs.mkdir(path.dirname(repoDbPath), { recursive: true });
      await fs.mkdir(path.dirname(localDbPath), { recursive: true });
      await fs.writeFile(localDbPath, 'new-db-content', 'utf8');
      await fs.writeFile(`${localDbPath}-wal`, 'new-wal-content', 'utf8');
      await fs.writeFile(`${localDbPath}-shm`, 'new-shm-content', 'utf8');

      const plan = createPlan(repoRoot, localRoot, [
        {
          localPath: localDbPath,
          repoPath: repoDbPath,
          type: 'file',
          isSecret: true,
          isConfigFile: false,
          preserveWhenMissing: true,
        },
      ]);

      await syncLocalToRepo(plan, null);

      await expect(fs.readFile(repoDbPath, 'utf8')).resolves.toBe('new-db-content');
      await expect(fs.readFile(`${repoDbPath}-wal`, 'utf8')).resolves.toBe('new-wal-content');
      await expect(fs.readFile(`${repoDbPath}-shm`, 'utf8')).resolves.toBe('new-shm-content');
    });
  });

  it('keeps repo opencode.db when local file is missing', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      const localRoot = path.join(root, 'local');
      const repoDbPath = path.join(repoRoot, 'data', 'opencode.db');
      await fs.mkdir(path.dirname(repoDbPath), { recursive: true });
      await fs.writeFile(repoDbPath, 'remote-db-content', 'utf8');
      await fs.writeFile(`${repoDbPath}-wal`, 'remote-wal-content', 'utf8');
      await fs.writeFile(`${repoDbPath}-shm`, 'remote-shm-content', 'utf8');

      const plan = createPlan(repoRoot, localRoot, [
        {
          localPath: path.join(localRoot, 'opencode.db'),
          repoPath: repoDbPath,
          type: 'file',
          isSecret: true,
          isConfigFile: false,
          preserveWhenMissing: true,
        },
      ]);

      await syncLocalToRepo(plan, null);

      const content = await fs.readFile(repoDbPath, 'utf8');
      expect(content).toBe('remote-db-content');
      await expect(fs.readFile(`${repoDbPath}-wal`, 'utf8')).resolves.toBe('remote-wal-content');
      await expect(fs.readFile(`${repoDbPath}-shm`, 'utf8')).resolves.toBe('remote-shm-content');
    });
  });

  it('removes stale sqlite sidecars when local opencode.db has none', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      const localRoot = path.join(root, 'local');
      const repoDbPath = path.join(repoRoot, 'data', 'opencode.db');
      const localDbPath = path.join(localRoot, 'opencode.db');
      await fs.mkdir(path.dirname(repoDbPath), { recursive: true });
      await fs.mkdir(path.dirname(localDbPath), { recursive: true });
      await fs.writeFile(repoDbPath, 'old-db-content', 'utf8');
      await fs.writeFile(`${repoDbPath}-wal`, 'stale-wal-content', 'utf8');
      await fs.writeFile(`${repoDbPath}-shm`, 'stale-shm-content', 'utf8');
      await fs.writeFile(localDbPath, 'fresh-db-content', 'utf8');

      const plan = createPlan(repoRoot, localRoot, [
        {
          localPath: localDbPath,
          repoPath: repoDbPath,
          type: 'file',
          isSecret: true,
          isConfigFile: false,
          preserveWhenMissing: true,
        },
      ]);

      await syncLocalToRepo(plan, null);

      await expect(fs.readFile(repoDbPath, 'utf8')).resolves.toBe('fresh-db-content');
      await expect(fs.stat(`${repoDbPath}-wal`)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(`${repoDbPath}-shm`)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('keeps repo legacy session directory when local directory is missing', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      const localRoot = path.join(root, 'local');
      const repoSessionPath = path.join(repoRoot, 'data', 'storage', 'session');
      const repoSessionFile = path.join(repoSessionPath, 'session-1.json');
      await fs.mkdir(repoSessionPath, { recursive: true });
      await fs.writeFile(repoSessionFile, '{"id":"session-1"}', 'utf8');

      const plan = createPlan(repoRoot, localRoot, [
        {
          localPath: path.join(localRoot, 'storage', 'session'),
          repoPath: repoSessionPath,
          type: 'dir',
          isSecret: true,
          isConfigFile: false,
          preserveWhenMissing: true,
        },
      ]);

      await syncLocalToRepo(plan, null);

      const content = await fs.readFile(repoSessionFile, 'utf8');
      expect(content).toBe('{"id":"session-1"}');
    });
  });

  it('still deletes non-session items when local source is missing', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      const localRoot = path.join(root, 'local');
      const repoFilePath = path.join(repoRoot, 'data', 'auth.json');
      await fs.mkdir(path.dirname(repoFilePath), { recursive: true });
      await fs.writeFile(repoFilePath, '{"token":"value"}', 'utf8');

      const plan = createPlan(repoRoot, localRoot, [
        {
          localPath: path.join(localRoot, 'auth.json'),
          repoPath: repoFilePath,
          type: 'file',
          isSecret: true,
          isConfigFile: false,
        },
      ]);

      await syncLocalToRepo(plan, null);

      await expect(fs.stat(repoFilePath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});

describe('syncRepoToLocal for session database', () => {
  it('copies opencode.db and sqlite sidecars from repo to local', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      const localRoot = path.join(root, 'local');
      const repoDbPath = path.join(repoRoot, 'data', 'opencode.db');
      const localDbPath = path.join(localRoot, 'opencode.db');
      await fs.mkdir(path.dirname(repoDbPath), { recursive: true });
      await fs.writeFile(repoDbPath, 'repo-db-content', 'utf8');
      await fs.writeFile(`${repoDbPath}-wal`, 'repo-wal-content', 'utf8');
      await fs.writeFile(`${repoDbPath}-shm`, 'repo-shm-content', 'utf8');

      const plan = createPlan(repoRoot, localRoot, [
        {
          localPath: localDbPath,
          repoPath: repoDbPath,
          type: 'file',
          isSecret: true,
          isConfigFile: false,
          preserveWhenMissing: true,
        },
      ]);

      await syncRepoToLocal(plan, null);

      const content = await fs.readFile(localDbPath, 'utf8');
      expect(content).toBe('repo-db-content');
      await expect(fs.readFile(`${localDbPath}-wal`, 'utf8')).resolves.toBe('repo-wal-content');
      await expect(fs.readFile(`${localDbPath}-shm`, 'utf8')).resolves.toBe('repo-shm-content');
    });
  });

  it('removes stale local sqlite sidecars when repo opencode.db has none', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      const localRoot = path.join(root, 'local');
      const repoDbPath = path.join(repoRoot, 'data', 'opencode.db');
      const localDbPath = path.join(localRoot, 'opencode.db');
      await fs.mkdir(path.dirname(repoDbPath), { recursive: true });
      await fs.mkdir(path.dirname(localDbPath), { recursive: true });
      await fs.writeFile(repoDbPath, 'repo-db-content', 'utf8');
      await fs.writeFile(localDbPath, 'old-db-content', 'utf8');
      await fs.writeFile(`${localDbPath}-wal`, 'stale-wal-content', 'utf8');
      await fs.writeFile(`${localDbPath}-shm`, 'stale-shm-content', 'utf8');

      const plan = createPlan(repoRoot, localRoot, [
        {
          localPath: localDbPath,
          repoPath: repoDbPath,
          type: 'file',
          isSecret: true,
          isConfigFile: false,
          preserveWhenMissing: true,
        },
      ]);

      await syncRepoToLocal(plan, null);

      await expect(fs.readFile(localDbPath, 'utf8')).resolves.toBe('repo-db-content');
      await expect(fs.stat(`${localDbPath}-wal`)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(`${localDbPath}-shm`)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});

describe('relative extra paths', () => {
  it('syncs config and secret files and directories from an unrelated cwd', async () => {
    await withTempDir(async (root) => {
      const homeDir = path.join(root, 'home');
      const configRoot = path.join(homeDir, '.config', 'opencode');
      const repoRoot = path.join(root, 'repo');
      const unrelatedCwd = path.join(root, 'unrelated-cwd');
      const configFile = path.join(configRoot, 'SOUL.md');
      const configDirectory = path.join(configRoot, 'custom-configs');
      const secretFile = path.join(configRoot, 'credentials', 'token.json');
      const secretDirectory = path.join(configRoot, 'private-agents');
      await fs.mkdir(configDirectory, { recursive: true });
      await fs.mkdir(path.dirname(secretFile), { recursive: true });
      await fs.mkdir(secretDirectory, { recursive: true });
      await fs.mkdir(unrelatedCwd, { recursive: true });
      await fs.writeFile(configFile, 'config-file', 'utf8');
      await fs.writeFile(path.join(configDirectory, 'custom.md'), 'config-directory', 'utf8');
      await fs.writeFile(secretFile, 'secret-file', 'utf8');
      await fs.writeFile(path.join(secretDirectory, 'private.md'), 'secret-directory', 'utf8');

      const locations = resolveSyncLocations({ HOME: homeDir }, 'linux');
      const config: SyncConfig = {
        repo: { owner: 'acme', name: 'config' },
        includeSecrets: true,
        extraConfigPaths: ['SOUL.md', 'custom-configs'],
        extraSecretPaths: ['credentials/token.json', 'private-agents'],
      };
      const originalCwd = process.cwd();

      try {
        process.chdir(unrelatedCwd);
        const plan = buildSyncPlan(normalizeSyncConfig(config), locations, repoRoot, 'linux');
        await syncLocalToRepo(plan, null);

        const configManifest = JSON.parse(
          await fs.readFile(plan.extraConfigs.manifestPath, 'utf8')
        ) as {
          entries: Array<{ sourcePath: string; repoPath: string; type: 'file' | 'dir' }>;
        };
        const secretManifest = JSON.parse(
          await fs.readFile(plan.extraSecrets.manifestPath, 'utf8')
        ) as {
          entries: Array<{ sourcePath: string; repoPath: string; type: 'file' | 'dir' }>;
        };

        expect(configManifest.entries.map((entry) => [entry.sourcePath, entry.type])).toEqual([
          [configFile, 'file'],
          [configDirectory, 'dir'],
        ]);
        expect(secretManifest.entries.map((entry) => [entry.sourcePath, entry.type])).toEqual([
          [secretFile, 'file'],
          [secretDirectory, 'dir'],
        ]);

        const configRepoPaths = new Map(
          configManifest.entries.map((entry) => [
            entry.sourcePath,
            path.join(repoRoot, entry.repoPath),
          ])
        );
        const secretRepoPaths = new Map(
          secretManifest.entries.map((entry) => [
            entry.sourcePath,
            path.join(repoRoot, entry.repoPath),
          ])
        );
        await expect(fs.readFile(configRepoPaths.get(configFile) ?? '', 'utf8')).resolves.toBe(
          'config-file'
        );
        await expect(
          fs.readFile(path.join(configRepoPaths.get(configDirectory) ?? '', 'custom.md'), 'utf8')
        ).resolves.toBe('config-directory');
        await expect(fs.readFile(secretRepoPaths.get(secretFile) ?? '', 'utf8')).resolves.toBe(
          'secret-file'
        );
        await expect(
          fs.readFile(path.join(secretRepoPaths.get(secretDirectory) ?? '', 'private.md'), 'utf8')
        ).resolves.toBe('secret-directory');
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  it('does not apply a manifest source outside the resolved allowlist', async () => {
    await withTempDir(async (root) => {
      const homeDir = path.join(root, 'home');
      const repoRoot = path.join(root, 'repo');
      const locations = resolveSyncLocations({ HOME: homeDir }, 'linux');
      const allowedPath = path.join(locations.configRoot, 'allowed.json');
      const blockedPath = path.join(locations.configRoot, 'blocked.json');
      const allowedRepoPath = path.join(repoRoot, 'config', 'extra', 'allowed.json');
      const rogueRepoPath = path.join(repoRoot, 'config', 'extra', 'rogue.json');
      await fs.mkdir(path.dirname(rogueRepoPath), { recursive: true });
      await fs.writeFile(allowedRepoPath, 'allowed-copy', 'utf8');
      await fs.writeFile(rogueRepoPath, 'must-not-copy', 'utf8');

      const config: SyncConfig = {
        repo: { owner: 'acme', name: 'config' },
        includeSecrets: false,
        extraConfigPaths: ['allowed.json'],
      };
      const plan = buildSyncPlan(normalizeSyncConfig(config), locations, repoRoot, 'linux');
      await fs.mkdir(path.dirname(plan.extraConfigs.manifestPath), { recursive: true });
      await fs.writeFile(
        plan.extraConfigs.manifestPath,
        JSON.stringify({
          entries: [
            {
              sourcePath: allowedPath,
              repoPath: path.relative(repoRoot, allowedRepoPath),
              type: 'file',
            },
            {
              sourcePath: blockedPath,
              repoPath: path.relative(repoRoot, rogueRepoPath),
              type: 'file',
            },
          ],
        }),
        'utf8'
      );

      await syncRepoToLocal(plan, null);

      await expect(fs.readFile(allowedPath, 'utf8')).resolves.toBe('allowed-copy');
      await expect(fs.stat(blockedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});

describe('chunked Git session items', () => {
  const chunkOptions = {
    thresholdBytes: 8,
    chunkBytes: 5,
    maxFileBytes: 256,
    maxChunks: 64,
    bufferBytes: 3,
  };

  it('round-trips large legacy messages without colliding with chunk-like filenames', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      const localMessageDir = path.join(root, 'local', 'storage', 'message');
      const repoMessageDir = path.join(repoRoot, 'data', 'storage', 'message');
      await fs.mkdir(localMessageDir, { recursive: true });
      await fs.writeFile(path.join(localMessageDir, 'message-1.json'), '0123456789abcdef');
      await fs.writeFile(path.join(localMessageDir, 'message-1.json.ocsync-chunk.0'), 'user-data');

      const plan = createPlan(repoRoot, path.join(root, 'local'), [
        {
          localPath: localMessageDir,
          repoPath: repoMessageDir,
          type: 'dir',
          isSecret: true,
          isConfigFile: false,
          preserveWhenMissing: true,
          chunkLargeFiles: true,
        },
      ]);
      await syncLocalToRepo(plan, null, { chunkOptions });

      await fs.rm(localMessageDir, { recursive: true });
      await syncRepoToLocal(plan, null, { chunkOptions });
      await expect(fs.readFile(path.join(localMessageDir, 'message-1.json'), 'utf8')).resolves.toBe(
        '0123456789abcdef'
      );
      await expect(
        fs.readFile(path.join(localMessageDir, 'message-1.json.ocsync-chunk.0'), 'utf8')
      ).resolves.toBe('user-data');
    });
  });

  it('does not replace an existing legacy session directory when validation fails', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      const localMessageDir = path.join(root, 'local', 'storage', 'message');
      const repoMessageDir = path.join(repoRoot, 'data', 'storage', 'message');
      await fs.mkdir(localMessageDir, { recursive: true });
      await fs.writeFile(path.join(localMessageDir, 'message-1.json'), '0123456789abcdef');
      const plan = createPlan(repoRoot, path.join(root, 'local'), [
        {
          localPath: localMessageDir,
          repoPath: repoMessageDir,
          type: 'dir',
          isSecret: true,
          isConfigFile: false,
          preserveWhenMissing: true,
          chunkLargeFiles: true,
        },
      ]);
      await syncLocalToRepo(plan, null, { chunkOptions });

      const pointer = JSON.parse(
        await fs.readFile(path.join(repoMessageDir, 'message-1.json'), 'utf8')
      ) as { id: string };
      await fs.rm(
        path.join(repoRoot, '.opencode-synced', 'chunks', 'v1', pointer.id, '000001.part')
      );
      await fs.rm(localMessageDir, { recursive: true });
      await fs.mkdir(localMessageDir, { recursive: true });
      await fs.writeFile(path.join(localMessageDir, 'existing.json'), 'keep');

      await expect(syncRepoToLocal(plan, null, { chunkOptions })).rejects.toThrow(/missing/u);
      await expect(fs.readFile(path.join(localMessageDir, 'existing.json'), 'utf8')).resolves.toBe(
        'keep'
      );
    });
  });

  it('preserves the entire destination DB bundle when a later sidecar is corrupt', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      const sourceDb = path.join(root, 'source', 'opencode.db');
      const destinationDb = path.join(root, 'destination', 'opencode.db');
      const repoDb = path.join(repoRoot, 'data', 'opencode.db');
      await fs.mkdir(path.dirname(sourceDb), { recursive: true });
      await fs.mkdir(path.dirname(destinationDb), { recursive: true });
      await fs.writeFile(sourceDb, 'new-database-content');
      await fs.writeFile(`${sourceDb}-wal`, 'new-wal-content');
      await fs.writeFile(`${sourceDb}-shm`, 'new-shm-content');

      const sourcePlan = createPlan(repoRoot, path.join(root, 'source'), [
        {
          localPath: sourceDb,
          repoPath: repoDb,
          type: 'file',
          isSecret: true,
          isConfigFile: false,
          preserveWhenMissing: true,
          chunkLargeFiles: true,
        },
      ]);
      await syncLocalToRepo(sourcePlan, null, { chunkOptions });

      const shmPointer = JSON.parse(await fs.readFile(`${repoDb}-shm`, 'utf8')) as { id: string };
      await fs.writeFile(
        path.join(repoRoot, '.opencode-synced', 'chunks', 'v1', shmPointer.id, '000000.part'),
        'xxxxx'
      );
      await fs.writeFile(destinationDb, 'old-database');
      await fs.writeFile(`${destinationDb}-wal`, 'old-wal');
      await fs.writeFile(`${destinationDb}-shm`, 'old-shm');
      const destinationPlan = createPlan(repoRoot, path.join(root, 'destination'), [
        {
          localPath: destinationDb,
          repoPath: repoDb,
          type: 'file',
          isSecret: true,
          isConfigFile: false,
          preserveWhenMissing: true,
          chunkLargeFiles: true,
        },
      ]);

      await expect(syncRepoToLocal(destinationPlan, null, { chunkOptions })).rejects.toThrow(
        /SHA-256/u
      );
      await expect(fs.readFile(destinationDb, 'utf8')).resolves.toBe('old-database');
      await expect(fs.readFile(`${destinationDb}-wal`, 'utf8')).resolves.toBe('old-wal');
      await expect(fs.readFile(`${destinationDb}-shm`, 'utf8')).resolves.toBe('old-shm');
    });
  });

  it('rolls back installed DB files when a later bundle rename fails', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      const repoDb = path.join(repoRoot, 'data', 'opencode.db');
      const destinationDb = path.join(root, 'destination', 'opencode.db');
      await fs.mkdir(path.dirname(repoDb), { recursive: true });
      await fs.mkdir(path.dirname(destinationDb), { recursive: true });
      await fs.writeFile(repoDb, 'new-db');
      await fs.writeFile(`${repoDb}-wal`, 'new-wal');
      await fs.writeFile(`${repoDb}-shm`, 'new-shm');
      await fs.writeFile(destinationDb, 'old-db');
      await fs.writeFile(`${destinationDb}-wal`, 'old-wal');
      await fs.writeFile(`${destinationDb}-shm`, 'old-shm');
      const plan = createPlan(repoRoot, path.join(root, 'destination'), [
        {
          localPath: destinationDb,
          repoPath: repoDb,
          type: 'file',
          isSecret: true,
          isConfigFile: false,
          preserveWhenMissing: true,
          chunkLargeFiles: true,
        },
      ]);

      const originalRename = fs.rename.bind(fs);
      let injected = false;
      vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
        if (
          !injected &&
          String(source).includes('.db-bundle-') &&
          String(source).endsWith('opencode.db-shm') &&
          destination === `${destinationDb}-shm`
        ) {
          injected = true;
          throw new Error('injected bundle install failure');
        }
        return originalRename(source, destination);
      });

      await expect(syncRepoToLocal(plan, null, { chunkOptions })).rejects.toThrow(/injected/u);
      await expect(fs.readFile(destinationDb, 'utf8')).resolves.toBe('old-db');
      await expect(fs.readFile(`${destinationDb}-wal`, 'utf8')).resolves.toBe('old-wal');
      await expect(fs.readFile(`${destinationDb}-shm`, 'utf8')).resolves.toBe('old-shm');
    });
  });

  it('keeps an installed DB bundle when post-commit backup cleanup fails', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      const repoDb = path.join(repoRoot, 'data', 'opencode.db');
      const destinationDb = path.join(root, 'destination', 'opencode.db');
      await fs.mkdir(path.dirname(repoDb), { recursive: true });
      await fs.mkdir(path.dirname(destinationDb), { recursive: true });
      await fs.writeFile(repoDb, 'new-db');
      await fs.writeFile(`${repoDb}-wal`, 'new-wal');
      await fs.writeFile(`${repoDb}-shm`, 'new-shm');
      await fs.writeFile(destinationDb, 'old-db');
      await fs.writeFile(`${destinationDb}-wal`, 'old-wal');
      await fs.writeFile(`${destinationDb}-shm`, 'old-shm');
      const plan = createPlan(repoRoot, path.join(root, 'destination'), [
        {
          localPath: destinationDb,
          repoPath: repoDb,
          type: 'file',
          isSecret: true,
          isConfigFile: false,
          preserveWhenMissing: true,
          chunkLargeFiles: true,
        },
      ]);

      const originalRm = fs.rm.bind(fs);
      vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
        if (String(target).includes('.db-bundle-') && String(target).endsWith('.backup')) {
          throw new Error('injected post-commit cleanup failure');
        }
        return originalRm(target, options);
      });

      await expect(syncRepoToLocal(plan, null, { chunkOptions })).resolves.toBeUndefined();
      await expect(fs.readFile(destinationDb, 'utf8')).resolves.toBe('new-db');
      await expect(fs.readFile(`${destinationDb}-wal`, 'utf8')).resolves.toBe('new-wal');
      await expect(fs.readFile(`${destinationDb}-shm`, 'utf8')).resolves.toBe('new-shm');
    });
  });
});

describe('syncing plural OpenCode config directories', () => {
  it('copies canonical plural directories between isolated homes', async () => {
    await withTempDir(async (root) => {
      const machineAHome = path.join(root, 'machine-a');
      const machineBHome = path.join(root, 'machine-b');
      const repoRoot = path.join(root, 'repo');
      const machineALocations = resolveSyncLocations({ HOME: machineAHome }, 'linux');
      const machineBLocations = resolveSyncLocations({ HOME: machineBHome }, 'linux');
      const config = normalizeSyncConfig({
        repo: { owner: 'acme', name: 'config' },
        includeSecrets: false,
        includeOpencodeSkills: false,
        includeAgentsDir: false,
        includeModelFavorites: false,
      });
      const sentinels: Record<string, string> = {
        'agents/reviewer.md': 'plural-agent',
        'commands/release.md': 'plural-command',
        'modes/focus.md': 'plural-mode',
        'plugins/local.ts': 'plural-plugin',
        'tools/lint.ts': 'plural-tool',
      };

      for (const [relativePath, content] of Object.entries(sentinels)) {
        const sourcePath = path.join(machineALocations.configRoot, relativePath);
        await fs.mkdir(path.dirname(sourcePath), { recursive: true });
        await fs.writeFile(sourcePath, content, 'utf8');
      }

      const machineAPlan = buildSyncPlan(config, machineALocations, repoRoot, 'linux');
      const machineBPlan = buildSyncPlan(config, machineBLocations, repoRoot, 'linux');
      await syncLocalToRepo(machineAPlan, null);
      await syncRepoToLocal(machineBPlan, null);

      for (const [relativePath, content] of Object.entries(sentinels)) {
        const destinationPath = path.join(machineBLocations.configRoot, relativePath);
        await expect(fs.readFile(destinationPath, 'utf8')).resolves.toBe(content);
      }
    });
  });
});

describe('MCP secret scrub round trip', () => {
  it('keeps the secret local, writes a placeholder to the repo, and protects overrides', async () => {
    await withTempDir(async (root) => {
      const homeDir = path.join(root, 'home');
      const repoRoot = path.join(root, 'repo');
      const locations = resolveSyncLocations({ HOME: homeDir }, 'linux');
      const localConfigPath = path.join(locations.configRoot, 'opencode.jsonc');
      const repoConfigPath = path.join(repoRoot, 'config', 'opencode.jsonc');
      const secret = 'focused-runtime-secret';
      await fs.mkdir(locations.configRoot, { recursive: true });
      await fs.writeFile(
        localConfigPath,
        `{
          // The secret must never reach Git.
          "mcp": {
            "github": {
              "headers": { "Authorization": "Bearer ${secret}" },
            },
          },
        }\n`,
        'utf8'
      );

      const config = normalizeSyncConfig({
        repo: { owner: 'acme', name: 'config' },
        includeOpencodeSkills: false,
        includeAgentsDir: false,
        includeModelFavorites: false,
      });
      const plan = buildSyncPlan(config, locations, repoRoot, 'linux');
      await syncLocalToRepo(plan, null, { overridesPath: locations.overridesPath });

      const repoContent = await fs.readFile(repoConfigPath, 'utf8');
      const overridesContent = await fs.readFile(locations.overridesPath, 'utf8');
      const overrideMode = (await fs.stat(locations.overridesPath)).mode & 0o777;
      expect(repoContent).toContain('Bearer {env:opencode_mcp_GITHUB_AUTHORIZATION}');
      expect(repoContent).not.toContain(secret);
      expect(overridesContent).toContain(secret);
      expect(overrideMode).toBe(0o600);

      const overrides = await loadOverrides(locations);
      expect(overrides).not.toBeNull();
      await fs.writeFile(localConfigPath, '{}\n', 'utf8');
      await syncRepoToLocal(plan, overrides);

      const restored = parseJsonc<Record<string, unknown>>(
        await fs.readFile(localConfigPath, 'utf8')
      );
      expect(restored).toEqual({
        mcp: {
          github: {
            headers: { Authorization: `Bearer ${secret}` },
          },
        },
      });
    });
  });

  it('rejects malformed credential values before mutating the synced repository', async () => {
    await withTempDir(async (root) => {
      const homeDir = path.join(root, 'home');
      const repoRoot = path.join(root, 'repo');
      const locations = resolveSyncLocations({ HOME: homeDir }, 'linux');
      const localConfigPath = path.join(locations.configRoot, 'opencode.json');
      const repoConfigPath = path.join(repoRoot, 'config', 'opencode.json');
      await fs.mkdir(path.dirname(localConfigPath), { recursive: true });
      await fs.mkdir(path.dirname(repoConfigPath), { recursive: true });
      await fs.writeFile(
        localConfigPath,
        '{"mcp":{"github":{"headers":{"Authorization":false}}}}\n',
        'utf8'
      );
      const originalRepoContent = '{"existing":"must-remain"}\n';
      await fs.writeFile(repoConfigPath, originalRepoContent, 'utf8');
      const config = normalizeSyncConfig({
        repo: { owner: 'acme', name: 'config' },
        includeOpencodeSkills: false,
        includeAgentsDir: false,
        includeModelFavorites: false,
      });
      const plan = buildSyncPlan(config, locations, repoRoot, 'linux');

      await expect(
        syncLocalToRepo(plan, null, { overridesPath: locations.overridesPath })
      ).rejects.toThrow(
        'MCP credential field "mcp.github.headers.Authorization" must be a string before it can ' +
          'be synchronized.'
      );
      expect(await fs.readFile(repoConfigPath, 'utf8')).toBe(originalRepoContent);
      await expect(fs.stat(locations.overridesPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});
