import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface SessionMeta {
  id: string;
  project_id: string | null;
  parent_id: string | null;
  slug: string | null;
  directory: string | null;
  title: string | null;
  version: number | null;
  share_url: string | null;
  summary_additions: number | null;
  summary_deletions: number | null;
  summary_files: number | null;
  summary_diffs: string | null;
  revert: string | null;
  permission: string | null;
  time_created: string | null;
  time_updated: string | null;
  time_compacting: string | null;
  time_archived: string | null;
  workspace_id: string | null;
  path: string | null;
  agent: string | null;
  model: string | null;
  cost: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
}

export interface Message {
  id: string;
  session_id: string;
  time_created: string | null;
  time_updated: string | null;
  data: string | null;
  parts: Part[];
}

export interface Part {
  id: string;
  message_id: string;
  session_id: string;
  time_created: string | null;
  time_updated: string | null;
  data: string | null;
}

export interface SessionMessage {
  id: string;
  session_id: string;
  type: string | null;
  time_created: string | null;
  time_updated: string | null;
  data: string | null;
}

export interface Todo {
  session_id: string;
  content: string | null;
  status: string | null;
  priority: number | null;
  position: number | null;
  time_created: string | null;
  time_updated: string | null;
}

export interface SessionShare {
  session_id: string;
  id: string;
  secret: string | null;
  url: string | null;
  time_created: string | null;
  time_updated: string | null;
}

export interface Session {
  session: SessionMeta;
  messages: Message[];
  session_messages: SessionMessage[];
  todos: Todo[];
  session_shares: SessionShare[];
}

const SESSION_COLUMNS = [
  'id',
  'project_id',
  'parent_id',
  'slug',
  'directory',
  'title',
  'version',
  'share_url',
  'summary_additions',
  'summary_deletions',
  'summary_files',
  'summary_diffs',
  'revert',
  'permission',
  'time_created',
  'time_updated',
  'time_compacting',
  'time_archived',
  'workspace_id',
  'path',
  'agent',
  'model',
  'cost',
  'tokens_input',
  'tokens_output',
  'tokens_reasoning',
  'tokens_cache_read',
  'tokens_cache_write',
];

const MESSAGE_COLUMNS = ['id', 'session_id', 'time_created', 'time_updated', 'data'];
const PART_COLUMNS = ['id', 'message_id', 'session_id', 'time_created', 'time_updated', 'data'];
const SESSION_MESSAGE_COLUMNS = [
  'id',
  'session_id',
  'type',
  'time_created',
  'time_updated',
  'data',
];
const TODO_COLUMNS = [
  'session_id',
  'content',
  'status',
  'priority',
  'position',
  'time_created',
  'time_updated',
];
const SHARE_COLUMNS = ['session_id', 'id', 'secret', 'url', 'time_created', 'time_updated'];

function openDB(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath);
}

// EN: Database handle variants — used by syncSessions to open DB once
// RU: Варианты с проброшенным handle — syncSessions открывает БД один раз
// EN: Force WAL checkpoint so subsequent reads see all committed writes
// RU: Принудительный WAL checkpoint, чтобы последующие чтения видели все записанные данные
export function checkpointDB(db: DatabaseSync): void {
  try {
    db.exec('PRAGMA wal_checkpoint');
  } catch {
    // checkpoint may fail if another connection has a write lock — ignore
  }
}

