import type { Session, Message, Part, SessionMessage, Todo } from './session-db.js';
import { readSessionsFromDB, readSessionsFromDir, writeSessionsToDB, writeSessionsToDir } from './session-db.js';

export interface SyncSessionResult {
  total: number;
  merged: number;
  conflicts: number;
}

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

function unionById<T extends { id: string; time_updated: string | null }>(local: T[], remote: T[]): T[] {
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

export async function syncSessions(
  dbPath: string,
  sessionsDir: string
): Promise<SyncSessionResult> {
  const localSessions = readSessionsFromDB(dbPath);
  const remoteSessions = readSessionsFromDir(sessionsDir);

  const localMap = new Map<string, Session>();
  for (const s of localSessions) localMap.set(s.session.id, s);

  const remoteMap = new Map<string, Session>();
  for (const s of remoteSessions) remoteMap.set(s.session.id, s);

  const allIds = new Set([...localMap.keys(), ...remoteMap.keys()]);
  const merged: Session[] = [];
  let mergeCount = 0;
  let conflictCount = 0;

  for (const id of allIds) {
    const local = localMap.get(id);
    const remote = remoteMap.get(id);

    if (!local) {
      merged.push(structuredClone(remote!));
      continue;
    }
    if (!remote) {
      merged.push(structuredClone(local));
      continue;
    }

    mergeCount++;
    merged.push(merge(local, remote));
  }

  writeSessionsToDB(dbPath, merged);
  writeSessionsToDir(sessionsDir, merged);

  return {
    total: allIds.size,
    merged: mergeCount,
    conflicts: conflictCount,
  };
}
