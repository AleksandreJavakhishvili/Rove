import type {
  AgentKind,
  ClientToServer,
  GitStatusResult,
  HistoryEntry,
  PreviewResponse,
  SearchHit,
  ServerToClient,
  SessionListItem,
  TreeEntry,
} from './types';

interface BridgeConfig {
  baseUrl: string;
  token?: string;
}

function authHeaders(cfg: BridgeConfig): Record<string, string> {
  return cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {};
}

function isMixedContentBlocked(url: string): boolean {
  // Browsers block any HTTP fetch from an HTTPS page (mixed active content)
  // with a generic network error. Detect the condition up front so we can
  // surface a useful message instead.
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  const pageProtocol = window.location?.protocol;
  if (pageProtocol !== 'https:') return false;
  return /^http:\/\//i.test(url);
}

async function fetchWithTimeout(url: string, opts: RequestInit, timeoutMs = 7000): Promise<Response> {
  if (isMixedContentBlocked(url)) {
    throw new Error(
      'Your browser blocked the connection: the bridge URL is HTTP but this page is HTTPS. ' +
        'Expose your bridge over HTTPS via `tailscale serve --bg --https=443 http://localhost:<port>` ' +
        'and use the resulting `https://<host>.<tailnet>.ts.net` URL. ' +
        'Full guide: github.com/aleksandrejavakhishvili/Rove/blob/main/docs/web-client-setup.md',
    );
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  console.log(`[bridge] → ${opts.method ?? 'GET'} ${url}`);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    console.log(`[bridge] ← ${res.status} ${url} (${Date.now() - started}ms)`);
    return res;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.log(`[bridge] ✕ ${url} (${Date.now() - started}ms): ${msg}`);
    if ((err as Error).name === 'AbortError') {
      throw new Error(`request timed out after ${timeoutMs}ms — phone cannot reach the bridge`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchHealth(cfg: BridgeConfig): Promise<{ ok: boolean; user?: string }> {
  const res = await fetchWithTimeout(`${cfg.baseUrl}/health`, { headers: authHeaders(cfg) });
  if (!res.ok) throw new Error(`/health → ${res.status}`);
  return res.json();
}

export async function fetchSessions(cfg: BridgeConfig): Promise<SessionListItem[]> {
  const res = await fetchWithTimeout(`${cfg.baseUrl}/sessions`, { headers: authHeaders(cfg) });
  if (!res.ok) throw new Error(`/sessions → ${res.status}`);
  const body = (await res.json()) as { sessions: SessionListItem[] };
  return body.sessions;
}

export interface HistoryPage {
  cwd: string;
  entries: HistoryEntry[];
  cursor: { before: string | null; hasMore: boolean };
}

export async function fetchHistory(
  cfg: BridgeConfig,
  agent: AgentKind,
  id: string,
  opts: { limit?: number; before?: string } = {},
): Promise<HistoryPage> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.before !== undefined) params.set('before', opts.before);
  const qs = params.toString();
  const url = `${cfg.baseUrl}/sessions/${encodeURIComponent(agent)}/${id}/history${qs ? `?${qs}` : ''}`;
  const res = await fetchWithTimeout(url, { headers: authHeaders(cfg) });
  if (!res.ok) throw new Error(`/history → ${res.status}`);
  return res.json();
}

export interface ScopedFile {
  path: string;
  rel: string;
  size: number;
  truncated: boolean;
  contents: string;
}

export async function fetchFile(
  cfg: BridgeConfig,
  agent: AgentKind,
  id: string,
  path: string,
): Promise<ScopedFile> {
  const url = `${cfg.baseUrl}/sessions/${encodeURIComponent(agent)}/${id}/file?path=${encodeURIComponent(path)}`;
  const res = await fetchWithTimeout(url, { headers: authHeaders(cfg) }, 15000);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`/file → ${res.status}: ${body}`);
  }
  return res.json();
}

export type DiffHunkLine =
  | { op: 'context'; text: string }
  | { op: 'add'; text: string }
  | { op: 'remove'; text: string };

export interface DiffHunk {
  header: string;
  lines: DiffHunkLine[];
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  added: number;
  removed: number;
  hunks: DiffHunk[];
  binary: boolean;
}

export interface SessionDiff {
  agent: AgentKind;
  id: string;
  cwd: string;
  baseline: string | null;
  files: DiffFile[];
}

export interface TreeListing {
  agent: AgentKind;
  id: string;
  cwd: string;
  /** Echoed `path` query the bridge resolved against (relative, POSIX). */
  root: string;
  entries: TreeEntry[];
  truncated: boolean;
}