function readSessionMeta(db: DatabaseSync, id: string): SessionMeta | null {
  const row = db
    .prepare(`SELECT ${SESSION_COLUMNS.join(', ')} FROM session WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return row as unknown as SessionMeta;
}

function readMessages(db: DatabaseSync, sessionId: string): Message[] {
  const rows = db
    .prepare(`SELECT ${MESSAGE_COLUMNS.join(', ')} FROM message WHERE session_id = ?`)
    .all(sessionId) as Record<string, unknown>[];
  return rows.map((row) => {
    const msg = row as unknown as Message;
    const partRows = db
      .prepare(`SELECT ${PART_COLUMNS.join(', ')} FROM part WHERE message_id = ?`)
      .all(msg.id) as Record<string, unknown>[];
    msg.parts = partRows.map((pr) => pr as unknown as Part);
    return msg;
  });
}

function readSessionMessages(db: DatabaseSync, sessionId: string): SessionMessage[] {
  const rows = db
    .prepare(
      `SELECT ${SESSION_MESSAGE_COLUMNS.join(', ')} FROM session_message WHERE session_id = ?`
    )
    .all(sessionId) as Record<string, unknown>[];
  return rows.map((r) => r as unknown as SessionMessage);
}

function readTodos(db: DatabaseSync, sessionId: string): Todo[] {
  const rows = db
    .prepare(`SELECT ${TODO_COLUMNS.join(', ')} FROM todo WHERE session_id = ?`)
    .all(sessionId) as Record<string, unknown>[];
  return rows.map((r) => r as unknown as Todo);
}

function readShares(db: DatabaseSync, sessionId: string): SessionShare[] {
  const rows = db
    .prepare(`SELECT ${SHARE_COLUMNS.join(', ')} FROM session_share WHERE session_id = ?`)
    .all(sessionId) as Record<string, unknown>[];
  return rows.map((r) => r as unknown as SessionShare);
}

// EN: List session IDs using an already-open DB handle (avoids open/close overhead)
// RU: Список ID сессий через уже открытый DB handle (без лишних open/close)
export function listSessionIdsFromHandle(db: DatabaseSync): string[] {
  const rows = db.prepare('SELECT id FROM session').all() as { id: string }[];
  return rows.map((r) => r.id);
}

export function listSessionIdsFromDB(dbPath: string): string[] {
  if (!fs.existsSync(dbPath)) return [];
  const db = openDB(dbPath);
  try {
    return listSessionIdsFromHandle(db);
  } finally {
    db.close();
  }
}

export function listSessionIdsFromDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

// EN: Read session + all relations (messages, parts, todos, shares) via open handle
// RU: Чтение сессии + всех связей (сообщения, части, todo, шары) через открытый handle
export function readSessionFromHandle(db: DatabaseSync, id: string): Session | null {
  const meta = readSessionMeta(db, id);
  if (!meta) return null;
  return {
    session: meta,
    messages: readMessages(db, id),
    session_messages: readSessionMessages(db, id),
    todos: readTodos(db, id),
    session_shares: readShares(db, id),
  };
}

export function readSessionFromDB(dbPath: string, id: string): Session | null {
  if (!fs.existsSync(dbPath)) return null;
  const db = openDB(dbPath);
  try {
    return readSessionFromHandle(db, id);
  } finally {
    db.close();
  }
}

export function readSessionFromFile(dir: string, id: string): Session | null {
  const filePath = path.join(dir, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);

    if (Array.isArray(parsed.session) && parsed.columns?.session) {
      const session = arrayToObject(parsed.session, parsed.columns.session);
      const messages = (parsed.message ?? []).map((row: unknown[]) => {
        const msg = arrayToObject(row, parsed.columns.message);
        (msg as Record<string, unknown>).parts = (parsed.parts ?? [])
          .filter((p: unknown[]) => p[1] === msg.id)
          .map((p: unknown[]) => arrayToObject(p, parsed.columns.parts));
        return msg;
      });
      const session_messages = (parsed.session_messages ?? []).map((row: unknown[]) =>
        arrayToObject(row, parsed.columns.session_message)
      );
      return {
        session: session as unknown as SessionMeta,
        messages,
        session_messages,
        todos: [],
        session_shares: [],
      } as Session;
    }

    return {
      session: parsed.session ?? parsed,
      messages: parsed.messages ?? [],
      session_messages: parsed.session_messages ?? [],
      todos: parsed.todos ?? [],
      session_shares: parsed.session_shares ?? [],
    } as Session;
  } catch {
    // EN: Backup corrupted file before returning null (data recovery safety net)
    // RU: Бэкап повреждённого файла перед возвратом null (страховка от потери данных)
    try {
      const brokenPath = `${filePath}.broken`;
      if (!fs.existsSync(brokenPath)) {
        fs.copyFileSync(filePath, brokenPath);
      }
    } catch {
      // can't backup either — ignore
    }
    return null;
  }
}

export function readSessionsFromDB(dbPath: string): Session[] {
  if (!fs.existsSync(dbPath)) return [];
  const db = openDB(dbPath);
  try {
    const ids = db.prepare('SELECT id FROM session').all() as { id: string }[];
    return ids.map(({ id }) => ({
      session: readSessionMeta(db, id) as SessionMeta,
      messages: readMessages(db, id),
      session_messages: readSessionMessages(db, id),
      todos: readTodos(db, id),
      session_shares: readShares(db, id),
    }));
  } finally {
    db.close();
  }
}

function arrayToObject(arr: unknown[], colNames: string[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < colNames.length; i++) {
    obj[colNames[i]] = arr[i] ?? null;
  }
  return obj;
}

export function readSessionsFromDir(dir: string): Session[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  return files.map((file) => {
    const content = fs.readFileSync(path.join(dir, file), 'utf-8');
    const parsed = JSON.parse(content);

    if (Array.isArray(parsed.session) && parsed.columns?.session) {
      const session = arrayToObject(parsed.session, parsed.columns.session);
      const messages = (parsed.message ?? []).map((row: unknown[]) => {
        const msg = arrayToObject(row, parsed.columns.message);
        (msg as Record<string, unknown>).parts = (parsed.parts ?? [])
          .filter((p: unknown[]) => p[1] === msg.id)
          .map((p: unknown[]) => arrayToObject(p, parsed.columns.parts));
        return msg;
      });
      const session_messages = (parsed.session_messages ?? []).map((row: unknown[]) =>
        arrayToObject(row, parsed.columns.session_message)
      );
      return {
        session: session as unknown as SessionMeta,
        messages,
        session_messages,
        todos: [],
        session_shares: [],
      } as Session;
    }

    return {
      session: parsed.session ?? parsed,
      messages: parsed.messages ?? [],
      session_messages: parsed.session_messages ?? [],
      todos: parsed.todos ?? [],
      session_shares: parsed.session_shares ?? [],
    } as Session;
  });
}

function asSQLValue(val: unknown): string | number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return val;
  if (typeof val === 'boolean') return val ? 1 : 0;
  return JSON.stringify(val);
}

function upsertSession(db: DatabaseSync, s: SessionMeta): void {
  const values = SESSION_COLUMNS.map((col) =>
    asSQLValue((s as unknown as Record<string, unknown>)[col])
  );
  try {
    db.prepare(
      `INSERT OR REPLACE INTO session (${SESSION_COLUMNS.join(', ')}) VALUES (${SESSION_COLUMNS.map(() => '?').join(',')})`
    ).run(...values);
  } catch (e) {
    throw new Error(`upsertSession failed for session ${s.id}: ${e}`);
  }
}

function upsertMessages(db: DatabaseSync, messages: Message[]): void {
  const placeholders = MESSAGE_COLUMNS.map(() => '?').join(', ');
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO message (${MESSAGE_COLUMNS.join(', ')}) VALUES (${placeholders})`
  );
  for (const msg of messages) {
    try {
      stmt.run(v(msg.id), v(msg.session_id), v(msg.time_created), v(msg.time_updated), v(msg.data));
    } catch (e) {
      throw new Error(`upsertMessages failed for msg ${msg.id}: ${e}`);
    }
  }
}

