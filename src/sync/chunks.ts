import crypto from 'node:crypto';
import { promises as fs, constants as fsConstants, type Stats } from 'node:fs';
import path from 'node:path';

import { pathExists } from './config.js';

const POINTER_FORMAT = 'opencode-synced-chunks';
const POINTER_VERSION = 1;
const STORE_OWNER_FORMAT = 'opencode-synced-chunk-store';
const STORE_OWNER_FILE = 'OWNER.json';
const STORE_OWNER_CONTENT = `${JSON.stringify({
  format: STORE_OWNER_FORMAT,
  version: POINTER_VERSION,
})}\n`;
const STORE_ROOT_RELATIVE_PATH = path.join('.opencode-synced', 'chunks');
const STORE_RELATIVE_PATH = path.join('.opencode-synced', 'chunks', 'v1');
const POINTER_LIMIT = 16 * 1024;
const MAX_POINTER_SCAN_ENTRIES = 100_000;
const MAX_POINTER_SCAN_DEPTH = 64;
const STALE_TEMP_AGE_MS = 60 * 60 * 1000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CHUNK_NAME_PATTERN = /^\d{6}\.part$/u;

export interface ChunkOptions {
  thresholdBytes?: number;
  chunkBytes?: number;
  maxFileBytes?: number;
  maxChunks?: number;
  bufferBytes?: number;
}

interface ResolvedChunkOptions {
  thresholdBytes: number;
  chunkBytes: number;
  maxFileBytes: number;
  maxChunks: number;
  bufferBytes: number;
}

interface ChunkPointer {
  format: typeof POINTER_FORMAT;
  version: typeof POINTER_VERSION;
  id: string;
  sha256: string;
  size: number;
  mode: number;
  chunkSize: number;
  chunkCount: number;
}

const DEFAULT_OPTIONS: ResolvedChunkOptions = {
  thresholdBytes: 50 * 1024 * 1024,
  chunkBytes: 40 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024 * 1024,
  maxChunks: 128,
  bufferBytes: 1024 * 1024,
};

export async function copySessionFileToRepo(
  sourcePath: string,
  repoPath: string,
  repoRoot: string,
  options: ChunkOptions = {},
  logicalRepoPath = repoPath
): Promise<void> {
  const resolved = resolveOptions(options);
  const sourceStat = await assertRegularFile(sourcePath, 'session source');
  if (sourceStat.size > resolved.maxFileBytes) {
    throw new Error(
      `Session file exceeds the ${resolved.maxFileBytes}-byte safety limit: ${sourcePath}`
    );
  }

  if (sourceStat.size <= resolved.thresholdBytes) {
    await copyRegularFileAtomic(sourcePath, repoPath, sourceStat.mode & 0o777, sourceStat);
    return;
  }

  const chunkCount = Math.ceil(sourceStat.size / resolved.chunkBytes);
  if (chunkCount > resolved.maxChunks) {
    throw new Error(`Session file requires ${chunkCount} chunks, exceeding the safety limit.`);
  }

  const relativePath = assertRepoRelativePath(repoRoot, logicalRepoPath);
  await ensureOwnedChunkStore(repoRoot);
  const tempStore = path.join(
    repoRoot,
    STORE_RELATIVE_PATH,
    `.tmp-${process.pid}-${crypto.randomUUID()}`
  );
  await fs.mkdir(tempStore, { recursive: true, mode: 0o700 });

  let finalStore = '';
  try {
    const digest = await splitFile(sourcePath, tempStore, sourceStat, resolved);
    const id = createChunkId(relativePath, digest);
    finalStore = chunkStorePath(repoRoot, id);

    await fs.mkdir(path.dirname(finalStore), { recursive: true, mode: 0o700 });
    if (await pathExists(finalStore)) {
      await validateChunkDirectory(finalStore, {
        format: POINTER_FORMAT,
        version: POINTER_VERSION,
        id,
        sha256: digest,
        size: sourceStat.size,
        mode: sourceStat.mode & 0o777,
        chunkSize: resolved.chunkBytes,
        chunkCount,
      });
      await validateChunkContent(finalStore, digest, sourceStat.size, resolved.bufferBytes);
      await fs.rm(tempStore, { recursive: true, force: true });
    } else {
      await fs.rename(tempStore, finalStore);
    }

    const pointer: ChunkPointer = {
      format: POINTER_FORMAT,
      version: POINTER_VERSION,
      id,
      sha256: digest,
      size: sourceStat.size,
      mode: sourceStat.mode & 0o777,
      chunkSize: resolved.chunkBytes,
      chunkCount,
    };
    await writeFileAtomic(repoPath, `${JSON.stringify(pointer)}\n`, sourceStat.mode & 0o777);
  } catch (error) {
    await fs.rm(tempStore, { recursive: true, force: true });
    throw error;
  }
}

