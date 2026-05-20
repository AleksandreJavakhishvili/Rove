import { attributeClaudePids, getLiveClaudes } from '../lsof.ts';
import { runtime } from '../runtime.ts';

/**
 * "Desktop attribution": figure out which (non-bridge) `claude` processes are
 * holding a session backing file open. The SDK can't tell us this — it only
 * knows about its own in-process Query iterators. We still need this for the
 * "take over from desktop" flow, so it lives in this tiny helper, imported by
 * the SDK driver.
 *
 * Two entry points:
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