export interface FetchTreeOpts {
  /** Subdirectory relative to cwd; defaults to the cwd itself. */
  path?: string;
  /** 1–4. Higher → more entries returned (flat list). */
  depth?: number;
  includeHidden?: boolean;
  includeIgnored?: boolean;
}

/**
 * GET /sessions/:agent/:id/tree — project file listing for the @-mention
 * picker (and, later, the Files tab project-tree section). Bridge-side
 * skips node_modules / .git / etc. and honors .gitignore.
 */
export async function fetchTree(
  cfg: BridgeConfig,
  agent: AgentKind,
  id: string,
  opts: FetchTreeOpts = {},
): Promise<TreeListing> {
  const qs = new URLSearchParams();
  if (opts.path) qs.set('path', opts.path);
  if (typeof opts.depth === 'number') qs.set('depth', String(opts.depth));
  if (opts.includeHidden) qs.set('includeHidden', 'true');
  if (opts.includeIgnored) qs.set('includeIgnored', 'true');
  const query = qs.toString();
  const url = `${cfg.baseUrl}/sessions/${encodeURIComponent(agent)}/${id}/tree${query ? `?${query}` : ''}`;
  const res = await fetchWithTimeout(url, { headers: authHeaders(cfg) }, 15000);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`/tree → ${res.status}: ${body}`);
  }
  return res.json();
}

export interface GitStatusResponse extends GitStatusResult {
  agent: AgentKind;
  id: string;
  cwd: string;
}

/**
 * GET /sessions/:agent/:id/git/status — full working-tree git status,
 * independent of the session's own baseline diff. Returns `isRepo: false`
 * (with empty fields) when the cwd isn't a git repo; the caller should
 * hide the section in that case rather than render an error.
 */
export async function fetchGitStatus(
  cfg: BridgeConfig,
  agent: AgentKind,
  id: string,
): Promise<GitStatusResponse> {
  const res = await fetchWithTimeout(
    `${cfg.baseUrl}/sessions/${encodeURIComponent(agent)}/${id}/git/status`,
    { headers: authHeaders(cfg) },
    15000,
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`/git/status → ${res.status}: ${body}`);
  }
  return res.json();
}

export interface GitDiffFileResponse {
  agent: AgentKind;
  id: string;
  cwd: string;
  path: string;
  staged: boolean;
  /** null when there's no diff for this file in the requested mode. */
  file: DiffFile | null;
}

/**
 * GET /sessions/:agent/:id/git/diff — per-file diff vs HEAD (default) or
 * vs index (`staged=true`). Different code path from `/diff?path=` which
 * is session-baseline-relative; this one is pure git working-tree state.
 */
export async function fetchGitDiffFile(
  cfg: BridgeConfig,
  agent: AgentKind,
  id: string,
  path: string,
  opts: { staged?: boolean } = {},
): Promise<GitDiffFileResponse> {
  const qs = new URLSearchParams({ path });
  if (opts.staged) qs.set('staged', 'true');
  const res = await fetchWithTimeout(
    `${cfg.baseUrl}/sessions/${encodeURIComponent(agent)}/${id}/git/diff?${qs.toString()}`,
    { headers: authHeaders(cfg) },
    15000,
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`/git/diff → ${res.status}: ${body}`);
  }
  return res.json();
}

export interface SearchResponse {
  agent: AgentKind;
  id: string;
  cwd: string;
  hits: SearchHit[];
  truncated: boolean;
  backend: 'ripgrep' | 'grep';
}

export interface FetchSearchOpts {
  /** 1–500. Defaults to 100 on the bridge side. */
  limit?: number;
  /** True → PCRE-lite regex (ripgrep) or BRE (grep fallback). */
  regex?: boolean;
}

/** GET /sessions/:agent/:id/search — file-contents search backed by ripgrep
 *  (preferred) or POSIX grep (fallback). Returns hits with line/column +
 *  a clipped preview snippet for the UI. */
export async function fetchSearch(
  cfg: BridgeConfig,
  agent: AgentKind,
  id: string,
  query: string,
  opts: FetchSearchOpts = {},
): Promise<SearchResponse> {
  const qs = new URLSearchParams({ q: query });
  if (typeof opts.limit === 'number') qs.set('limit', String(opts.limit));
  if (opts.regex) qs.set('regex', 'true');
  const res = await fetchWithTimeout(
    `${cfg.baseUrl}/sessions/${encodeURIComponent(agent)}/${id}/search?${qs.toString()}`,
    { headers: authHeaders(cfg) },
    20000,
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`/search → ${res.status}: ${body}`);
  }
  return res.json();
}

