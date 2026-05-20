import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { randomBytes } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { WSContext } from 'hono/ws';
import { z } from 'zod';
import { authMiddleware } from './auth.ts';
import { config, runtimeState } from './config.ts';
import { getDriver, listAgents, listAllSessions } from './agents/registry.ts';
import { devices } from './devices.ts';
import { scanDevServers } from './devServers.ts';
import { entryFromRaw } from './agents/claudeCode.ts';
import { readScopedFile, relToCwd } from './files.ts';
import { JsonlTail } from './jsonlTail.ts';
import { getDiff } from './git.ts';
import { inspectPid } from './lsof.ts';
import { permissions } from './permissions.ts';
import { preflight } from './preflight.ts';
import { printConnectionQR } from './qr.ts';
import { runtime } from './runtime.ts';
import { sessionMeta } from './sessionMeta.ts';
import { saveUpload } from './uploads.ts';
import { getTailscaleCert, getTailscaleInfo, isTailscaleServeRunning } from './tailscale.ts';
import { watchers, type FileChange } from './watcher.ts';
import type { AgentEvent, AgentKind } from './agents/types.ts';
import type { ClientToServer, ServerToClient, SessionListItem } from './types.ts';

const app = new Hono<{ Variables: { auth: { user: string; source: string } } }>();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.use('*', cors({ origin: '*', allowHeaders: ['Authorization', 'Tailscale-User-Login', 'Content-Type', 'X-Bridge-Internal-Token'] }));

// Internal endpoint: the MCP permission-prompt server (spawned by claude) calls
// this to ask the phone. We bypass the normal auth middleware here because the
// MCP server presents its own one-time internal token.
app.post('/internal/permission', async (c) => {
  const tok = c.req.header('x-bridge-internal-token');
  if (!permissions.isInternalAuth(tok)) {
    return c.json({ behavior: 'deny', message: 'unauthorized' }, 401);
  }
  let body: { agent?: string; sessionId?: string; toolUseId?: string; tool?: string; input?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ behavior: 'deny', message: 'bad json' }, 400);
  }
  const { agent, sessionId, toolUseId, tool, input } = body;
  if (!agent || !sessionId || !tool) {
    return c.json({ behavior: 'deny', message: 'missing fields' }, 400);
  }
  console.log(`[bridge] permission_prompt for ${agent}/${sessionId.slice(0, 8)} tool=${tool}`);
  // Forward to the WS subscribers.
  const session = runtime.get(agent, sessionId);
  if (session) {
    session.emit('event', {
      type: 'permission_request',
      toolUseId: toolUseId ?? '',
      tool,
      input,
    });
  }
  try {
    const decision = await permissions.await(
      agent,
      sessionId,
      { toolUseId: toolUseId ?? '', tool, input },
      session?.cwd ?? null,
    );
    console.log(`[bridge] permission decision: ${decision.behavior}`);
    return c.json(decision);
  } catch (err) {
    console.error(`[bridge] permission await failed:`, err);
    return c.json({ behavior: 'deny', message: (err as Error).message });
  }
});

app.use('*', authMiddleware);

app.get('/health', (c) =>
  c.json({ ok: true, user: c.get('auth').user, host: config.host, port: config.port }),
);

app.get('/agents', async (c) => c.json({ agents: await listAgents() }));

// Push-notification device registry. The mobile app POSTs its Expo push token
// here so the bridge can wake it up when a turn finishes off-screen.
app.post('/devices', async (c) => {
  let body: { token?: string; label?: string; platform?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad json' }, 400);
  }
  if (!body.token || typeof body.token !== 'string') {
    return c.json({ error: 'missing token' }, 400);
  }
  await devices.register(body.token, { label: body.label, platform: body.platform });
  console.log(`[devices] registered ${body.token.slice(0, 24)}…`);
  return c.json({ ok: true });
});