export async function copySessionFileFromRepo(
  repoPath: string,
  destinationPath: string,
  repoRoot: string,
  options: ChunkOptions = {}
): Promise<void> {
  const resolved = resolveOptions(options);
  const sourceStat = await assertRegularFile(repoPath, 'repository session file');
  const pointer = await readPointer(repoPath, sourceStat.size);
  if (!pointer) {
    if (sourceStat.size > resolved.maxFileBytes) {
      throw new Error(`Repository session file exceeds the safety limit: ${repoPath}`);
    }
    await copyRegularFileAtomic(repoPath, destinationPath, sourceStat.mode & 0o777, sourceStat);
    return;
  }

  const relativePath = assertRepoRelativePath(repoRoot, repoPath);
  const expectedId = createChunkId(relativePath, pointer.sha256);
  if (pointer.id !== expectedId) {
    throw new Error('Chunk pointer identifier does not match its repository path.');
  }

  const storePath = chunkStorePath(repoRoot, pointer.id);
  await assertSafeStorePath(repoRoot, storePath);
  await validateChunkDirectory(storePath, pointer);
  await reconstructFileAtomic(storePath, destinationPath, pointer, resolved.bufferBytes);
}

export async function cleanupUnreferencedChunkStores(repoRoot: string): Promise<void> {
  await assertSafeStorePath(repoRoot, path.join(repoRoot, STORE_RELATIVE_PATH));
  if (!(await hasOwnedChunkStore(repoRoot))) return;
  const storeRoot = path.join(repoRoot, STORE_RELATIVE_PATH);
  if (!(await pathExists(storeRoot))) return;

  const referenced = new Set<string>();
  const scanState = { entries: 0 };
  for (const candidate of [
    path.join(repoRoot, 'data', 'opencode.db'),
    path.join(repoRoot, 'data', 'opencode.db-wal'),
    path.join(repoRoot, 'data', 'opencode.db-shm'),
    path.join(repoRoot, 'data', 'storage', 'message'),
  ]) {
    await collectKnownPointerIds(candidate, referenced, scanState, 0);
  }
  const entries = await fs.readdir(storeRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && /^\.tmp-\d+-[a-f0-9-]+$/u.test(entry.name)) {
      const tempPath = path.join(storeRoot, entry.name);
      const tempStat = await fs.lstat(tempPath);
      if (Date.now() - tempStat.mtimeMs >= STALE_TEMP_AGE_MS) {
        await removeOwnedStoreDirectory(repoRoot, tempPath);
      }
      continue;
    }
    if (!entry.isDirectory() || !SHA256_PATTERN.test(entry.name)) continue;
    if (referenced.has(entry.name)) continue;
    await removeOwnedStoreDirectory(repoRoot, path.join(storeRoot, entry.name));
  }
}

export function isChunkStorePath(repoRoot: string, candidatePath: string): boolean {
  const storeRoot = path.resolve(repoRoot, STORE_RELATIVE_PATH);
  const resolved = path.resolve(candidatePath);
  return resolved === storeRoot || resolved.startsWith(`${storeRoot}${path.sep}`);
}

