import { exec } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { getProcessCwd } from './lsof.ts';

const execP = promisify(exec);

export interface DevServerCandidate {
  port: number;
  pid: number;
  /** "127.0.0.1" | "0.0.0.0" | "::" | specific IP */
  bindAddress: string;
  framework: string | null;
  /** Process command line (possibly truncated to 200 chars). */
  command: string;
  /** False when the server is bound to loopback only. */
  reachable: boolean;
  /** http://hostname:port, or null when !reachable. */
  url: string | null;
  /** Optional hint, e.g., framework-specific instructions to rebind. */
  note?: string;
}

interface ListeningPort {
  pid: number;
  port: number;
  bindAddress: string;
  /** Short command name from lsof / ss (e.g., "node"). */
  shortCommand: string;
}

const CACHE_TTL_MS = 2500;
let listingCache: { fetchedAt: number; data: ListeningPort[] } | null = null;

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Find dev servers running in (or under) the given session cwd.
 *
 * Discovery strategy:
 *   1. Snapshot all listening TCP ports + owning PIDs.
 *   2. For each unique PID, look up its cwd.
 *   3. Keep PIDs whose cwd is inside sessionCwd (path containment).
 *   4. Fetch the full process args for each match (for the framework heuristic).
 *   5. Build candidate records, sort framework-labeled first.
 */
export async function scanDevServers(opts: {
  sessionCwd: string;
  hostname: string;
}): Promise<DevServerCandidate[]> {
  const sessionCwdAbs = resolve(opts.sessionCwd);
  const ports = await listListeningPorts();
  if (ports.length === 0) return [];

  // Resolve cwd per unique pid (parallel).
  const uniquePids = [...new Set(ports.map((p) => p.pid))];
  const cwdByPid = new Map<number, string | null>();
  await Promise.all(
    uniquePids.map(async (pid) => {
      cwdByPid.set(pid, await getProcessCwd(pid));
    }),
  );

  // Filter to ports whose owner sits inside the session cwd.
  const matched = ports.filter((p) => {
    const cwd = cwdByPid.get(p.pid);
    return cwd != null && isInside(cwd, sessionCwdAbs);
  });
  if (matched.length === 0) return [];

  // Batch-fetch full argv for the matched PIDs (one ps call).
  const argsByPid = await getProcessArgsBatch([...new Set(matched.map((m) => m.pid))]);

  const candidates: DevServerCandidate[] = matched.map((p) => {
    const fullCommand = argsByPid.get(p.pid) ?? p.shortCommand;
    const framework = frameworkLabel(fullCommand);
    const reachable = !LOOPBACK_ADDRS.has(p.bindAddress);
    return {
      port: p.port,
      pid: p.pid,
      bindAddress: p.bindAddress,
      framework,
      command: fullCommand.slice(0, 200),
      reachable,
      url: reachable ? `http://${opts.hostname}:${p.port}` : null,
      ...(reachable ? {} : { note: localhostNote(framework) }),
    };
  });

  // Stable order: framework-labeled (likely user-visible servers) first,
  // then by port ascending.
  candidates.sort((a, b) => {
    const af = a.framework ? 0 : 1;
    const bf = b.framework ? 0 : 1;
    if (af !== bf) return af - bf;
    return a.port - b.port;
  });
  return candidates;
}

function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  // Trailing separator on parent prevents prefix collisions like
  // `/Users/ako/app2` being considered inside `/Users/ako/app`.
  return c === parent || c.startsWith(parent + sep);
}

function frameworkLabel(cmd: string): string | null {
  if (/\bvite\b/.test(cmd)) return 'vite';
  if (/next-server|\bnext\b.*\bdev\b/.test(cmd)) return 'next';
  if (/\bastro\b.*\bdev\b/.test(cmd)) return 'astro';
  if (/webpack-dev-server/.test(cmd)) return 'webpack';
  if (/\bparcel\b.*\bserve\b/.test(cmd)) return 'parcel';
  if (/\bbun\b.*--hot/.test(cmd)) return 'bun';
  if (/^\s*\S*\/?node\b/.test(cmd)) return 'node';
  return null;
}

