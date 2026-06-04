import { attributeClaudePids, getLiveClaudes } from '../lsof.ts';
import { runtime } from '../runtime.ts';
import { desktopPidsForSessionFromRegistry, readSessionRegistry } from '../sessionRegistry.ts';

/**
 * "Desktop attribution": figure out which (non-bridge) `claude` processes are
 * driving a given session. The SDK can't tell us this — it only knows about its
 * own in-process Query iterators. We need it for the "take over from desktop"
 * flow, so it lives in this tiny helper, imported by the SDK driver.
 *
 * Preferred source: Claude v2.x's `~/.claude/sessions/<pid>.json` registry,
 * which maps each live `claude` pid to the EXACT session id it's on (see
 * [[sessionRegistry.ts]]). That replaces the old guesswork — a desktop CLI
 * started without `--resume` carries no session id in its argv, so the legacy
 * heuristic below could only infer ownership from cwd + "most recently modified
 * JSONL" and would misattribute (and, on takeover, SIGKILL) a desktop CLI that
 * merely shared a directory with the target session.
 *
 * Legacy fallback (only when the registry dir is absent, i.e. older claude):
 *  - `attributeManySessions(items)` — single ps snapshot, scored against many
 *    sessions in one go. Used by `listSessions()` so we don't fork ps per row.
 *  - `getDesktopPidsForSession({ sessionId, cwd, isMostRecentInCwd })` — single
 *    session, with the "most recent in cwd" flag computed by the caller.
 */

export interface SessionForAttribution {
  id: string;
  cwd: string;
  lastModified: number;
}

export async function attributeManySessions(
  items: SessionForAttribution[],
): Promise<Map<string, number[]>> {
  // Registry-first: exact pid -> sessionId, no cwd guessing. One read covers
  // all rows. SDK children (entrypoint "sdk-ts") are already excluded inside
  // the registry helper.
  const registry = await readSessionRegistry();
  if (registry.available) {
    const bySession = new Map<string, number[]>();
    for (const s of registry.sessions) {
      if (s.entrypoint === 'sdk-ts') continue;
      const arr = bySession.get(s.sessionId);
      if (arr) arr.push(s.pid);
      else bySession.set(s.sessionId, [s.pid]);
    }
    const out = new Map<string, number[]>();
    for (const it of items) out.set(it.id, bySession.get(it.id) ?? []);
    return out;
  }

  // Legacy fallback (pre-2.x claude with no session registry).
  const liveClaudes = await getLiveClaudes();
  const ourPids = new Set<number>();
  for (const pid of runtime.livePids().values()) ourPids.add(pid);

  // For each cwd, find the most-recently-modified session — that's the one a
  // desktop `claude` with this cwd and no --resume arg is most likely on.
  const newestByCwd = new Map<string, { id: string; mtime: number }>();
  for (const it of items) {
    const prev = newestByCwd.get(it.cwd);
    if (!prev || it.lastModified > prev.mtime) {
      newestByCwd.set(it.cwd, { id: it.id, mtime: it.lastModified });
    }
  }

  const out = new Map<string, number[]>();
  for (const it of items) {
    const isMostRecent = newestByCwd.get(it.cwd)?.id === it.id;
    out.set(
      it.id,
      attributeClaudePids({
        liveClaudes,
        sessionId: it.id,
        isMostRecentInProject: isMostRecent,
        sessionCwd: it.cwd,
        ourPids,
      }),
    );
  }
  return out;
}

export async function getDesktopPidsForSession(opts: {
  sessionId: string;
  cwd: string;
  isMostRecentInCwd: boolean;
}): Promise<number[]> {
  // Registry-first: exact match on session id (returns null when unavailable).
  const fromRegistry = await desktopPidsForSessionFromRegistry(opts.sessionId);
  if (fromRegistry !== null) return fromRegistry;

  // Legacy fallback (pre-2.x claude with no session registry).
  const liveClaudes = await getLiveClaudes();
  const ourPids = new Set<number>();
  for (const pid of runtime.livePids().values()) ourPids.add(pid);
  return attributeClaudePids({
    liveClaudes,
    sessionId: opts.sessionId,
    isMostRecentInProject: opts.isMostRecentInCwd,
    sessionCwd: opts.cwd,
    ourPids,
  });
}