function resolveOptions(options: ChunkOptions): ResolvedChunkOptions {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Invalid chunk option ${name}.`);
    }
  }
  if (resolved.chunkBytes >= 100 * 1024 * 1024) {
    throw new Error("Chunk size must remain below GitHub's 100 MiB file limit.");
  }
  if (resolved.chunkBytes > resolved.maxFileBytes) {
    throw new Error('Chunk size cannot exceed the maximum file size.');
  }
  return resolved;
}

async function splitFile(
  sourcePath: string,
  destinationDir: string,
  expectedStat: Stats,
  options: ResolvedChunkOptions
): Promise<string> {
  const expectedSize = expectedStat.size;
  const source = await fs.open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(options.bufferBytes, options.chunkBytes));
  let offset = 0;
  let chunkIndex = 0;
  let chunkHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
  let bytesInChunk = 0;

  try {
    while (offset < expectedSize) {
      if (!chunkHandle || bytesInChunk === options.chunkBytes) {
        await chunkHandle?.close();
        chunkHandle = await fs.open(
          path.join(destinationDir, chunkName(chunkIndex)),
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
          0o600
        );
        chunkIndex += 1;
        bytesInChunk = 0;
      }

      const remainingFile = expectedSize - offset;
      const remainingChunk = options.chunkBytes - bytesInChunk;
      const length = Math.min(buffer.length, remainingFile, remainingChunk);
      const { bytesRead } = await source.read(buffer, 0, length, offset);
      if (bytesRead === 0) {
        throw new Error(`Session source shrank while it was being chunked: ${sourcePath}`);
      }
      const slice = buffer.subarray(0, bytesRead);
      await writeAll(chunkHandle, slice);
      hash.update(slice);
      offset += bytesRead;
      bytesInChunk += bytesRead;
    }
    await chunkHandle?.close();
    chunkHandle = null;

    const finalStat = await source.stat();
    if (
      finalStat.size !== expectedSize ||
      finalStat.mtimeMs !== expectedStat.mtimeMs ||
      finalStat.ctimeMs !== expectedStat.ctimeMs ||
      finalStat.dev !== expectedStat.dev ||
      finalStat.ino !== expectedStat.ino
    ) {
      throw new Error(`Session source changed while it was being chunked: ${sourcePath}`);
    }
    const expectedChunks = Math.ceil(expectedSize / options.chunkBytes);
    if (chunkIndex !== expectedChunks) {
      throw new Error('Chunk writer produced an unexpected number of chunks.');
    }
    return hash.digest('hex');
  } finally {
    await chunkHandle?.close();
    await source.close();
  }
}

async function reconstructFileAtomic(
  storePath: string,
  destinationPath: string,
  pointer: ChunkPointer,
  bufferBytes: number
): Promise<void> {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  const tempPath = `${destinationPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const destination = await fs.open(
    tempPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600
  );
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(bufferBytes);
  let total = 0;

  try {
    for (let index = 0; index < pointer.chunkCount; index += 1) {
      const chunkPath = path.join(storePath, chunkName(index));
      const chunk = await fs.open(chunkPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        let position = 0;
        while (true) {
          const { bytesRead } = await chunk.read(buffer, 0, buffer.length, position);
          if (bytesRead === 0) break;
          const slice = buffer.subarray(0, bytesRead);
          await writeAll(destination, slice);
          hash.update(slice);
          position += bytesRead;
          total += bytesRead;
          if (total > pointer.size) throw new Error('Chunk data exceeds the declared size.');
        }
      } finally {
        await chunk.close();
      }
    }
    await destination.sync();
    await destination.close();

    if (total !== pointer.size || hash.digest('hex') !== pointer.sha256) {
      throw new Error('Chunk data failed size or SHA-256 validation.');
    }
    await fs.chmod(tempPath, pointer.mode);
    await replaceFile(tempPath, destinationPath);
  } catch (error) {
    await destination.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

async function validateChunkDirectory(storePath: string, pointer: ChunkPointer): Promise<void> {
  const stat = await fs.lstat(storePath).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Chunk store is missing or is not a regular directory: ${pointer.id}`);
  }
  const entries = await fs.readdir(storePath, { withFileTypes: true });
  const expectedNames = Array.from({ length: pointer.chunkCount }, (_, index) => chunkName(index));
  const actualNames = entries.map((entry) => entry.name).sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(`Chunk store has missing, extra, or invalid entries: ${pointer.id}`);
  }

  for (let index = 0; index < entries.length; index += 1) {
    const name = expectedNames[index] as string;
    if (!CHUNK_NAME_PATTERN.test(name)) throw new Error(`Invalid chunk name: ${name}`);
    const chunkStat = await fs.lstat(path.join(storePath, name));
    if (!chunkStat.isFile() || chunkStat.isSymbolicLink()) {
      throw new Error(`Chunk is not a regular file: ${name}`);
    }
    const expectedSize =
      index === pointer.chunkCount - 1
        ? pointer.size - pointer.chunkSize * (pointer.chunkCount - 1)
        : pointer.chunkSize;
    if (chunkStat.size !== expectedSize) {
      throw new Error(`Chunk has the wrong size: ${name}`);
    }
  }
}

async function validateChunkContent(
  storePath: string,
  expectedSha256: string,
  expectedSize: number,
  bufferBytes: number
): Promise<void> {
  const hash = crypto.createHash('sha256');
  const entries = (await fs.readdir(storePath)).sort();
  const buffer = Buffer.allocUnsafe(bufferBytes);
  let total = 0;
  for (const name of entries) {
    const chunk = await fs.open(
      path.join(storePath, name),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    );
    try {
      let position = 0;
      while (true) {
        const { bytesRead } = await chunk.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
        total += bytesRead;
        if (total > expectedSize) throw new Error('Existing chunk store exceeds expected size.');
      }
    } finally {
      await chunk.close();
    }
  }
  if (total !== expectedSize || hash.digest('hex') !== expectedSha256) {
    throw new Error('Existing chunk store failed SHA-256 validation.');
  }
}

async function readPointer(filePath: string, fileSize: number): Promise<ChunkPointer | null> {
  if (fileSize > POINTER_LIMIT) {
    const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const prefix = Buffer.alloc(POINTER_LIMIT);
      const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
      if (prefix.subarray(0, bytesRead).toString('utf8').includes(POINTER_FORMAT)) {
        throw new Error('Chunk pointer exceeds the metadata size limit.');
      }
    } finally {
      await handle.close();
    }
    return null;
  }
  const content = await fs.readFile(filePath, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    if (content.includes(POINTER_FORMAT)) throw new Error('Chunk pointer is not valid JSON.');
    return null;
  }
  if (!isRecord(value) || value.format !== POINTER_FORMAT) return null;

  const exactKeys = [
    'chunkCount',
    'chunkSize',
    'format',
    'id',
    'mode',
    'sha256',
    'size',
    'version',
  ];
  const keys = Object.keys(value).sort();
  if (keys.length !== exactKeys.length || keys.some((key, index) => key !== exactKeys[index])) {
    throw new Error('Chunk pointer has unknown or missing fields.');
  }
  const pointer = value as unknown as ChunkPointer;
  if (
    pointer.version !== POINTER_VERSION ||
    !SHA256_PATTERN.test(pointer.id) ||
    !SHA256_PATTERN.test(pointer.sha256) ||
    !Number.isSafeInteger(pointer.size) ||
    pointer.size <= 0 ||
    pointer.size > DEFAULT_OPTIONS.maxFileBytes ||
    !Number.isSafeInteger(pointer.mode) ||
    pointer.mode < 0 ||
    pointer.mode > 0o777 ||
    !Number.isSafeInteger(pointer.chunkSize) ||
    pointer.chunkSize <= 0 ||
    pointer.chunkSize >= 100 * 1024 * 1024 ||
    !Number.isSafeInteger(pointer.chunkCount) ||
    pointer.chunkCount <= 0 ||
    pointer.chunkCount > DEFAULT_OPTIONS.maxChunks ||
    pointer.chunkCount !== Math.ceil(pointer.size / pointer.chunkSize)
  ) {
    throw new Error('Chunk pointer metadata is invalid or exceeds safety limits.');
  }
  return pointer;
}

async function collectKnownPointerIds(
  currentPath: string,
  ids: Set<string>,
  state: { entries: number },
  depth: number
): Promise<void> {
  if (depth > MAX_POINTER_SCAN_DEPTH) {
    throw new Error('Refusing chunk cleanup because session storage is nested too deeply.');
  }
  const currentStat = await fs.lstat(currentPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!currentStat) return;
  if (currentStat.isSymbolicLink()) {
    throw new Error(
      `Refusing chunk cleanup because session storage contains a symlink: ${currentPath}`
    );
  }
  if (currentStat.isFile()) {
    await collectPointerId(currentPath, currentStat.size, ids);
    return;
  }
  if (!currentStat.isDirectory()) return;

  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    state.entries += 1;
    if (state.entries > MAX_POINTER_SCAN_ENTRIES) {
      throw new Error('Refusing chunk cleanup because session storage exceeds the scan limit.');
    }
    const entryPath = path.join(currentPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Refusing chunk cleanup because session storage contains a symlink: ${entryPath}`
      );
    }
    await collectKnownPointerIds(entryPath, ids, state, depth + 1);
  }
}