app.delete('/devices', async (c) => {
  let body: { token?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad json' }, 400);
  }
  if (!body.token) return c.json({ error: 'missing token' }, 400);
  const removed = await devices.unregister(body.token);
  return c.json({ ok: true, removed });
});

app.get('/devices', async (c) => c.json({ devices: await devices.list() }));

app.get('/permissions/pending', (c) => c.json({ pending: permissions.list() }));

app.get('/sessions', async (c) => {
  const ourPids = runtime.livePids();
  const raw = await listAllSessions();
  const metas = await sessionMeta.getMany(raw.map((s) => ({ agent: s.agent, id: s.id })));
  const sessions: SessionListItem[] = raw.map((s) => {
    const bridgePid = ourPids.get(`${s.agent}::${s.id}`);
    const foreignPids = s.desktopPids.filter((p) => p !== bridgePid && p !== process.pid);
    const status: SessionListItem['status'] =
      bridgePid !== undefined ? 'live-bridge' : foreignPids.length > 0 ? 'live-desktop' : 'idle';
    const meta = metas.get(`${s.agent}::${s.id}`);
    return {
      agent: s.agent,
      id: s.id,
      cwd: s.cwd,
      projectName: s.projectName,
      ...(meta?.label ? { label: meta.label } : {}),
      lastModified: s.lastModified,
      preview: s.preview,
      sizeBytes: s.sizeBytes,
      status,
      desktopPids: foreignPids,
      ...(bridgePid !== undefined ? { bridgePid } : {}),
    };
  });
  return c.json({ sessions });
});

// Single-session info (label + cwd + status). Used by the mobile chat header.
app.get('/sessions/:agent/:id', async (c) => {
  const agent = c.req.param('agent') as AgentKind;
  const id = c.req.param('id') ?? '';
  const driver = getDriver(agent);
  if (!driver) return c.json({ error: 'unknown agent' }, 404);
  const located = await driver.findSession(id);
  if (!located) return c.json({ error: 'session not found' }, 404);
  const meta = await sessionMeta.get(agent, id);
  const session = runtime.get(agent, id);
  return c.json({
    agent,
    id,
    cwd: located.cwd,
    projectName: located.cwd.split('/').filter(Boolean).pop() ?? located.cwd,
    label: meta?.label,
    alive: session?.alive ?? false,
  });
});

// Update a session's user-set metadata (currently just `label`).
app.patch('/sessions/:agent/:id', async (c) => {
  const agent = c.req.param('agent') as AgentKind;
  const id = c.req.param('id') ?? '';
  let body: { label?: string | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad json' }, 400);
  }
  if (body.label !== undefined) {
    await sessionMeta.setLabel(agent, id, body.label === null ? null : String(body.label));
  }
  const meta = await sessionMeta.get(agent, id);
  return c.json({ ok: true, meta: meta ?? {} });
});

app.get('/sessions/:agent/:id/history', async (c) => {
  const agent = c.req.param('agent') as AgentKind;
  const id = c.req.param('id') ?? '';
  const driver = getDriver(agent);
  if (!driver) return c.json({ error: 'unknown agent' }, 404);
  const located = await driver.findSession(id);
  if (!located) return c.json({ error: 'session not found' }, 404);
  const limitParam = Number(c.req.query('limit') ?? '100');
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 100;
  const before = c.req.query('before') ?? undefined;
  const entries = await driver.readHistory(id, { limit, before });
  // entries are oldest-first (chronological); the oldest is at index 0.
  const oldest = entries.length > 0 ? entries[0]!.timestamp : null;
  return c.json({
    agent,
    id,
    cwd: located.cwd,
    entries,
    cursor: { before: oldest, hasMore: entries.length === limit },
  });
});

app.post('/sessions/:agent/:id/interrupt', (c) => {
  const agent = c.req.param('agent') as AgentKind;
  const id = c.req.param('id') ?? '';
  const session = runtime.get(agent, id);
  if (!session || !session.alive) return c.json({ error: 'not running' }, 409);
  const ok = session.interrupt();
  return c.json({ ok });
});

