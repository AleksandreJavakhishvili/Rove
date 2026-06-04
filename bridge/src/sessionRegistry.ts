import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.ts';

/**
 * One entry from Claude Code's live-session registry. Claude v2.x writes a
 * `~/.claude/sessions/<pid>.json` file for every running `claude` — interactive
 * terminal, `--continue`, `--resume`, bare, or SDK-spawned — and keeps it
 * updated with the session id and cwd that process is actually on.
 *
 * This is the ONLY reliable way to know which session a desktop CLI is driving:
 * a human-started `claude` (or `claude --resume` / `claude --continue`) carries
 * NO session id in its argv, so the old `ps`-scan heuristic could only *guess*
 * via cwd + "most recently modified JSONL", which misattributes a desktop CLI
 * that happens to share a directory with the target session — and then the
 * takeover route SIGKILLs the wrong process. The registry gives us an exact
 * pid -> sessionId map instead. See [[desktopPids.ts]].
 */
export interface RegistrySession {
  pid: number;
  sessionId: string;
  cwd: string;
  /** "interactive" for a real terminal session; other kinds exist for headless. */
  kind?: string;
  /** "cli" for a desktop terminal, "sdk-ts" for an Agent-SDK-spawned child (incl. ours). */
  entrypoint?: string;
  /** "idle" / "running" etc. — present on cli sessions, absent on some sdk ones. */
  status?: string;
}

export interface RegistrySnapshot {
  /** False when the registry dir doesn't exist (older claude) — callers fall back to the ps heuristic. */
  available: boolean;
  sessions: RegistrySession[];
}

const CACHE_TTL_MS = 2500;
let cache: { fetchedAt: number; snapshot: RegistrySnapshot } | null = null;

/**
 * Drop the cached registry snapshot. Mirrors `invalidateClaudeCache()` — the
 * takeover route calls it right after killing a desktop pid so the next
 * conflict check doesn't see the dead process still listed.
 */
export function invalidateRegistryCache(): void {
  cache = null;
}

/**
 * Snapshot of all live `claude` sessions from `~/.claude/sessions`. Cached for
 * a few seconds so the /sessions listing can call it per row. `available` is
 * false only when the directory is missing entirely (pre-2.x claude); an empty
 * but present directory returns `{ available: true, sessions: [] }`, which
 * correctly means "no desktop session is live."
 */
export async function readSessionRegistry(): Promise<RegistrySnapshot> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.snapshot;

  let files: string[];
  try {
    files = await readdir(config.sessionsDir);
  } catch {
    const snapshot = { available: false, sessions: [] as RegistrySession[] };
    cache = { fetchedAt: now, snapshot };
    return snapshot;
  }

  const sessions: RegistrySession[] = [];
  await Promise.all(
    files.map(async (f) => {
      if (!f.endsWith('.json')) return;
      try {
        const raw = await readFile(join(config.sessionsDir, f), 'utf8');
        const j = JSON.parse(raw) as Partial<RegistrySession>;
        if (typeof j.pid === 'number' && typeof j.sessionId === 'string') {
          sessions.push({
            pid: j.pid,
            sessionId: j.sessionId,
            cwd: typeof j.cwd === 'string' ? j.cwd : '',
            kind: j.kind,
            entrypoint: j.entrypoint,
            status: j.status,
          });
        }
      } catch {
        // Partial write or malformed file — skip; next refresh picks it up.
      }
    }),
  );

  const snapshot = { available: true, sessions };
  cache = { fetchedAt: now, snapshot };
  return snapshot;
}

/**
 * Live `claude` PIDs that are on EXACTLY this session id, per the registry.
 *
 * Returns `null` when the registry isn't available (older claude) so the caller
 * can fall back to the legacy ps heuristic. When the registry IS available, an
 * empty array is authoritative: nobody is on this session.
 *
 * Excludes `entrypoint: "sdk-ts"` processes — those are Agent-SDK children
 * (our own bridge child driving this very session, or another bridge). The
 * "desktop CLI" takeover flow only ever targets human terminal sessions, so we
 * never want to SIGKILL an SDK child here. A stale file for a dead pid is
 * filtered by the `process.kill(pid, 0)` liveness probe that callers already
 * apply (see runtime.checkDesktopConflict).
 */
export async function desktopPidsForSessionFromRegistry(sessionId: string): Promise<number[] | null> {
  const { available, sessions } = await readSessionRegistry();
  if (!available) return null;
  return sessions
    .filter((s) => s.sessionId === sessionId && s.entrypoint !== 'sdk-ts')
    .map((s) => s.pid);
}
