import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeOpenChamber, normalizeSyncConfig } from './config.js';
import {
  isSyncableField,
  type OpenChamberPlan,
  pullOpenChamberPreferences,
  pushOpenChamberPreferences,
} from './openchamber.js';
import { resolveOpenChamberPlan, resolveSyncLocations } from './paths.js';

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'opencode-sync-openchamber-'));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function entry(value: unknown, updatedAt: number, extra: Record<string, unknown> = {}) {
  return { value, updatedAt, ...extra };
}

async function writeJson(filePath: string, data: unknown, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode });
}

interface StoredEntry {
  value?: unknown;
  updatedAt?: number;
  surfaces?: unknown;
}

async function readJson(
  filePath: string
): Promise<{ version?: number; fields: Record<string, StoredEntry> }> {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function planFor(root: string, overrides: Partial<OpenChamberPlan> = {}): OpenChamberPlan {
  return {
    localPath: path.join(root, 'local', 'preferences.json'),
    repoPath: path.join(root, 'repo', 'config', 'openchamber', 'preferences.json'),
    include: [],
    exclude: [],
    ...overrides,
  };
}

describe('isSyncableField', () => {
  it('allows the default list and nothing else', () => {
    expect(isSyncableField('darkThemeId', [], [])).toBe(true);
    expect(isSyncableField('lastSelectedModel', [], [])).toBe(false);
    expect(isSyncableField('recentModels', [], [])).toBe(false);
  });

  it('supports include lists with prefix wildcards and exclude lists', () => {
    expect(isSyncableField('notifyOnError', ['notifyOn*'], [])).toBe(true);
    expect(isSyncableField('darkThemeId', ['notifyOn*'], [])).toBe(false);
    expect(isSyncableField('notifyOnError', ['notifyOn*'], ['notifyOnError'])).toBe(false);
    expect(isSyncableField('favoriteModels', [], ['favorite*'])).toBe(false);
  });

  it('refuses credential-like names even when explicitly included', () => {
    for (const name of ['githubToken', 'apiKey', 'vapidKeys', 'sessionSecret', 'relayIdentity']) {
      expect(isSyncableField(name, [name, '*'], [])).toBe(false);
    }
  });
});

describe('normalizeOpenChamber', () => {
  it('is disabled by default and cleans invalid values', () => {
    expect(normalizeSyncConfig({}).openChamber).toEqual({
      enabled: false,
      path: undefined,
      include: [],
      exclude: [],
    });
    expect(
      normalizeOpenChamber({
        enabled: true,
        path: ' ~/x.json ',
        include: ['a', 1, ''],
        exclude: 'b',
      })
    ).toEqual({ enabled: true, path: '~/x.json', include: ['a'], exclude: [] });
    expect(normalizeOpenChamber({ enabled: 'yes' }).enabled).toBe(false);
  });
});

describe('pushOpenChamberPreferences', () => {
  it('copies only allowlisted fields, drops surfaces, and sorts the output', async () => {
    await withTempDir(async (root) => {
      const plan = planFor(root);
      await writeJson(plan.localPath, {
        version: 1,
        fields: {
          lastSelectedModel: entry('provider/model', 5),
          darkThemeId: entry('dark', 10, {
            surfaces: { desktop: { value: 'imported-local-theme', updatedAt: 9 } },
          }),
          apiToken: entry('secret', 10),
          favoriteModels: entry([{ providerID: 'p', modelID: 'm' }], 7),
        },
      });

      expect(await pushOpenChamberPreferences(plan)).toBe('changed');

      const repo = await readJson(plan.repoPath);
      expect(Object.keys(repo.fields)).toEqual(['darkThemeId', 'favoriteModels']);
      expect(repo.fields.darkThemeId).toEqual({ value: 'dark', updatedAt: 10 });
      expect(JSON.stringify(repo)).not.toContain('secret');
      expect(JSON.stringify(repo)).not.toContain('imported-local-theme');
    });
  });

  it('keeps the newer value per field and leaves the file alone when nothing is newer', async () => {
    await withTempDir(async (root) => {
      const plan = planFor(root);
      await writeJson(plan.repoPath, {
        version: 1,
        fields: { darkThemeId: entry('repo-newer', 20), lightThemeId: entry('repo-older', 1) },
      });
      await writeJson(plan.localPath, {
        version: 1,
        fields: { darkThemeId: entry('local-older', 10), lightThemeId: entry('local-newer', 5) },
      });

      expect(await pushOpenChamberPreferences(plan)).toBe('changed');
      const repo = await readJson(plan.repoPath);
      expect(repo.fields.darkThemeId.value).toBe('repo-newer');
      expect(repo.fields.lightThemeId.value).toBe('local-newer');

      const before = await fs.stat(plan.repoPath);
      expect(await pushOpenChamberPreferences(plan)).toBe('unchanged');
      expect((await fs.stat(plan.repoPath)).mtimeMs).toBe(before.mtimeMs);
    });
  });

  it('skips a missing, malformed or version-mismatched file without throwing', async () => {
    await withTempDir(async (root) => {
      const plan = planFor(root);
      expect(await pushOpenChamberPreferences(plan)).toBe('missing-local');

      await fs.mkdir(path.dirname(plan.localPath), { recursive: true });
      await fs.writeFile(plan.localPath, '{not json', 'utf8');
      expect(await pushOpenChamberPreferences(plan)).toBe('invalid');

      await writeJson(plan.localPath, { version: 2, fields: { darkThemeId: entry('x', 1) } });
      await writeJson(plan.repoPath, { version: 1, fields: {} });
      expect(await pushOpenChamberPreferences(plan)).toBe('version-mismatch');
    });
  });
});

describe('pullOpenChamberPreferences', () => {
  it('applies newer repo fields, keeps newer local fields and unrelated local fields', async () => {
    await withTempDir(async (root) => {
      const plan = planFor(root);
      await writeJson(plan.repoPath, {
        version: 1,
        fields: {
          darkThemeId: entry('repo-theme', 20),
          favoriteModels: entry(['repo'], 3),
          apiToken: entry('leak', 99),
        },
      });
      await writeJson(plan.localPath, {
        version: 1,
        fields: {
          darkThemeId: entry('local-theme', 10, {
            surfaces: { desktop: { value: 'local-surface', updatedAt: 9 } },
          }),
          favoriteModels: entry(['local'], 8),
          lastSelectedModel: entry('local/model', 4),
        },
      });

      expect(await pullOpenChamberPreferences(plan)).toBe('changed');

      const local = await readJson(plan.localPath);
      expect(local.fields.darkThemeId.value).toBe('repo-theme');
      expect(local.fields.darkThemeId.surfaces).toEqual({
        desktop: { value: 'local-surface', updatedAt: 9 },
      });
      expect(local.fields.favoriteModels.value).toEqual(['local']);
      expect(local.fields.lastSelectedModel.value).toBe('local/model');
      expect(local.fields.apiToken).toBeUndefined();
    });
  });

  it('backs the file up once, keeps its mode, and never creates a missing local file', async () => {
    await withTempDir(async (root) => {
      const plan = planFor(root);
      await writeJson(plan.repoPath, { version: 1, fields: { darkThemeId: entry('a', 20) } });
      expect(await pullOpenChamberPreferences(plan)).toBe('missing-local');
      await expect(fs.access(plan.localPath)).rejects.toThrow();

      await writeJson(
        plan.localPath,
        { version: 1, fields: { darkThemeId: entry('orig', 1) } },
        0o600
      );
      expect(await pullOpenChamberPreferences(plan)).toBe('changed');
      const backupPath = `${plan.localPath}.pre-opencode-synced`;
      expect((await readJson(backupPath)).fields.darkThemeId.value).toBe('orig');
      expect((await fs.stat(plan.localPath)).mode & 0o777).toBe(0o600);

      await writeJson(plan.repoPath, { version: 1, fields: { darkThemeId: entry('b', 30) } });
      expect(await pullOpenChamberPreferences(plan)).toBe('changed');
      expect((await readJson(backupPath)).fields.darkThemeId.value).toBe('orig');
      expect(await pullOpenChamberPreferences(plan)).toBe('unchanged');
    });
  });

  it('does not touch a malformed local file', async () => {
    await withTempDir(async (root) => {
      const plan = planFor(root);
      await writeJson(plan.repoPath, { version: 1, fields: { darkThemeId: entry('a', 20) } });
      await fs.mkdir(path.dirname(plan.localPath), { recursive: true });
      await fs.writeFile(plan.localPath, '{broken', 'utf8');

      expect(await pullOpenChamberPreferences(plan)).toBe('invalid');
      expect(await fs.readFile(plan.localPath, 'utf8')).toBe('{broken');
    });
  });
});

describe('resolveOpenChamberPlan', () => {
  it('returns null when disabled and resolves default and custom paths when enabled', () => {
    const locations = resolveSyncLocations();
    const repoRoot = path.join(tmpdir(), 'repo');
    expect(resolveOpenChamberPlan(normalizeSyncConfig({}), locations, repoRoot)).toBeNull();

    const enabled = resolveOpenChamberPlan(
      normalizeSyncConfig({ openChamber: { enabled: true } }),
      locations,
      repoRoot
    );
    expect(enabled?.localPath).toBe(
      path.join(locations.xdg.configDir, 'openchamber', 'preferences.json')
    );
    expect(enabled?.repoPath).toBe(
      path.join(repoRoot, 'config', 'openchamber', 'preferences.json')
    );

    const custom = resolveOpenChamberPlan(
      normalizeSyncConfig({ openChamber: { enabled: true, path: '~/oc/prefs.json' } }),
      locations,
      repoRoot
    );
    expect(custom?.localPath).toBe(path.join(locations.xdg.homeDir, 'oc', 'prefs.json'));
  });
});
