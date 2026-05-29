import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execP = promisify(exec);

export interface LiveClaude {
  pid: number;
  args: string;
  cwd: string | null;
  /** Session id parsed out of `--resume <id>` if present in args, else null. */
  explicitSessionId: string | null;
}

interface CachedResult {
  fetchedAt: number;
  data: LiveClaude[];
}

let cache: CachedResult | null = null;
const CACHE_TTL_MS = 2500;

/**
 * Snapshot of all live `claude` processes on this machine. Cached briefly so
 * /sessions can call this for every entry without forking ps each time.
 */
export async function getLiveClaudes(): Promise<LiveClaude[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.data;

  const procs = await listClaudeProcesses();
  await Promise.all(
    procs.map(async (p) => {
      p.cwd = await getProcessCwd(p.pid);
    }),
  );
  cache = { fetchedAt: now, data: procs };
  return procs;
}

/**
 * Explicitly drop the in-memory `ps` snapshot. Called by the takeover route
 * after killing a desktop claude so the immediately-following user_message's
 * conflict-check doesn't see the dead pid still listed in the cache.
 *
 * Without this, a quick "send → takeover → send again" sequence trips a
 * false `session_busy` (the cache hasn't expired yet) and then a 409 on the
 * second takeover (the pid is really dead by then). See the screenshot in
 * the 2026-05-24 file-visibility chat thread for the user-visible bug.
 */
export function invalidateClaudeCache(): void {
  cache = null;
}

/**
 * Walk `pid`'s parent chain; return true if `ancestor` appears anywhere above
 * it. Used to recognize the bridge's OWN claude children (see below). The
 * `seen` guard + `cur > 1` bound make a malformed ps snapshot (cycles, missing
 * parents) terminate cleanly instead of looping.
 */
function isDescendantOf(pid: number, ancestor: number, parentOf: Map<number, number>): boolean {
  let cur = parentOf.get(pid);
  const seen = new Set<number>();
  while (cur !== undefined && cur > 1 && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = parentOf.get(cur);
  }
  return false;
}

async function listClaudeProcesses(): Promise<LiveClaude[]> {
  let stdout = '';
  try {
    ({ stdout } = await execP('ps -axo pid=,ppid=,command=', { timeout: 2000, maxBuffer: 4_000_000 }));
  } catch {
    return [];
  }
  const selfPid = process.pid;
  // Parent map across ALL processes (not just claude ones) so we can walk a
  // claude process's ancestry up to the bridge.
  const parentOf = new Map<number, number>();
  const candidates: LiveClaude[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const args = m[3] ?? '';
    parentOf.set(pid, ppid);
    if (pid === selfPid) continue;
    // Match the claude CLI's last path segment: `.../claude`, `claude`, or `node .../claude.js`.
    if (!/(?:^|\/)claude(?:\s|$)/.test(args) && !/claude-code/.test(args)) continue;
    // Ignore obvious non-claude lines (e.g., `grep claude`, our own `tsx ... claude.ts`).
    if (/\bgrep\b/.test(args)) continue;
    // Skip our own bridge subprocess (tsx running our server entry).
    if (/\btsx\b.*bridge\/src\/server/.test(args)) continue;
    const resumeMatch = args.match(/--resume(?:\s+|=)([0-9a-f-]{36})/i);
    candidates.push({
      pid,
      args,
      cwd: null,
      explicitSessionId: resumeMatch ? (resumeMatch[1] ?? null) : null,
    });
  }
  // Exclude the bridge's OWN claude children. The Agent SDK spawns the real
  // `claude` CLI as a subprocess (typically `--resume <id>`), which the
  // attribution heuristic would otherwise flag as a competing desktop session —
  // producing a bogus "take over ownership" prompt. Anything whose ancestry
  // leads back to this bridge process is ours; a genuine desktop claude is a
  // child of the user's shell, never of the bridge. (The old CLI driver
  // excluded these by tracked pid, but the SDK driver doesn't expose its
  // subprocess pid, so we identify them structurally instead.)
  return candidates.filter((c) => !isDescendantOf(c.pid, selfPid, parentOf));
}

export interface ProcessInfo {
  pid: number;
  command: string;
  args: string;
}

export async function inspectPid(pid: number): Promise<ProcessInfo | null> {
  try {
    const { stdout } = await execP(`ps -p ${pid} -o pid=,comm=,args=`, { timeout: 1000 });
    const line = stdout.trim();
    if (!line) return null;
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) return null;
    return { pid: Number(match[1]), command: match[2] ?? '', args: match[3] ?? '' };
  } catch {
    return null;
  }
}

export async function getProcessCwd(pid: number): Promise<string | null> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execP(`/usr/sbin/lsof -a -d cwd -p ${pid} -Fn`, { timeout: 1000 });
      const line = stdout.split('\n').find((l) => l.startsWith('n'));
      return line ? line.slice(1) : null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'linux') {
    try {
      const { readlink } = await import('node:fs/promises');
      return await readlink(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Resolve which claude PIDs are likely operating on a given session backing file.
 *
 * Heuristic:
 *  - Pass 1: anyone whose argv contains `--resume <thisSessionId>` is a definite match.
 *  - Pass 2: any claude process running with cwd == this session's cwd AND whose session
 *            is the most-recently-modified JSONL in that project dir.
 *
 * Excludes our own bridge subprocess PIDs (caller passes those in `ourPids`).
 */
export function attributeClaudePids(opts: {
  liveClaudes: LiveClaude[];
  sessionId: string;
  isMostRecentInProject: boolean;
  sessionCwd: string;
  ourPids: ReadonlySet<number>;
}): number[] {
  const matches = new Set<number>();
  for (const c of opts.liveClaudes) {
    if (opts.ourPids.has(c.pid)) continue;
    if (c.explicitSessionId === opts.sessionId) {
      matches.add(c.pid);
      continue;
    }
    if (!c.explicitSessionId && opts.isMostRecentInProject && c.cwd === opts.sessionCwd) {
      matches.add(c.pid);
    }
  }
  return [...matches];
}
