import fs from 'node:fs';

export interface ProjectEntry {
  worktree: string;
  expanded?: boolean;
}

export interface ServerData {
  list: unknown[];
  projects: {
    local: ProjectEntry[];
  };
  lastProject?: { local?: string };
}

export interface LastProjectSessionEntry {
  directory: string;
  id: string;
  at: number;
}

export interface LayoutPageData {
  lastProjectSession?: Record<string, LastProjectSessionEntry>;
}

export interface GlobalData {
  [key: string]: string;
}

function readGlobalData(filePath: string): GlobalData | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as GlobalData;
  } catch {
    return null;
  }
}

function writeGlobalData(filePath: string, data: GlobalData): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, '\t'), 'utf-8');
}

function parseServer(raw: string | undefined): ServerData | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ServerData;
  } catch {
    return null;
  }
}

function parseLayoutPage(raw: string | undefined): LayoutPageData | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LayoutPageData;
  } catch {
    return null;
  }
}

function unionProjects(local: ProjectEntry[], remote: ProjectEntry[]): ProjectEntry[] {
  const map = new Map<string, ProjectEntry>();
  for (const p of local) map.set(p.worktree.toLowerCase(), p);
  for (const p of remote) {
    const key = p.worktree.toLowerCase();
    if (!map.has(key)) {
      map.set(key, p);
    }
  }
  return [...map.values()];
}

function unionLastSession(
  local: Record<string, LastProjectSessionEntry> | undefined,
  remote: Record<string, LastProjectSessionEntry> | undefined
): Record<string, LastProjectSessionEntry> {
  const map = new Map<string, LastProjectSessionEntry>();
  if (local) {
    for (const [dir, entry] of Object.entries(local)) {
      map.set(dir.toLowerCase(), entry);
    }
  }
  if (remote) {
    for (const [dir, entry] of Object.entries(remote)) {
      const key = dir.toLowerCase();
      const existing = map.get(key);
      if (!existing || entry.at > existing.at) {
        map.set(key, entry);
      }
    }
  }
  const result: Record<string, LastProjectSessionEntry> = {};
  for (const [_, entry] of map) {
    result[entry.directory] = entry;
  }
  return result;
}

export function syncGlobalData(localPath: string, remotePath: string): boolean {
  const local = readGlobalData(localPath);
  const remote = readGlobalData(remotePath);

  if (!local && !remote) return false;
  if (!local) {
    if (remote) writeGlobalData(localPath, remote);
    return true;
  }
  if (!remote) {
    writeGlobalData(remotePath, local);
    return true;
  }

  const merged: GlobalData = { ...local };

  for (const key of Object.keys(remote)) {
    if (key === 'server') {
      const localServer = parseServer(local[key]);
      const remoteServer = parseServer(remote[key]);
      if (localServer && remoteServer) {
        const mergedProjects = unionProjects(
          localServer.projects?.local ?? [],
          remoteServer.projects?.local ?? []
        );
        merged[key] = JSON.stringify({
          ...localServer,
          projects: { local: mergedProjects },
        });
      } else {
        merged[key] = local[key] ?? remote[key];
      }
    } else if (key === 'layout.page') {
      const localLayout = parseLayoutPage(local[key]);
      const remoteLayout = parseLayoutPage(remote[key]);
      if (localLayout && remoteLayout) {
        const mergedSessions = unionLastSession(
          localLayout.lastProjectSession,
          remoteLayout.lastProjectSession
        );
        merged[key] = JSON.stringify({
          ...localLayout,
          lastProjectSession: mergedSessions,
        });
      } else {
        merged[key] = local[key] ?? remote[key];
      }
    } else if (!(key in local)) {
      merged[key] = remote[key];
    }
  }

  writeGlobalData(localPath, merged);
  writeGlobalData(remotePath, merged);
  return true;
}