async function collectPointerId(filePath: string, size: number, ids: Set<string>): Promise<void> {
  if (size > POINTER_LIMIT) {
    const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const prefix = Buffer.alloc(512);
      const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
      if (prefix.subarray(0, bytesRead).toString('utf8').includes(POINTER_FORMAT)) {
        throw new Error(`Refusing chunk cleanup because a pointer is oversized: ${filePath}`);
      }
    } finally {
      await handle.close();
    }
    return;
  }
  const content = await fs.readFile(filePath, 'utf8').catch(() => '');
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    if (content.includes(POINTER_FORMAT)) {
      throw new Error(`Refusing chunk cleanup because a pointer is corrupt: ${filePath}`);
    }
    return;
  }
  if (!isRecord(value) || value.format !== POINTER_FORMAT) return;
  const pointer = await readPointer(filePath, size);
  if (!pointer) throw new Error(`Refusing chunk cleanup because a pointer is corrupt: ${filePath}`);
  ids.add(pointer.id);
}

async function removeOwnedStoreDirectory(repoRoot: string, directoryPath: string): Promise<void> {
  await assertSafeStorePath(repoRoot, directoryPath);
  const stat = await fs.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to remove an invalid chunk store entry: ${directoryPath}`);
  }
  await fs.rm(directoryPath, { recursive: true, force: true });
}

async function ensureOwnedChunkStore(repoRoot: string): Promise<void> {
  const storeRoot = path.join(repoRoot, STORE_ROOT_RELATIVE_PATH);
  await assertSafeStorePath(repoRoot, storeRoot);
  const ownerPath = path.join(storeRoot, STORE_OWNER_FILE);
  if (await pathExists(storeRoot)) {
    const stat = await fs.lstat(storeRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Reserved chunk store path is not a regular directory.');
    }
    if (await pathExists(ownerPath)) {
      if (!(await hasOwnedChunkStore(repoRoot))) {
        throw new Error('Reserved chunk store has an invalid ownership marker.');
      }
      return;
    }
    const entries = await fs.readdir(storeRoot);
    if (entries.length > 0) {
      throw new Error('Reserved chunk store path already contains unowned data.');
    }
  }
  await fs.mkdir(storeRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(ownerPath, STORE_OWNER_CONTENT, { flag: 'wx', mode: 0o600 });
}

async function hasOwnedChunkStore(repoRoot: string): Promise<boolean> {
  const ownerPath = path.join(repoRoot, STORE_ROOT_RELATIVE_PATH, STORE_OWNER_FILE);
  const stat = await fs.lstat(ownerPath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > POINTER_LIMIT) return false;
  const content = await fs.readFile(ownerPath, 'utf8').catch(() => '');
  return content === STORE_OWNER_CONTENT;
}

async function assertSafeStorePath(repoRoot: string, targetPath: string): Promise<void> {
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Chunk store path escapes the repository.');
  }

  const realRoot = await fs.realpath(resolvedRoot);
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new Error(`Chunk store path contains a symlink: ${current}`);
    }
    const realCurrent = await fs.realpath(current);
    const realRelative = path.relative(realRoot, realCurrent);
    if (
      realRelative === '..' ||
      realRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelative)
    ) {
      throw new Error('Chunk store path resolves outside the repository.');
    }
  }
}

async function assertRegularFile(filePath: string, label: string): Promise<Stats> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file: ${filePath}`);
  }
  return stat;
}

