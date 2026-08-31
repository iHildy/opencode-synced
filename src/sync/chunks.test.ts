import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupUnreferencedChunkStores,
  copySessionFileFromRepo,
  copySessionFileToRepo,
  createChunkId,
} from './chunks.js';

const roots: string[] = [];
const options = {
  thresholdBytes: 8,
  chunkBytes: 5,
  maxFileBytes: 128,
  maxChunks: 32,
  bufferBytes: 3,
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('session chunk storage', () => {
  it('round-trips a large file with strict metadata and its original mode', async () => {
    const fixture = await createFixture();
    const content = Buffer.from('large-session-payload');
    await fs.writeFile(fixture.source, content, { mode: 0o600 });
    await fs.chmod(fixture.source, 0o600);

    await copySessionFileToRepo(fixture.source, fixture.repoFile, fixture.repo, options);

    const pointer = JSON.parse(await fs.readFile(fixture.repoFile, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(pointer).toMatchObject({
      format: 'opencode-synced-chunks',
      version: 1,
      size: content.length,
      mode: 0o600,
      chunkSize: 5,
      chunkCount: Math.ceil(content.length / 5),
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
    });

    await fs.chmod(fixture.repoFile, 0o644);
    await copySessionFileFromRepo(fixture.repoFile, fixture.destination, fixture.repo, options);
    expect(await fs.readFile(fixture.destination)).toEqual(content);
    expect((await fs.stat(fixture.destination)).mode & 0o777).toBe(0o600);
  });

  it('leaves an existing destination intact when a chunk is missing', async () => {
    const fixture = await createChunkedFixture();
    await fs.mkdir(path.dirname(fixture.destination), { recursive: true });
    await fs.writeFile(fixture.destination, 'keep-me');
    const store = await getStorePath(fixture.repoFile, fixture.repo);
    await fs.rm(path.join(store, '000001.part'));

    await expect(
      copySessionFileFromRepo(fixture.repoFile, fixture.destination, fixture.repo, options)
    ).rejects.toThrow(/missing, extra, or invalid/u);
    expect(await fs.readFile(fixture.destination, 'utf8')).toBe('keep-me');
  });

  it('rejects extra and non-numeric chunk entries', async () => {
    const fixture = await createChunkedFixture();
    const store = await getStorePath(fixture.repoFile, fixture.repo);
    await fs.writeFile(path.join(store, 'notes.txt'), 'unexpected');

    await expect(
      copySessionFileFromRepo(fixture.repoFile, fixture.destination, fixture.repo, options)
    ).rejects.toThrow(/missing, extra, or invalid/u);
  });

  it('rejects same-size corrupt chunks without replacing the destination', async () => {
    const fixture = await createChunkedFixture();
    await fs.mkdir(path.dirname(fixture.destination), { recursive: true });
    await fs.writeFile(fixture.destination, 'original');
    const store = await getStorePath(fixture.repoFile, fixture.repo);
    await fs.writeFile(path.join(store, '000000.part'), 'xxxxx');

    await expect(
      copySessionFileFromRepo(fixture.repoFile, fixture.destination, fixture.repo, options)
    ).rejects.toThrow(/SHA-256/u);
    expect(await fs.readFile(fixture.destination, 'utf8')).toBe('original');
  });

  it('does not reuse a same-size corrupt content-addressed store', async () => {
    const fixture = await createChunkedFixture();
    const store = await getStorePath(fixture.repoFile, fixture.repo);
    await fs.writeFile(path.join(store, '000000.part'), 'xxxxx');

    await expect(
      copySessionFileToRepo(fixture.source, fixture.repoFile, fixture.repo, options)
    ).rejects.toThrow(/SHA-256/u);
  });

  it('rejects a pointer copied to another repository path', async () => {
    const fixture = await createChunkedFixture();
    const copiedPointer = path.join(fixture.repo, 'data', 'storage', 'message', 'other.json');
    await fs.copyFile(fixture.repoFile, copiedPointer);

    await expect(
      copySessionFileFromRepo(copiedPointer, fixture.destination, fixture.repo, options)
    ).rejects.toThrow(/does not match its repository path/u);
  });

  it('rejects malformed and oversized pointer markers instead of treating them as legacy files', async () => {
    const fixture = await createFixture();
    await fs.writeFile(fixture.repoFile, '{"format":"opencode-synced-chunks"');
    await expect(
      copySessionFileFromRepo(fixture.repoFile, fixture.destination, fixture.repo, options)
    ).rejects.toThrow(/valid JSON/u);

    await fs.writeFile(
      fixture.repoFile,
      `{"format":"opencode-synced-chunks"}${' '.repeat(17 * 1024)}`
    );
    await expect(
      copySessionFileFromRepo(fixture.repoFile, fixture.destination, fixture.repo, options)
    ).rejects.toThrow(/size limit/u);
  });

  it('keeps ordinary small session files byte-for-byte without a pointer', async () => {
    const fixture = await createFixture();
    await fs.writeFile(fixture.source, 'small', { mode: 0o640 });
    await fs.chmod(fixture.source, 0o640);

    await copySessionFileToRepo(fixture.source, fixture.repoFile, fixture.repo, options);
    expect(await fs.readFile(fixture.repoFile, 'utf8')).toBe('small');

    await copySessionFileFromRepo(fixture.repoFile, fixture.destination, fixture.repo, options);
    expect(await fs.readFile(fixture.destination, 'utf8')).toBe('small');
    expect((await fs.stat(fixture.destination)).mode & 0o777).toBe(0o640);
  });

  it('reads a legacy plain file even when it is now above the chunk threshold', async () => {
    const fixture = await createFixture();
    await fs.writeFile(fixture.repoFile, 'legacy-plain-session');

    await copySessionFileFromRepo(fixture.repoFile, fixture.destination, fixture.repo, options);
    expect(await fs.readFile(fixture.destination, 'utf8')).toBe('legacy-plain-session');
  });

  it('derives the same chunk ID from POSIX and Windows separators', () => {
    const sha256 = 'e'.repeat(64);
    expect(createChunkId('data/storage/message/message.json', sha256)).toBe(
      createChunkId('data\\storage\\message\\message.json', sha256)
    );
  });

  it('removes only unreferenced content-addressed stores', async () => {
    const fixture = await createChunkedFixture();
    const referencedStore = await getStorePath(fixture.repoFile, fixture.repo);
    const orphanId = 'a'.repeat(64);
    const orphanStore = path.join(fixture.repo, '.opencode-synced', 'chunks', 'v1', orphanId);
    const unexpectedStore = path.join(fixture.repo, '.opencode-synced', 'chunks', 'v1', 'manual');
    await fs.mkdir(orphanStore, { recursive: true });
    await fs.mkdir(unexpectedStore, { recursive: true });

    await cleanupUnreferencedChunkStores(fixture.repo);
    expect(await exists(referencedStore)).toBe(true);
    expect(await exists(orphanStore)).toBe(false);
    expect(await exists(unexpectedStore)).toBe(true);
  });

  it('does not clean a colliding namespace without the ownership marker', async () => {
    const fixture = await createFixture();
    const collidingStore = path.join(
      fixture.repo,
      '.opencode-synced',
      'chunks',
      'v1',
      'b'.repeat(64)
    );
    await fs.mkdir(collidingStore, { recursive: true });
    await fs.writeFile(path.join(collidingStore, 'user-data'), 'keep');

    await cleanupUnreferencedChunkStores(fixture.repo);
    expect(await fs.readFile(path.join(collidingStore, 'user-data'), 'utf8')).toBe('keep');
  });

  it('refuses to write into a colliding unowned namespace', async () => {
    const fixture = await createFixture();
    await fs.writeFile(fixture.source, '0123456789abcdef');
    const collision = path.join(fixture.repo, '.opencode-synced', 'chunks', 'user-data');
    await fs.mkdir(path.dirname(collision), { recursive: true });
    await fs.writeFile(collision, 'keep');

    await expect(
      copySessionFileToRepo(fixture.source, fixture.repoFile, fixture.repo, options)
    ).rejects.toThrow(/unowned data/u);
    expect(await fs.readFile(collision, 'utf8')).toBe('keep');
  });

  it('fails cleanup closed when a chunk pointer is corrupt', async () => {
    const fixture = await createChunkedFixture();
    const orphanStore = path.join(fixture.repo, '.opencode-synced', 'chunks', 'v1', 'c'.repeat(64));
    await fs.mkdir(orphanStore, { recursive: true });
    await fs.writeFile(fixture.repoFile, '{"format":"opencode-synced-chunks","version":1}');

    await expect(cleanupUnreferencedChunkStores(fixture.repo)).rejects.toThrow(/pointer/u);
    expect(await exists(orphanStore)).toBe(true);
  });

  it('rejects an ancestor symlink before cleanup can touch external data', async () => {
    const fixture = await createFixture();
    const external = path.join(fixture.root, 'external');
    const externalStore = path.join(external, 'chunks', 'v1', 'd'.repeat(64));
    await fs.mkdir(externalStore, { recursive: true });
    await fs.writeFile(
      path.join(external, 'chunks', 'OWNER.json'),
      '{"format":"opencode-synced-chunk-store","version":1}\n'
    );
    await fs.writeFile(path.join(externalStore, 'user-data'), 'keep');
    await fs.mkdir(fixture.repo, { recursive: true });
    await fs.symlink(external, path.join(fixture.repo, '.opencode-synced'));

    await expect(cleanupUnreferencedChunkStores(fixture.repo)).rejects.toThrow(/symlink/u);
    expect(await fs.readFile(path.join(externalStore, 'user-data'), 'utf8')).toBe('keep');
  });

  it('fails safely when the source shrinks during streaming', async () => {
    const fixture = await createFixture();
    const largeOptions = {
      thresholdBytes: 1,
      chunkBytes: 1024 * 1024,
      maxFileBytes: 32 * 1024 * 1024,
      maxChunks: 32,
      bufferBytes: 4096,
    };
    await fs.writeFile(fixture.source, Buffer.alloc(16 * 1024 * 1024, 7));

    const truncate = new Promise<void>((resolve) => {
      setTimeout(async () => {
        await fs.truncate(fixture.source, 16);
        resolve();
      }, 1);
    });
    await expect(
      copySessionFileToRepo(fixture.source, fixture.repoFile, fixture.repo, largeOptions)
    ).rejects.toThrow(/shrank|changed/u);
    await truncate;
    expect(await exists(fixture.repoFile)).toBe(false);
  });

  it('does not copy a file unchunked when it grows after the routing stat', async () => {
    const fixture = await createFixture();
    await fs.writeFile(fixture.source, 'small');
    const initialStat = await fs.lstat(fixture.source);
    vi.spyOn(fs, 'lstat').mockImplementationOnce(async () => {
      await fs.writeFile(fixture.source, '0123456789abcdef');
      return initialStat;
    });

    await expect(
      copySessionFileToRepo(fixture.source, fixture.repoFile, fixture.repo, options)
    ).rejects.toThrow(/changed/u);
    expect(await exists(fixture.repoFile)).toBe(false);
  });
});

async function createFixture(): Promise<{
  root: string;
  repo: string;
  source: string;
  repoFile: string;
  destination: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-synced-chunks-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  const source = path.join(root, 'local', 'message.json');
  const repoFile = path.join(repo, 'data', 'storage', 'message', 'message.json');
  const destination = path.join(root, 'destination', 'message.json');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.mkdir(path.dirname(repoFile), { recursive: true });
  return { root, repo, source, repoFile, destination };
}

async function createChunkedFixture(): Promise<Awaited<ReturnType<typeof createFixture>>> {
  const fixture = await createFixture();
  await fs.writeFile(fixture.source, '0123456789abcdef');
  await copySessionFileToRepo(fixture.source, fixture.repoFile, fixture.repo, options);
  return fixture;
}

async function getStorePath(repoFile: string, repoRoot: string): Promise<string> {
  const pointer = JSON.parse(await fs.readFile(repoFile, 'utf8')) as { id: string };
  return path.join(repoRoot, '.opencode-synced', 'chunks', 'v1', pointer.id);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
