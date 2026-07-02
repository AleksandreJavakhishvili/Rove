import * as SQLite from 'expo-sqlite';
import type { TaggedSession } from '@/lib/aggregator';

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT NOT NULL,
    agent TEXT NOT NULL,
    bridge_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    project_name TEXT NOT NULL,
    last_modified INTEGER NOT NULL,
    preview TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    status TEXT NOT NULL,
    cached_at INTEGER NOT NULL,
    PRIMARY KEY (id, agent, bridge_id)
  )
`;

// Single promise ensures only one open+init ever runs, even with concurrent callers.
let _dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!_dbPromise) {
    _dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync('rove-sessions.db');
      await db.execAsync(CREATE_TABLE);
      return db;
    })();
  }
  return _dbPromise;
}

function rowToTaggedSession(row: Record<string, unknown>): TaggedSession {
  return {
    id: row.id as string,
    agent: row.agent as string,
    bridgeId: row.bridge_id as string,
    cwd: row.cwd as string,
    projectName: row.project_name as string,
    lastModified: row.last_modified as number,
    preview: row.preview as string,
    sizeBytes: row.size_bytes as number,
    status: row.status as TaggedSession['status'],
    desktopPids: [],
  };
}

async function upsert(bridgeId: string, sessions: TaggedSession[]): Promise<void> {
  if (sessions.length === 0) return;
  const db = await getDb();
  const now = Date.now();
  for (const s of sessions) {
    await db.runAsync(
      `INSERT OR REPLACE INTO sessions
        (id, agent, bridge_id, cwd, project_name, last_modified, preview, size_bytes, status, cached_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [s.id, s.agent, bridgeId, s.cwd, s.projectName, s.lastModified, s.preview, s.sizeBytes, s.status, now],
    );
  }
}

async function getAllForBridge(bridgeId: string): Promise<TaggedSession[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    'SELECT * FROM sessions WHERE bridge_id = ?',
    [bridgeId],
  );
  return rows.map(rowToTaggedSession);
}

async function getLastImportTime(bridgeId: string): Promise<number | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ max_cached_at: number | null }>(
    'SELECT MAX(cached_at) AS max_cached_at FROM sessions WHERE bridge_id = ?',
    [bridgeId],
  );
  return row?.max_cached_at ?? null;
}

async function purgeOlderThan(bridgeId: string, cutoffMs: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'DELETE FROM sessions WHERE bridge_id = ? AND last_modified < ?',
    [bridgeId, cutoffMs],
  );
}

export const sessionDb = { upsert, getAllForBridge, getLastImportTime, purgeOlderThan };
