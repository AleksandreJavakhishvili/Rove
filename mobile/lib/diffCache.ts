import { fetchDiff, type DiffFile, type SessionDiff } from './bridge';
import type { AgentKind } from './types';

interface BridgeConfig {
  baseUrl: string;
  token?: string;
}

/**
 * Process-wide cache + in-flight dedup for per-file `/diff?path=` fetches.
 *
 * Why a cache: every Edit / Write / MultiEdit tool card wants to render its
 * own inline diff. A turn with 20 file edits would otherwise burst 20
 * round-trips. The cache keys on `(agent, sessionId, path)` and pairs with
 * explicit invalidation from the chat container's `file_changed` handler so
 * stale entries don't outlive the underlying file.
 *
 * Why in-flight dedup: two cards (e.g. two MultiEdits touching the same
 * file) mounting in the same render pass would still trigger two fetches
 * without dedup. Dedup keys on the same `(agent, sessionId, path)` triple,
 * resolving every concurrent caller from one network round-trip.
 */

/** Soft wall-clock TTL — anything older than this is refetched even if not
 *  explicitly invalidated. Generous because invalidation does the heavy
 *  lifting; the TTL is just a safety net for missed-event scenarios. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** LRU cap. Each entry holds the parsed hunks for one file's diff; even
 *  a chunky file is small. 200 covers any realistic session length. */
const MAX_ENTRIES = 200;

interface CacheValue {
  fetchedAt: number;
  /** `null` when the server returned no diff for the path (file untouched
   *  since baseline). We cache the absence so subsequent mounts don't
   *  re-fetch only to discover the same nothing. */
  file: DiffFile | null;
}

const cache = new Map<string, CacheValue>();
const inFlight = new Map<string, Promise<DiffFile | null>>();

function cacheKey(agent: AgentKind, sessionId: string, path: string): string {
  return `${agent}::${sessionId}::${path}`;
}

/** Pull a cached entry up to the front of LRU order. */
function touch(key: string, value: CacheValue): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export interface GetInlineDiffOpts {
  /** When true, bypass the cache and force a fresh fetch. Caller is
   *  responsible for not abusing this — the inline-diff component does
   *  this on long-press refresh. */
  force?: boolean;
}

/**
 * Resolve the diff for a single file, hitting the cache + dedup table
 * where possible. Returns `null` when the bridge reports no diff for the
 * path (file is untouched since session baseline). Throws when the fetch
 * itself errors.
 */
export async function getInlineDiff(
  cfg: BridgeConfig,
  agent: AgentKind,
  sessionId: string,
  path: string,
  opts: GetInlineDiffOpts = {},
): Promise<DiffFile | null> {
  const key = cacheKey(agent, sessionId, path);

  if (!opts.force) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      touch(key, cached);
      return cached.file;
    }
  }

  const existing = inFlight.get(key);
  if (existing) return existing;

  const pending = fetchDiff(cfg, agent, sessionId, { path })
    .then((session: SessionDiff) => {
      // Bridge returns at most one file per path query; rename can produce
      // two but we pick the first that mentions `path` as newPath, falling
      // back to oldPath. Good enough for the inline preview.
      const match =
        session.files.find((f) => f.newPath === path) ??
        session.files.find((f) => f.oldPath === path) ??
        null;
      const value: CacheValue = { fetchedAt: Date.now(), file: match };
      touch(key, value);
      return match;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, pending);
  return pending;
}

/** Invalidate every cached diff entry for `path` under any (agent, sessionId).
 *  Called from the chat container's `file_changed` handler so the next
 *  render of an inline diff for the affected file refetches. */
export function invalidateInlineDiffsForPath(path: string): void {
  // Walk keys with the suffix `::${path}` — small map, simple loop.
  const suffix = `::${path}`;
  for (const key of cache.keys()) {
    if (key.endsWith(suffix)) cache.delete(key);
  }
}

/** Drop the entire cache for a (agent, sessionId). Called when a chat
 *  session unmounts so dead sessions don't pin memory indefinitely. */
export function clearInlineDiffCacheForSession(agent: AgentKind, sessionId: string): void {
  const prefix = `${agent}::${sessionId}::`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