export async function fetchPreview(
  cfg: BridgeConfig,
  agent: AgentKind,
  id: string,
): Promise<PreviewResponse> {
  const res = await fetchWithTimeout(
    `${cfg.baseUrl}/sessions/${encodeURIComponent(agent)}/${id}/preview`,
    { headers: authHeaders(cfg) },
    5000,
  );
  if (!res.ok) throw new Error(`/preview → ${res.status}`);
  return res.json();
}

export interface FetchDiffOpts {
  /** When set, the response only contains the diff for this single file
   *  (relative POSIX path matching either newPath or oldPath). */
  path?: string;
}

export async function fetchDiff(
  cfg: BridgeConfig,
  agent: AgentKind,
  id: string,
  opts: FetchDiffOpts = {},
): Promise<SessionDiff> {
  const qs = new URLSearchParams();
  if (opts.path) qs.set('path', opts.path);
  const query = qs.toString();
  const url = `${cfg.baseUrl}/sessions/${encodeURIComponent(agent)}/${id}/diff${query ? `?${query}` : ''}`;
  const res = await fetchWithTimeout(url, { headers: authHeaders(cfg) }, 15000);
  if (!res.ok) throw new Error(`/diff → ${res.status}`);
  return res.json();
}

export interface TakeoverResult {
  ok: boolean;
  killed: number[];
  force?: boolean;
  note?: string;
  error?: string;
}

export interface SessionInfo {
  agent: AgentKind;
  id: string;
  cwd: string;
  projectName: string;
  label?: string;
  alive: boolean;
}

export async function fetchSessionInfo(
  cfg: BridgeConfig,
  agent: AgentKind,
  id: string,
): Promise<SessionInfo> {
  const res = await fetchWithTimeout(
    `${cfg.baseUrl}/sessions/${encodeURIComponent(agent)}/${id}`,
    { headers: authHeaders(cfg) },
  );
  if (!res.ok) throw new Error(`/sessions/:id → ${res.status}`);
  return res.json();
}

export async function renameSession(
  cfg: BridgeConfig,
  agent: AgentKind,
  id: string,
  label: string | null,
): Promise<{ ok: boolean; meta: { label?: string } }> {
  const res = await fetchWithTimeout(
    `${cfg.baseUrl}/sessions/${encodeURIComponent(agent)}/${id}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders(cfg) },
      body: JSON.stringify({ label }),
    },
    7000,
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PATCH /sessions → ${res.status}: ${body}`);
  }
  return res.json();
}

export async function takeOwnership(
  cfg: BridgeConfig,
  agent: AgentKind,
  id: string,
): Promise<TakeoverResult> {
  const res = await fetchWithTimeout(
    `${cfg.baseUrl}/sessions/${encodeURIComponent(agent)}/${id}/takeover`,
    { method: 'POST', headers: authHeaders(cfg) },
    10000,
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`/takeover → ${res.status}: ${body}`);
  }
  return res.json();
}

/** Fork a session via the bridge. Returns the new session ID. */
export async function forkSession(
  cfg: BridgeConfig,
  agent: AgentKind,
  id: string,
  opts?: { atMessage?: string },
): Promise<{ ok: true; sessionId: string }> {
  const res = await fetchWithTimeout(
    `${cfg.baseUrl}/sessions/${encodeURIComponent(agent)}/${id}/fork`,
    {
      method: 'POST',
      headers: { ...authHeaders(cfg), 'content-type': 'application/json' },
      body: JSON.stringify(opts ?? {}),
    },
    15000,
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`/fork → ${res.status}: ${body}`);
  }
  return res.json();
}

export type ConnectionState = 'connecting' | 'open' | 'closing' | 'closed' | 'error';

export interface StreamHandle {
  send(msg: ClientToServer): void;
  close(): void;
  state(): ConnectionState;
}

export interface StreamHandlers {
  onMessage: (msg: ServerToClient) => void;
  onStateChange?: (state: ConnectionState, info?: { code?: number; reason?: string }) => void;
}