/**
 * Take ownership of a session that's currently owned by a desktop `claude`.
 * Verifies the foreign PIDs are claude processes, sends SIGTERM, polls for
 * exit, escalates to SIGKILL on timeout. Returns the list of killed PIDs.
 */
app.post('/sessions/:agent/:id/takeover', async (c) => {
  const agent = c.req.param('agent') as AgentKind;
  const id = c.req.param('id') ?? '';
  const driver = getDriver(agent);
  if (!driver) return c.json({ error: 'unknown agent' }, 404);
  const located = await driver.findSession(id);
  if (!located) return c.json({ error: 'session not found' }, 404);

  const foreign = await runtime.checkDesktopConflict(agent, id);
  if (!foreign || foreign.length === 0) {
    return c.json({ ok: true, killed: [], note: 'no conflict' });
  }

  // Safety: only kill PIDs whose command line actually looks like claude.
  const verified: number[] = [];
  for (const pid of foreign) {
    const info = await inspectPid(pid);
    if (info && /(?:^|\/)claude(?:\s|$)|claude-code/.test(info.command + ' ' + info.args)) {
      verified.push(pid);
    }
  }
  if (verified.length === 0) {
    return c.json({ ok: false, error: 'no matching claude processes for those pids' }, 409);
  }

  console.log(`[bridge] takeover requested — SIGTERM ${verified.join(',')}`);
  for (const pid of verified) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already dead — that's fine
    }
  }

  // Poll up to 5s for clean exit.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const stillAlive = verified.filter((pid) => {
      try {
        process.kill(pid, 0); // signal 0 = existence check
        return true;
      } catch {
        return false;
      }
    });
    if (stillAlive.length === 0) {
      console.log(`[bridge] takeover complete — all pids exited cleanly`);
      return c.json({ ok: true, killed: verified, force: false });
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // Escalate.
  console.log(`[bridge] takeover escalating to SIGKILL`);
  for (const pid of verified) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }
  return c.json({ ok: true, killed: verified, force: true });
});

