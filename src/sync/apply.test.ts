import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { syncLocalToRepo, syncRepoToLocal } from './apply.js';
import type { ExtraPathPlan, SyncItem, SyncPlan } from './paths.js';

const EMPTY_EXTRA_PLAN: ExtraPathPlan = {
  allowlist: [],
  manifestPath: '',
  entries: [],
};

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
    configRoot: path.join(homeDir, '.config', 'opencode'),
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