function upsertParts(db: DatabaseSync, parts: Part[]): void {
  const placeholders = PART_COLUMNS.map(() => '?').join(', ');
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO part (${PART_COLUMNS.join(', ')}) VALUES (${placeholders})`
  );
  for (const part of parts) {
    try {
      stmt.run(
        v(part.id),
        v(part.message_id),
        v(part.session_id),
        v(part.time_created),
        v(part.time_updated),
        v(part.data)
      );
    } catch (e) {
      throw new Error(`upsertParts failed for part ${part.id}: ${e}`);
    }
  }
}

function v(val: unknown): string | number | null {
  return asSQLValue(val);
}

function upsertSessionMessages(db: DatabaseSync, items: SessionMessage[]): void {
  const placeholders = SESSION_MESSAGE_COLUMNS.map(() => '?').join(', ');
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO session_message (${SESSION_MESSAGE_COLUMNS.join(', ')}) VALUES (${placeholders})`
  );
  for (const sm of items) {
    stmt.run(
      v(sm.id),
      v(sm.session_id),
      v(sm.type),
      v(sm.time_created),
      v(sm.time_updated),
      v(sm.data)
    );
  }
}

function upsertTodos(db: DatabaseSync, items: Todo[]): void {
  const placeholders = TODO_COLUMNS.map(() => '?').join(', ');
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO todo (${TODO_COLUMNS.join(', ')}) VALUES (${placeholders})`
  );
  for (const todo of items) {
    stmt.run(
      v(todo.session_id),
      v(todo.content),
      v(todo.status),
      v(todo.priority),
      v(todo.position),
      v(todo.time_created),
      v(todo.time_updated)
    );
  }
}

function upsertShares(db: DatabaseSync, items: SessionShare[]): void {
  const placeholders = SHARE_COLUMNS.map(() => '?').join(', ');
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO session_share (${SHARE_COLUMNS.join(', ')}) VALUES (${placeholders})`
  );
  for (const share of items) {
    stmt.run(
      v(share.session_id),
      v(share.id),
      v(share.secret),
      v(share.url),
      v(share.time_created),
      v(share.time_updated)
    );
  }
}

// EN: Batch-write multiple sessions in one transaction (avoids per-session DB open/close)
// RU: Пакетная запись нескольких сессий одной транзакцией (без per-session open/close БД)
export function writeSessionsToHandle(db: DatabaseSync, sessions: Session[]): void {
  if (sessions.length === 0) return;
  db.exec('BEGIN TRANSACTION');
  try {
    for (const s of sessions) {
      upsertSession(db, s.session);
      upsertMessages(db, s.messages);
      for (const msg of s.messages) {
        upsertParts(db, msg.parts);
      }
      upsertSessionMessages(db, s.session_messages);
      upsertTodos(db, s.todos);
      upsertShares(db, s.session_shares);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function writeSessionsToDB(dbPath: string, sessions: Session[]): void {
  if (sessions.length === 0) return;
  const db = openDB(dbPath);
  try {
    writeSessionsToHandle(db, sessions);
  } finally {
    db.close();
  }
}

// EN: Write single session to JSON file (compact format, no pretty-print — saves ~30% disk)
// RU: Запись одной сессии в JSON-файл (compact, без pretty-print — экономия ~30% места)
export function writeSessionToFile(dir: string, session: Session): void {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${session.session.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(session), 'utf-8');
}

export function writeSessionsToDir(dir: string, sessions: Session[]): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const s of sessions) {
    writeSessionToFile(dir, s);
  }
}