// Upload a file from the phone. Saved under <cwd>/.rove/uploads/<ts>-<name>.
// Accepts either multipart/form-data with field "file" or JSON
// {fileName, mimeType, dataBase64}. The mobile app uses JSON because RN's
// FormData multipart is finicky.
app.post('/sessions/:agent/:id/upload', async (c) => {
  const agent = c.req.param('agent') as AgentKind;
  const id = c.req.param('id') ?? '';
  const driver = getDriver(agent);
  if (!driver) return c.json({ error: 'unknown agent' }, 404);
  const located = await driver.findSession(id);
  if (!located) return c.json({ error: 'session not found' }, 404);

  const ct = c.req.header('content-type') ?? '';
  let fileName: string;
  let mimeType: string | undefined;
  let data: Uint8Array | Buffer;

  try {
    if (ct.startsWith('application/json')) {
      const body = (await c.req.json()) as {
        fileName?: string;
        mimeType?: string;
        dataBase64?: string;
      };
      if (!body.fileName || typeof body.dataBase64 !== 'string') {
        return c.json({ error: 'missing fileName or dataBase64' }, 400);
      }
      fileName = body.fileName;
      mimeType = body.mimeType;
      data = Buffer.from(body.dataBase64, 'base64');
    } else if (ct.startsWith('multipart/form-data')) {
      const form = await c.req.parseBody();
      const f = form.file;
      if (!(f instanceof File)) return c.json({ error: 'missing file field' }, 400);
      fileName = f.name;
      mimeType = f.type;
      data = new Uint8Array(await f.arrayBuffer());
    } else {
      return c.json({ error: `unsupported content-type: ${ct}` }, 415);
    }
  } catch (err) {
    return c.json({ error: `bad body: ${(err as Error).message}` }, 400);
  }

  try {
    const saved = await saveUpload({ cwd: located.cwd, fileName, mimeType, data });
    console.log(
      `[upload] agent=${agent} id=${id.slice(0, 8)} file=${saved.relPath} bytes=${saved.sizeBytes}`,
    );
    return c.json({
      ok: true,
      path: saved.absPath,
      rel: saved.relPath,
      sizeBytes: saved.sizeBytes,
      isImage: saved.isImage,
      mimeType: saved.mimeType,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.get('/sessions/:agent/:id/file', async (c) => {
  const agent = c.req.param('agent') as AgentKind;
  const id = c.req.param('id') ?? '';
  const path = c.req.query('path');
  if (!path) return c.json({ error: 'missing path query' }, 400);
  const driver = getDriver(agent);
  if (!driver) return c.json({ error: 'unknown agent' }, 404);
  const located = await driver.findSession(id);
  if (!located) return c.json({ error: 'session not found' }, 404);
  try {
    const file = await readScopedFile(located.cwd, path);
    return c.json({
      path: file.path,
      rel: relToCwd(located.cwd, file.path),
      size: file.size,
      truncated: file.truncated,
      contents: file.contents,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// Auto-detected dev servers running inside this session's cwd. The mobile app
// polls this while the chat is open to render a per-session preview pane.
//
// Hostname strategy: use whatever the phone used to reach us. This lets the
// WebView open `http://<same-host>:<dev-port>` without us having to know
// whether the phone is on the tailnet, the LAN, or talking through
// `tailscale serve`.
app.get('/sessions/:agent/:id/preview', async (c) => {
  const agent = c.req.param('agent') as AgentKind;
  const id = c.req.param('id') ?? '';
  const driver = getDriver(agent);
  if (!driver) return c.json({ error: 'unknown agent' }, 404);
  const located = await driver.findSession(id);
  if (!located) return c.json({ error: 'session not found' }, 404);
  const reqUrl = new URL(c.req.url);
  const hostname = reqUrl.hostname;
  const candidates = await scanDevServers({ sessionCwd: located.cwd, hostname });
  return c.json({ hostname, candidates });
});

app.get('/sessions/:agent/:id/diff', async (c) => {
  const agent = c.req.param('agent') as AgentKind;
  const id = c.req.param('id') ?? '';
  const driver = getDriver(agent);
  if (!driver) return c.json({ error: 'unknown agent' }, 404);
  const located = await driver.findSession(id);
  if (!located) return c.json({ error: 'session not found' }, 404);
  const session = runtime.get(agent, id);
  const baseline = session?.baselineSha ?? null;
  const diff = await getDiff(located.cwd, baseline);
  return c.json({
    agent,
    id,
    cwd: located.cwd,
    baseline: diff.baseline,
    files: diff.files,
  });
});

const clientSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user_message'), content: z.string().min(1) }),
  z.object({
    type: z.literal('approval'),
    toolUseId: z.string(),
    decision: z.enum(['allow', 'allow_always', 'deny']),
  }),
  z.object({ type: z.literal('interrupt') }),
  z.object({ type: z.literal('ping') }),
  z.object({
    type: z.literal('set_mode'),
    mode: z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']),
  }),
]);

app.get(
  '/sessions/:agent/:id/stream',
  upgradeWebSocket(async (c) => {
    const agent = (c.req.param('agent') ?? 'claude-code') as AgentKind;
    const id = c.req.param('id') ?? '';

    let session: Awaited<ReturnType<typeof runtime.getOrCreate>> | null = null;
    let onEvent: ((e: AgentEvent) => void) | null = null;
    let onExit: ((info: { code: number | null; signal: NodeJS.Signals | null }) => void) | null = null;
    let watcherEmitter: ReturnType<typeof watchers.acquire> | null = null;
    let onWatcherChange: ((info: FileChange) => void) | null = null;
    let watchedCwd: string | null = null;
    let jsonlTail: JsonlTail | null = null;

    const attach = async (ws: WSContext) => {
      session = await runtime.getOrCreate(agent, id);
      session.subscribers += 1;
      send(ws, { type: 'status', status: session.alive ? 'live-bridge' : 'idle', pid: session.pid });
      // Tell the new subscriber what permission mode the session is in. The
      // bridge is the source of truth; the mobile client just mirrors this.
      send(ws, { type: 'event', event: { type: 'permission_mode', mode: session.permissionMode } });
      let eventCount = 0;
      onEvent = (e: AgentEvent) => {
        eventCount += 1;
        if (eventCount <= 30) console.log(`[bridge ws] → event #${eventCount} type=${e.type}`);
        // If the bridge is producing events, the desktop isn't writing — stop
        // any JSONL tail to avoid duplicate rendering.
        if (jsonlTail) {
          jsonlTail.stop();
          jsonlTail = null;
          console.log(`[bridge] jsonl-tail stopped (bridge took over)`);
        }
        send(ws, { type: 'event', event: e });
      };
      onExit = (info) => send(ws, { type: 'process_exit', code: info.code, signal: info.signal });
      session.on('event', onEvent);
      session.on('exit', onExit);
      // Start a file watcher rooted at the session's cwd. Shared across sessions
      // that point at the same cwd.
      watchedCwd = session.cwd;
      watcherEmitter = watchers.acquire(session.cwd);
      onWatcherChange = (info) => send(ws, { type: 'file_changed', path: info.rel || info.path, op: info.op });
      watcherEmitter.on('change', onWatcherChange);
    };

    return {
      onOpen: async (_evt, ws) => {
        try {
          const driver = getDriver(agent);
          if (!driver) {
            send(ws, { type: 'error', message: `unknown agent: ${agent}` });
            ws.close(1008, 'unknown agent');
            return;
          }
          const entries = await driver.readHistory(id, { limit: config.historyMaxEntries });
          console.log(
            `[bridge] history replay for ${agent}/${id.slice(0, 8)}: ${entries.length} entries`,
          );
          send(ws, { type: 'history_replay_start' });
          for (const entry of entries) send(ws, { type: 'history_entry', entry });
          send(ws, { type: 'history_replay_end' });
          await attach(ws);

          // If the desktop owns the session right now, tail its JSONL so the
          // phone sees the desktop user's new turns in real time. Stops as soon
          // as the bridge spawns its own claude (see onEvent) or the socket
          // closes. Only meaningful for claude-code (the other drivers don't
          // have a JSONL on disk yet).
          if (agent === 'claude-code' && !session?.alive) {
            const foreign = await runtime.checkDesktopConflict(agent, id);
            const located = await driver.findSession(id);
            if (foreign && foreign.length > 0 && located?.path) {
              console.log(
                `[bridge] starting jsonl-tail for ${id.slice(0, 8)} (desktop pids: ${foreign.join(',')})`,
              );
              jsonlTail = new JsonlTail({
                path: located.path,
                onLine: (line) => {
                  let obj: unknown;
                  try {
                    obj = JSON.parse(line);
                  } catch {
                    return;
                  }
                  const parsed = entryFromRaw(obj);
                  if (!parsed) return;
                  for (const entry of parsed) {
                    send(ws, { type: 'history_entry', entry });
                  }
                },
                onError: (err) => console.log(`[bridge] jsonl-tail error: ${err.message}`),
              });
              await jsonlTail.start();
            }
          }
        } catch (err) {
          send(ws, { type: 'error', message: (err as Error).message });
          ws.close(1011, 'init failed');
        }
      },
      onMessage: async (evt, ws) => {
        let parsed: ClientToServer;
        try {
          const raw = typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data as ArrayBuffer);
          parsed = clientSchema.parse(JSON.parse(raw));
        } catch (err) {
          send(ws, { type: 'error', message: `invalid message: ${(err as Error).message}` });
          return;
        }
        if (!session) return;
        try {
          switch (parsed.type) {
            case 'user_message': {
              console.log(`[bridge] user_message agent=${agent} id=${id.slice(0, 8)} alive=${session.alive}`);
              if (!session.alive) {
                const foreign = await runtime.checkDesktopConflict(agent, id);
                if (foreign) {
                  console.log(`[bridge] session_busy — desktop pids: ${foreign.join(', ')}`);
                  send(ws, { type: 'session_busy', pids: foreign, source: 'desktop' });
                  break;
                }
                console.log(`[bridge] spawning claude subprocess for ${agent}/${id.slice(0, 8)} in ${session.cwd}`);
              }
              try {
                session.sendUserMessage(parsed.content!);
                console.log(`[bridge] forwarded user_message to subprocess pid=${session.pid}`);
              } catch (sendErr) {
                console.error(`[bridge] sendUserMessage failed:`, sendErr);
                throw sendErr;
              }
              break;
            }
            case 'approval': {
              // First try resolving an MCP permission_prompt that's waiting on this id.
              const resolved = permissions.resolve(agent, id, parsed.toolUseId!, parsed.decision!);
              if (!resolved) {
                // No pending MCP prompt — fall back to writing to claude's stdin (legacy path).
                session.sendApproval(parsed.toolUseId!, parsed.decision!);
              }
              break;
            }
            case 'interrupt':
              session.interrupt();
              break;
            case 'set_mode':
              if (parsed.mode) session.setMode(parsed.mode);
              break;
            case 'ping':
              send(ws, { type: 'event', event: { type: 'raw', payload: { pong: true } } });
              break;
          }
        } catch (err) {
          console.error(`[bridge] message handler error:`, err);
          send(ws, { type: 'error', message: (err as Error).message });
        }
      },
      onClose: () => {
        if (session) {
          session.subscribers = Math.max(0, session.subscribers - 1);
          if (onEvent) session.off('event', onEvent);
          if (onExit) session.off('exit', onExit);
        }
        if (watcherEmitter && onWatcherChange) {
          watcherEmitter.off('change', onWatcherChange);
        }
        if (watchedCwd) {
          watchers.release(watchedCwd);
        }
        if (jsonlTail) {
          jsonlTail.stop();
          jsonlTail = null;
        }
      },
      onError: (err) => {
        console.error('[ws] error', err);
      },
    };
  }),
);

function send(ws: WSContext, msg: ServerToClient): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // socket likely closing
  }
}

/**
 * Bridge-wide event stream. Lets the sessions list (and any other ambient UI)
 * observe permission requests across every running session without having to
 * subscribe to each session's /stream individually. On attach we send the
 * current snapshot so the client hydrates immediately.
 */
app.get(
  '/events',
  upgradeWebSocket(() => {
    let off: (() => void) | null = null;
    return {
      onOpen: (_evt, ws) => {
        // Snapshot first; live updates after.
        try {
          ws.send(
            JSON.stringify({
              type: 'permissions_snapshot',
              pending: permissions.list(),
            }),
          );
        } catch {
          // socket likely closing
        }
        off = permissions.onChange((e) => {
          try {
            ws.send(JSON.stringify(e));
          } catch {
            // socket likely closing
          }
        });
      },
      onClose: () => {
        off?.();
        off = null;
      },
      onError: () => {
        off?.();
        off = null;
      },
    };
  }),
);

/**
 * Resolve the bind interface. Order:
 *   1. Explicit HOST env var → trust the user.
 *   2. `tailscale serve` running → bind to loopback (serve proxies for us, with TLS).
 *   3. Tailscale up with an IP → bind to that interface (restricts to tailnet traffic).
 *   4. Fallback → loopback (true local-dev).
 */
async function resolveBindHost(): Promise<{ host: string; loopbackDevAllowed: boolean }> {
  const ts = await getTailscaleInfo();
  const serving = await isTailscaleServeRunning();
  runtimeState.tailscaleHostname = ts.hostname;
  runtimeState.tailscaleServing = serving;

  if (config.host) {
    return { host: config.host, loopbackDevAllowed: config.host === '127.0.0.1' && !serving };
  }
  if (serving) return { host: '127.0.0.1', loopbackDevAllowed: false };
  if (ts.online && ts.ip) return { host: ts.ip, loopbackDevAllowed: false };
  return { host: '127.0.0.1', loopbackDevAllowed: true };
}

async function bootstrap(): Promise<void> {
  const { host, loopbackDevAllowed } = await resolveBindHost();
  runtimeState.bindHost = host;
  runtimeState.loopbackDevAllowed = loopbackDevAllowed;

  // Try to acquire a Let's Encrypt cert for our .ts.net hostname. Lets us serve
  // real HTTPS so iOS / Android trust us natively (no NSAllowsArbitraryLoads).
  let tlsCreds: { cert: Buffer; key: Buffer } | null = null;
  if (
    runtimeState.tailscaleHostname &&
    !runtimeState.tailscaleServing &&
    !runtimeState.loopbackDevAllowed
  ) {
    console.log(`[tls] requesting Let's Encrypt cert for ${runtimeState.tailscaleHostname}…`);
    tlsCreds = await getTailscaleCert(runtimeState.tailscaleHostname);
    if (tlsCreds) {
      runtimeState.urlScheme = 'https';
      console.log(`[tls] HTTPS enabled with valid cert`);
    } else {
      console.log(`[tls] falling back to plain HTTP`);
    }
  }

  // Resolve the effective bearer token. Auto-generate when:
  //  - no explicit BEARER_TOKEN env var, AND
  //  - we're not behind tailscale serve (where identity headers handle auth), AND
  //  - we're not pure loopback-dev (where the dev fallback handles auth).
  if (config.bearerToken) {
    runtimeState.bearerToken = config.bearerToken;
  } else if (!runtimeState.tailscaleServing && !runtimeState.loopbackDevAllowed) {
    runtimeState.bearerToken = `rove-${randomBytes(12).toString('hex')}`;
    console.log('[auth] auto-generated bearer token (embedded in QR); set BEARER_TOKEN to override');
  }

  runtime.startReaper();

  // @hono/node-server calls createServer(serverOptions, handler). For HTTPS we
  // need to use https.createServer with the cert/key in serverOptions; HTTP is
  // the default and needs no override.
  const serveOpts = tlsCreds
    ? {
        fetch: app.fetch,
        port: config.port,
        hostname: host,
        createServer: createHttpsServer as any,
        serverOptions: { cert: tlsCreds.cert, key: tlsCreds.key },
      }
    : { fetch: app.fetch, port: config.port, hostname: host };

  const server = serve(
    serveOpts as Parameters<typeof serve>[0],
    (info) => {
      console.log(
        `rove-bridge listening at ${runtimeState.urlScheme}://${info.address}:${info.port}`,
      );
      if (loopbackDevAllowed) {
        console.log('[dev] loopback-only — local connections auto-authenticate as local-dev');
      } else if (runtimeState.tailscaleServing) {
        console.log(`[tailscale] fronted by 'tailscale serve' — identity via header`);
      } else if (runtimeState.tailscaleHostname) {
        console.log(`[tailscale] bound to tailnet IP ${host} (${runtimeState.tailscaleHostname})`);
      }
      if (config.allowedUsers.length === 0) {
        console.log('[info] ALLOWED_USERS not set — will auto-detect Tailscale owner on first request');
      }
      void preflight(config.claudeBin);
      printConnectionQR().catch(() => undefined);
    },
  );

  injectWebSocket(server);

  function shutdown(reason: string): void {
    console.log(`shutting down (${reason})`);
    runtime.stopReaper();
    runtime.shutdownAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error('failed to start bridge:', err);
  process.exit(1);
});