function assertRepoRelativePath(repoRoot: string, repoPath: string): string {
  const relative = path.relative(path.resolve(repoRoot), path.resolve(repoPath));
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Session path is outside the repository: ${repoPath}`);
  }
  if (isChunkStorePath(repoRoot, repoPath)) {
    throw new Error('Session path overlaps the reserved chunk store.');
  }
  return relative.split(path.sep).join('/');
}

function chunkStorePath(repoRoot: string, id: string): string {
  if (!SHA256_PATTERN.test(id)) throw new Error('Invalid chunk store identifier.');
  return path.join(repoRoot, STORE_RELATIVE_PATH, id);
}

function chunkName(index: number): string {
  return `${String(index).padStart(6, '0')}.part`;
}

export function createChunkId(relativePath: string, sha256: string): string {
  if (!SHA256_PATTERN.test(sha256)) throw new Error('Invalid chunk SHA-256.');
  const portablePath = relativePath.replace(/\\/gu, '/').replace(/^\.\//u, '');
  return crypto.createHash('sha256').update(portablePath).update('\0').update(sha256).digest('hex');
}

async function copyRegularFileAtomic(
  sourcePath: string,
  destinationPath: string,
  mode: number,
  expectedStat: Stats
): Promise<void> {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  const tempPath = `${destinationPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const source = await fs.open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let destination: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    const openedStat = await source.stat();
    if (!sameFileSnapshot(openedStat, expectedStat)) {
      throw new Error(`Session source changed before it could be copied: ${sourcePath}`);
    }
    destination = await fs.open(
      tempPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600
    );
    const buffer = Buffer.allocUnsafe(DEFAULT_OPTIONS.bufferBytes);
    let offset = 0;
    while (offset < expectedStat.size) {
      const length = Math.min(buffer.length, expectedStat.size - offset);
      const { bytesRead } = await source.read(buffer, 0, length, offset);
      if (bytesRead === 0) throw new Error(`Session source shrank while copying: ${sourcePath}`);
      await writeAll(destination, buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const finalStat = await source.stat();
    if (!sameFileSnapshot(finalStat, expectedStat)) {
      throw new Error(`Session source changed while copying: ${sourcePath}`);
    }
    await destination.sync();
    await destination.close();
    destination = null;
    await fs.chmod(tempPath, mode);
    await replaceFile(tempPath, destinationPath);
  } catch (error) {
    await destination?.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true });
    throw error;
  } finally {
    await source.close();
  }
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

async function writeFileAtomic(filePath: string, content: string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.chmod(tempPath, mode);
    await replaceFile(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof fs.open>>,
  buffer: Uint8Array
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (bytesWritten === 0) throw new Error('Unable to make progress while writing chunk data.');
    offset += bytesWritten;
  }
}

async function replaceFile(sourcePath: string, destinationPath: string): Promise<void> {
  const backupPath = `${destinationPath}.backup-${process.pid}-${crypto.randomUUID()}`;
  const destinationExists = await pathExists(destinationPath);
  if (destinationExists) await fs.rename(destinationPath, backupPath);
  try {
    await fs.rename(sourcePath, destinationPath);
    if (destinationExists) await fs.rm(backupPath, { force: true });
  } catch (error) {
    if (destinationExists && !(await pathExists(destinationPath))) {
      await fs.rename(backupPath, destinationPath);
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
