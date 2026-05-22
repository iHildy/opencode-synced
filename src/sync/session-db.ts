import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

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
  'id', 'project_id', 'parent_id', 'slug', 'directory',
  'title', 'version', 'share_url', 'summary_additions',
  'summary_deletions', 'summary_files', 'summary_diffs',
  'revert', 'permission', 'time_created', 'time_updated',
  'time_compacting', 'time_archived', 'workspace_id',
  'path', 'agent', 'model', 'cost', 'tokens_input',
  'tokens_output', 'tokens_reasoning', 'tokens_cache_read',
  'tokens_cache_write',
];

const MESSAGE_COLUMNS = ['id', 'session_id', 'time_created', 'time_updated', 'data'];
const PART_COLUMNS = ['id', 'message_id', 'session_id', 'time_created', 'time_updated', 'data'];
const SESSION_MESSAGE_COLUMNS = ['id', 'session_id', 'type', 'time_created', 'time_updated', 'data'];
const TODO_COLUMNS = ['session_id', 'content', 'status', 'priority', 'position', 'time_created', 'time_updated'];
const SHARE_COLUMNS = ['session_id', 'id', 'secret', 'url', 'time_created', 'time_updated'];

function openDB(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath);
}

function readSessionMeta(db: DatabaseSync, id: string): SessionMeta | null {
  const row = db.prepare(`SELECT ${SESSION_COLUMNS.join(', ')} FROM session WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return row as unknown as SessionMeta;
}

function readMessages(db: DatabaseSync, sessionId: string): Message[] {
  const rows = db.prepare(`SELECT ${MESSAGE_COLUMNS.join(', ')} FROM message WHERE session_id = ?`).all(sessionId) as Record<string, unknown>[];
  return rows.map((row) => {
    const msg = row as unknown as Message;
    const partRows = db.prepare(`SELECT ${PART_COLUMNS.join(', ')} FROM part WHERE message_id = ?`).all(msg.id) as Record<string, unknown>[];
    msg.parts = partRows.map((pr) => pr as unknown as Part);
    return msg;
  });
}

function readSessionMessages(db: DatabaseSync, sessionId: string): SessionMessage[] {
  const rows = db.prepare(`SELECT ${SESSION_MESSAGE_COLUMNS.join(', ')} FROM session_message WHERE session_id = ?`).all(sessionId) as Record<string, unknown>[];
  return rows.map((r) => r as unknown as SessionMessage);
}

function readTodos(db: DatabaseSync, sessionId: string): Todo[] {
  const rows = db.prepare(`SELECT ${TODO_COLUMNS.join(', ')} FROM todo WHERE session_id = ?`).all(sessionId) as Record<string, unknown>[];
  return rows.map((r) => r as unknown as Todo);
}

function readShares(db: DatabaseSync, sessionId: string): SessionShare[] {
  const rows = db.prepare(`SELECT ${SHARE_COLUMNS.join(', ')} FROM session_share WHERE session_id = ?`).all(sessionId) as Record<string, unknown>[];
  return rows.map((r) => r as unknown as SessionShare);
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

export function readSessionsFromDir(dir: string): Session[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  return files.map((file) => {
    const content = fs.readFileSync(path.join(dir, file), 'utf-8');
    const parsed = JSON.parse(content);
    return {
      session: parsed.session ?? parsed,
      messages: parsed.messages ?? [],
      session_messages: parsed.session_messages ?? [],
      todos: parsed.todos ?? [],
      session_shares: parsed.session_shares ?? [],
    } as Session;
  });
}

function deleteSession(db: DatabaseSync, id: string): void {
  const msgIds = db.prepare('SELECT id FROM message WHERE session_id = ?').all(id) as { id: string }[];
  for (const { id: mid } of msgIds) {
    db.prepare('DELETE FROM part WHERE message_id = ?').run(mid);
  }
  db.prepare('DELETE FROM message WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM session_message WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM todo WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM session_share WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM session WHERE id = ?').run(id);
}

function asSQLValue(val: unknown): string | number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string' || typeof val === 'number') return val;
  return String(val);
}

function insertSession(db: DatabaseSync, s: SessionMeta): void {
  const placeholders = SESSION_COLUMNS.map(() => '?').join(', ');
  const values = SESSION_COLUMNS.map((col) => asSQLValue((s as unknown as Record<string, unknown>)[col]));
  db.prepare(`INSERT INTO session (${SESSION_COLUMNS.join(', ')}) VALUES (${placeholders})`).run(...values);
}

function insertMessages(db: DatabaseSync, messages: Message[]): void {
  const placeholders = MESSAGE_COLUMNS.map(() => '?').join(', ');
  const stmt = db.prepare(`INSERT INTO message (${MESSAGE_COLUMNS.join(', ')}) VALUES (${placeholders})`);
  for (const msg of messages) {
    stmt.run(msg.id, msg.session_id, msg.time_created, msg.time_updated, msg.data);
  }
}

function insertParts(db: DatabaseSync, parts: Part[]): void {
  const placeholders = PART_COLUMNS.map(() => '?').join(', ');
  const stmt = db.prepare(`INSERT INTO part (${PART_COLUMNS.join(', ')}) VALUES (${placeholders})`);
  for (const part of parts) {
    stmt.run(part.id, part.message_id, part.session_id, part.time_created, part.time_updated, part.data);
  }
}

function insertSessionMessages(db: DatabaseSync, items: SessionMessage[]): void {
  const placeholders = SESSION_MESSAGE_COLUMNS.map(() => '?').join(', ');
  const stmt = db.prepare(`INSERT INTO session_message (${SESSION_MESSAGE_COLUMNS.join(', ')}) VALUES (${placeholders})`);
  for (const sm of items) {
    stmt.run(sm.id, sm.session_id, sm.type, sm.time_created, sm.time_updated, sm.data);
  }
}

function insertTodos(db: DatabaseSync, items: Todo[]): void {
  const placeholders = TODO_COLUMNS.map(() => '?').join(', ');
  const stmt = db.prepare(`INSERT INTO todo (${TODO_COLUMNS.join(', ')}) VALUES (${placeholders})`);
  for (const todo of items) {
    stmt.run(todo.session_id, todo.content, todo.status, todo.priority, todo.position, todo.time_created, todo.time_updated);
  }
}

function insertShares(db: DatabaseSync, items: SessionShare[]): void {
  const placeholders = SHARE_COLUMNS.map(() => '?').join(', ');
  const stmt = db.prepare(`INSERT INTO session_share (${SHARE_COLUMNS.join(', ')}) VALUES (${placeholders})`);
  for (const share of items) {
    stmt.run(share.session_id, share.id, share.secret, share.url, share.time_created, share.time_updated);
  }
}

export function writeSessionsToDB(dbPath: string, sessions: Session[]): void {
  if (sessions.length === 0) return;
  const db = openDB(dbPath);
  try {
    db.exec('BEGIN TRANSACTION');
    for (const s of sessions) {
      const exists = db.prepare('SELECT 1 FROM session WHERE id = ?').get(s.session.id);
      if (exists) {
        deleteSession(db, s.session.id);
      }
      insertSession(db, s.session);
      insertMessages(db, s.messages);
      for (const msg of s.messages) {
        insertParts(db, msg.parts);
      }
      insertSessionMessages(db, s.session_messages);
      insertTodos(db, s.todos);
      insertShares(db, s.session_shares);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

export function writeSessionsToDir(dir: string, sessions: Session[]): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const s of sessions) {
    const filePath = path.join(dir, `${s.session.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(s, null, 2), 'utf-8');
  }
}
