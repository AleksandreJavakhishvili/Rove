import type {
  AgentKind,
  ClientToServer,
  HistoryEntry,
  PreviewResponse,
  ServerToClient,
  SessionListItem,
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

export async function fetchDiff(
  cfg: BridgeConfig,
  agent: AgentKind,
  id: string,
): Promise<SessionDiff> {
  const res = await fetchWithTimeout(
    `${cfg.baseUrl}/sessions/${encodeURIComponent(agent)}/${id}/diff`,
    { headers: authHeaders(cfg) },
    15000,
  );
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