function localhostNote(framework: string | null): string {
  switch (framework) {
    case 'vite':
      return 'Bound to localhost. Restart with `vite --host`, or set `server.host: true` in vite.config.';
    case 'next':
      return 'Bound to localhost. Restart with `next dev -H 0.0.0.0`.';
    case 'astro':
      return 'Bound to localhost. Restart with `astro dev --host`.';
    case 'webpack':
      return 'Bound to localhost. Pass `--host 0.0.0.0` to webpack-dev-server.';
    default:
      return 'Bound to localhost — re-bind to 0.0.0.0 to reach from your phone.';
  }
}

async function listListeningPorts(): Promise<ListeningPort[]> {
  const now = Date.now();
  if (listingCache && now - listingCache.fetchedAt < CACHE_TTL_MS) return listingCache.data;
  let data: ListeningPort[] = [];
  try {
    if (process.platform === 'darwin') data = await listLsof();
    else if (process.platform === 'linux') data = await listSs();
  } catch {
    data = [];
  }
  listingCache = { fetchedAt: now, data };
  return data;
}

/** macOS: parse `lsof -F` line-oriented output. */
async function listLsof(): Promise<ListeningPort[]> {
  const { stdout } = await execP('/usr/sbin/lsof -iTCP -sTCP:LISTEN -P -n -Fpcn', {
    timeout: 3000,
    maxBuffer: 4_000_000,
  });
  const out: ListeningPort[] = [];
  let pid = 0;
  let shortCommand = '';
  for (const rawLine of stdout.split('\n')) {
    if (!rawLine) continue;
    const tag = rawLine[0];
    const rest = rawLine.slice(1);
    if (tag === 'p') {
      pid = Number(rest) || 0;
      shortCommand = '';
    } else if (tag === 'c') {
      shortCommand = rest;
    } else if (tag === 'n' && pid > 0) {
      const parsed = parseAddrPort(rest);
      if (parsed) {
        out.push({ pid, port: parsed.port, bindAddress: parsed.bindAddress, shortCommand });
      }
    }
  }
  return out;
}

/** Linux: parse `ss -tlnpH` rows. */
async function listSs(): Promise<ListeningPort[]> {
  const { stdout } = await execP('ss -tlnpH', { timeout: 3000, maxBuffer: 4_000_000 });
  const out: ListeningPort[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    // Columns: State Recv-Q Send-Q Local-Address:Port Peer-Address:Port [users:...]
    const cols = line.split(/\s+/);
    if (cols[0] !== 'LISTEN') continue;
    const local = cols[3];
    if (!local) continue;
    const parsed = parseAddrPort(local);
    if (!parsed) continue;
    const usersIdx = cols.findIndex((c) => c.startsWith('users:'));
    if (usersIdx === -1) continue;
    const usersBlock = cols.slice(usersIdx).join(' ');
    const userMatch = usersBlock.match(/"([^"]+)",pid=(\d+)/);
    if (!userMatch) continue;
    const shortCommand = userMatch[1] ?? '';
    const pid = Number(userMatch[2]);
    if (!pid) continue;
    out.push({ pid, port: parsed.port, bindAddress: parsed.bindAddress, shortCommand });
  }
  return out;
}

function parseAddrPort(s: string): { port: number; bindAddress: string } | null {
  const t = s.replace(/\s*\(LISTEN\)\s*$/, '').trim();
  if (!t) return null;
  // IPv6 bracket form: [::]:5173, [::1]:5173, [fe80::1]:5173
  const v6 = t.match(/^\[([^\]]+)\]:(\d+)$/);
  if (v6) return { bindAddress: v6[1] ?? '', port: Number(v6[2]) };
  // IPv4 or wildcard: 0.0.0.0:3000, *:3000, 127.0.0.1:3000
  const v4 = t.match(/^([^:]+):(\d+)$/);
  if (v4) {
    let addr = v4[1] ?? '';
    if (addr === '*') addr = '0.0.0.0';
    return { bindAddress: addr, port: Number(v4[2]) };
  }
  return null;
}

async function getProcessArgsBatch(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (pids.length === 0) return out;
  try {
    const list = pids.join(',');
    const { stdout } = await execP(`ps -p ${list} -o pid=,args=`, { timeout: 1500 });
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!m) continue;
      out.set(Number(m[1]), (m[2] ?? '').trim());
    }
  } catch {
    // best-effort
  }
  return out;
}
