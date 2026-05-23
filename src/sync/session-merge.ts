import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Message, Part, Session, Todo } from './session-db.js';
import {
  checkpointDB,
  listSessionIdsFromDir,
  listSessionIdsFromHandle,
  readSessionFromFile,
  readSessionFromHandle,
  writeSessionsToHandle,
  writeSessionToFile,
} from './session-db.js';

export interface SyncSessionResult {
  total: number;
  merged: number;
  conflicts: number;
}

// EN: Pick the newer record by time_updated (null treated as oldest)
// RU: Выбор более новой записи по time_updated (null считается старым)
function pickNewer<T extends { time_updated: string | null }>(a: T, b: T): T {
  if (!a.time_updated) return b;
  if (!b.time_updated) return a;
  return a.time_updated >= b.time_updated ? a : b;
}

function unionMessages(local: Message[], remote: Message[]): Message[] {
  const map = new Map<string, Message>();
  for (const msg of local) map.set(msg.id, msg);
  for (const msg of remote) {
    const existing = map.get(msg.id);
    if (!existing) {
      map.set(msg.id, msg);
    } else {
      const winner = pickNewer(existing, msg);
      winner.parts = unionParts(existing.parts, msg.parts);
      map.set(msg.id, winner);
    }
  }
  return [...map.values()];
}

function unionParts(local: Part[], remote: Part[]): Part[] {
  const map = new Map<string, Part>();
  for (const part of local) map.set(part.id, part);
  for (const part of remote) {
    const existing = map.get(part.id);
    map.set(part.id, existing ? pickNewer(existing, part) : part);
  }
  return [...map.values()];
}

function unionById<T extends { id: string; time_updated: string | null }>(
  local: T[],
  remote: T[]
): T[] {
  const map = new Map<string, T>();
  for (const item of local) map.set(item.id, item);
  for (const item of remote) {
    const existing = map.get(item.id);
    map.set(item.id, existing ? pickNewer(existing, item) : item);
  }
  return [...map.values()];
}

function unionTodos(local: Todo[], remote: Todo[]): Todo[] {
  const map = new Map<string, Todo>();
  for (const item of local) {
    const key = `${item.session_id}:${item.content ?? ''}`;
    map.set(key, item);
  }
  for (const item of remote) {
    const key = `${item.session_id}:${item.content ?? ''}`;
    const existing = map.get(key);
    map.set(key, existing ? pickNewer(existing, item) : item);
  }
  return [...map.values()];
}

// EN: Union-merge two session versions — picks newer session metadata + unions all relations by id
// RU: Union-merge двух версий сессии — берёт новую мету, объединяет все связи по id
function merge(local: Session, remote: Session): Session {
  const localT = local.session.time_updated ?? '';
  const remoteT = remote.session.time_updated ?? '';
  const mergedSession = localT >= remoteT ? local.session : remote.session;

  return {
    session: mergedSession,
    messages: unionMessages(local.messages, remote.messages),
    session_messages: unionById(local.session_messages, remote.session_messages),
    todos: unionTodos(local.todos, remote.todos),
    session_shares: unionById(local.session_shares, remote.session_shares),
  };
}

// EN: Stream-based session sync — opens DB once, processes sessions one-by-one, batch-writes at end
// EN: Single DB connection eliminates per-session open/close overhead (was N+2 open/close per cycle)
// RU: Потоковая синхронизация — одно открытие БД, обработка сессий по одной, batch-запись в конце
// RU: Одно соединение с БД устраняет per-session накладные расходы (было N+2 open/close за цикл)
export async function syncSessions(
  dbPath: string,
  sessionsDir: string
): Promise<SyncSessionResult> {
  const remoteIds = listSessionIdsFromDir(sessionsDir);

  const dbExists = fs.existsSync(dbPath);
  const db = dbExists ? new DatabaseSync(dbPath) : null;
  if (db) {
    checkpointDB(db);
  }

  try {
    const localIds = db ? listSessionIdsFromHandle(db) : [];
    const allIds = new Set([...localIds, ...remoteIds]);
    let totalMerged = 0;
    const hasRemote = remoteIds.length > 0;
    const toWrite: Session[] = [];

    for (const id of allIds) {
      const local = db ? readSessionFromHandle(db, id) : null;
      const remote = readSessionFromFile(sessionsDir, id);

      let merged: Session;

      if (!local) {
        merged = structuredClone(remote as Session);
      } else if (!remote) {
        merged = structuredClone(local);
      } else {
        totalMerged++;
        merged = merge(local, remote);
      }

      if (hasRemote && local) {
        toWrite.push(merged);
      }
      writeSessionToFile(sessionsDir, merged);
    }

    if (db && toWrite.length > 0) {
      writeSessionsToHandle(db, toWrite);
    }

    return {
      total: allIds.size,
      merged: totalMerged,
      conflicts: 0,
    };
  } finally {
    db?.close();
  }
}