export function openStream(
  cfg: BridgeConfig,
  agent: AgentKind,
  id: string,
  handlers: StreamHandlers,
): StreamHandle {
  const wsUrl = cfg.baseUrl
    .replace(/^http(s?)/i, 'ws$1')
    .replace(/\/+$/, '');
  const tokenParam = cfg.token ? `?token=${encodeURIComponent(cfg.token)}` : '';
  const fullUrl = `${wsUrl}/sessions/${encodeURIComponent(agent)}/${id}/stream${tokenParam}`;
  console.log(`[bridge ws] → ${fullUrl}`);
  let socket: WebSocket | null = new WebSocket(fullUrl);
  let state: ConnectionState = 'connecting';

  const setState = (s: ConnectionState, info?: { code?: number; reason?: string }) => {
    state = s;
    console.log(`[bridge ws] state=${s}${info?.code ? ` code=${info.code}` : ''}${info?.reason ? ` reason=${info.reason}` : ''}`);
    handlers.onStateChange?.(s, info);
  };

  socket.onopen = () => setState('open');
  let msgCount = 0;
  socket.onmessage = (evt) => {
    try {
      const msg = JSON.parse(typeof evt.data === 'string' ? evt.data : '') as ServerToClient;
      msgCount += 1;
      if (msgCount <= 30) {
        const inner = (msg as any).event?.type;
        console.log(`[bridge ws] ← #${msgCount} ${msg.type}${inner ? '/' + inner : ''}`);
      }
      handlers.onMessage(msg);
    } catch (err) {
      console.warn('[bridge ws] invalid frame', err);
    }
  };
  socket.onclose = (evt) => setState('closed', { code: evt.code, reason: evt.reason });
  socket.onerror = (evt) => {
    console.log(`[bridge ws] error event`, (evt as any)?.message ?? evt);
    setState('error');
  };

  return {
    send(msg) {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error('stream not open');
      }
      socket.send(JSON.stringify(msg));
    },
    close() {
      if (socket) {
        setState('closing');
        try {
          socket.close();
        } catch {
          // ignore
        }
        socket = null;
      }
    },
    state: () => state,
  };
}

export interface PendingPermissionSnapshot {
  agent: AgentKind;
  sessionId: string;
  toolUseId: string;
  tool: string;
  input: unknown;
  cwd: string | null;
  createdAt: number;
}

export type PermissionEvent =
  | { type: 'permissions_snapshot'; pending: PendingPermissionSnapshot[] }
  | { type: 'permission_added'; pending: PendingPermissionSnapshot }
  | {
      type: 'permission_resolved';
      agent: AgentKind;
      sessionId: string;
      toolUseId: string;
      decision: 'allow' | 'allow_always' | 'deny' | 'timeout';
    };

export async function fetchPendingPermissions(
  cfg: BridgeConfig,
): Promise<PendingPermissionSnapshot[]> {
  const res = await fetch(`${cfg.baseUrl}/permissions/pending`, {
    headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : undefined,
  });
  if (!res.ok) throw new Error(`fetchPendingPermissions: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { pending: PendingPermissionSnapshot[] };
  return j.pending;
}

/**
 * Subscribes to bridge-wide events (currently: permission added / resolved
 * across all sessions). The sessions list uses this to badge rows with pending
 * approvals without having to open one WS per session.
 */
export function openEventsStream(
  cfg: BridgeConfig,
  onMessage: (msg: PermissionEvent) => void,
): { close(): void } {
  const wsUrl = cfg.baseUrl.replace(/^http(s?)/i, 'ws$1').replace(/\/+$/, '');
  const tokenParam = cfg.token ? `?token=${encodeURIComponent(cfg.token)}` : '';
  const fullUrl = `${wsUrl}/events${tokenParam}`;
  let socket: WebSocket | null = new WebSocket(fullUrl);
  socket.onmessage = (evt) => {
    try {
      const msg = JSON.parse(typeof evt.data === 'string' ? evt.data : '') as PermissionEvent;
      onMessage(msg);
    } catch (err) {
      console.warn('[bridge events] invalid frame', err);
    }
  };
  socket.onerror = (evt) => {
    console.log('[bridge events] error', (evt as any)?.message ?? evt);
  };
  return {
    close() {
      if (socket) {
        try {
          socket.close();
        } catch {
          // ignore
        }
        socket = null;
      }
    },
  };
}

/**
 * One-shot helper: open the per-session WS just long enough to deliver an
 * approval decision, then close. Used by the sessions list so a decision can be
 * applied without navigating into the chat.
 */
export function sendApproval(
  cfg: BridgeConfig,
  agent: AgentKind,
  sessionId: string,
  toolUseId: string,
  decision: 'allow' | 'allow_always' | 'deny',
): Promise<void> {
  return new Promise((resolve, reject) => {
    const handle = openStream(cfg, agent, sessionId, {
      onMessage: () => undefined,
      onStateChange: (state) => {
        if (state === 'open') {
          try {
            handle.send({ type: 'approval', toolUseId, decision });
            // Give the bridge a moment to forward, then close.
            setTimeout(() => {
              handle.close();
              resolve();
            }, 50);
          } catch (err) {
            handle.close();
            reject(err as Error);
          }
        } else if (state === 'error' || state === 'closed') {
          // Only reject if we never reached `open`.
        }
      },
    });
    setTimeout(() => {
      handle.close();
      reject(new Error('approval send timed out'));
    }, 5_000);
  });
}
