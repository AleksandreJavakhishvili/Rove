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
import { normalizeClientRelPath, readScopedFile, relToCwd } from './files.ts';
import { listDirectory } from './fileTree.ts';
import { JsonlTail } from './jsonlTail.ts';
import { getDiff, runGitDiffFile, runGitStatus } from './git.ts';
import {
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  detectSearchBackend,
  search as searchFiles,
} from './search.ts';
import { foldTaskState, readSessionTasks } from './taskState.ts';
import { inspectPid, invalidateClaudeCache } from './lsof.ts';
import { invalidateRegistryCache } from './sessionRegistry.ts';
import { permissions } from './permissions.ts';
import { preflight } from './preflight.ts';
import { printConnectionQR } from './qr.ts';
import { runtime } from './runtime.ts';
import {
  cancelPendingForSession,
  registerDispatch,
  resolveScreenshot,
  setScreenshotAllowed,
  setVisualFeedbackEnabled,
  unregisterDispatch,
} from './screenshotBroker.ts';
import { cancelHandoffsForSession, resolveHandoff } from './handoffBroker.ts';
import {
  registerHandoffDispatch,
  unregisterHandoffDispatch,
} from './handoffDispatch.ts';
import { sessionMeta } from './sessionMeta.ts';
import { saveUpload } from './uploads.ts';
import {
  getTailscaleCert,
  getTailscaleInfo,
  isTailscaleServeRunning,
  listTailnetDevices,
} from './tailscale.ts';
import {
  HANDOFF_RESULT_STATUS,
  HANDOFF_RESULT_STATUSES,
  PERMISSION_MODES,
  SCREENSHOT_ERROR_REASON,
  SCREENSHOT_ERROR_REASONS,
  type AgentEvent,
  type AgentKind,
  type HandoffResultStatus,
  type ScreenshotErrorReason,
} from './agents/types.ts';
import type { ClientToServer, ServerToClient, SessionListItem } from './types.ts';

const app = new Hono<{ Variables: { auth: { user: string; source: string } } }>();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.use('*', cors({ origin: '*', allowHeaders: ['Authorization', 'Tailscale-User-Login', 'Content-Type'] }));

app.use('*', authMiddleware);

app.get('/health', (c) =>
  c.json({
    ok: true,
    user: c.get('auth').user,
    bridgeId: config.bridgeId,
    // Bridge-level signal: true when `tailscale serve` fronts us, i.e. the
    // keyless identity path is active. Mobile reads this during the discovery
    // probe to decide whether to surface the auto-discovery flow.
    tailscaleServe: runtimeState.tailscaleServing,
  }),
);

// Tailnet device list, used by the mobile app's anchor-based discovery: the
// phone knows ONE bridge and asks it for the rest. Returns every tailnet
// device; the client probes each /health to filter down to actual bridges
// (and skips itself). Any serve-mode bridge can answer this — none is special.
// 503 (not an error) when Tailscale isn't running so the client degrades
// cleanly to the manual add-bridge path.
app.get('/peers', async (c) => {
  const result = await listTailnetDevices();
  if (!result) return c.json({ error: 'tailscale-unavailable' }, 503);
  return c.json(result);
});

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
  // A desktop `claude` process that's open but hasn't touched the JSONL in a
  // while isn't actively driving the session — it's just sitting in another
  // terminal. Treat the session as idle in that case so the badge stops
  // crying wolf. Threshold is generous (2 minutes) — we want to catch real
  // CLI sessions whose user is mid-conversation, not background processes.
  const DESKTOP_ACTIVITY_WINDOW_MS = 2 * 60 * 1000;
  const claimedByBridge = (agent: AgentKind, id: string) =>
    runtime.get(agent, id)?.claimedByBridge === true;
  const sessions: SessionListItem[] = raw.map((s) => {
    const bridgePid = ourPids.get(`${s.agent}::${s.id}`);
    const foreignPids = s.desktopPids.filter((p) => p !== bridgePid && p !== process.pid);
    const recentlyActive = Date.now() - s.lastModified < DESKTOP_ACTIVITY_WINDOW_MS;
    // Order matters: a session the bridge has claimed (via spawn or
    // takeover) reports `live-bridge` even if a stale desktop pid is also
    // floating around — the user already chose phone-side ownership.
    const status: SessionListItem['status'] =
      bridgePid !== undefined || claimedByBridge(s.agent, s.id)
        ? 'live-bridge'
        : foreignPids.length > 0 && recentlyActive
          ? 'live-desktop'
          : 'idle';
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

// Fork the current session. Capability-gated: the driver must expose
// `session.fork()` AND the session's capabilities must report
// `sessionForking: true`. Returns the new session ID for the mobile to
// navigate to.
app.post('/sessions/:agent/:id/fork', async (c) => {
  const agent = c.req.param('agent') as AgentKind;
  const id = c.req.param('id') ?? '';
  const session = await runtime.getOrCreate(agent, id);
  if (!session.capabilities().sessionForking || !session.fork) {
    return c.json({ error: 'fork not supported by this agent' }, 409);
  }
  let body: { atMessage?: string } = {};
  try {
    if (c.req.header('content-type')?.startsWith('application/json')) {
      body = (await c.req.json()) as { atMessage?: string };
    }
  } catch {
    // optional body — ignore parse errors and fork from the head
  }
  try {
    const result = await session.fork(body.atMessage ? { atMessage: body.atMessage } : undefined);
    return c.json({ ok: true, ...result });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
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

  // Mark ownership upfront — even if there are no foreign pids to kill, the
  // fact that the user explicitly asked to take over means they want the
  // bridge to own this session from here on. Subsequent user messages won't
  // re-trigger the conflict check.
  // Persist ownership for the bridge's lifetime (survives session eviction),
  // and mirror onto the live session if one is mounted.
  runtime.claim(agent, id);

  const foreign = await runtime.checkDesktopConflict(agent, id);
  if (!foreign || foreign.length === 0) {
    return c.json({ ok: true, killed: [], note: 'no conflict' });
  }

  // Safety: only kill PIDs whose command line actually looks like claude.
  // A pid that's gone from ps between the conflict check and inspectPid()
  // is treated as "already dead, that's a takeover success" rather than a
  // 409 — refusing here makes the mobile UI report a phantom failure when
  // the desktop process exited on its own moments earlier.
  const verified: number[] = [];
  for (const pid of foreign) {
    const info = await inspectPid(pid);
    if (info && /(?:^|\/)claude(?:\s|$)|claude-code/.test(info.command + ' ' + info.args)) {
      verified.push(pid);
    }
  }
  if (verified.length === 0) {
    invalidateClaudeCache();
    invalidateRegistryCache();
    return c.json({
      ok: true,
      killed: [],
      note: 'no live claude processes for those pids — session is already free',
    });
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
      invalidateClaudeCache();
      invalidateRegistryCache();
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
  invalidateClaudeCache();
  invalidateRegistryCache();
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

// Current task/progress checklist for the session — the same list the desktop
// CLI shows ("#1 [completed] Phase 1…").
//
// Two sources, cheapest-first:
//   1. The harness task store (~/.claude/tasks/<id>/<n>.json) — authoritative
//      and O(#tasks) tiny reads, no transcript scan. Covers TaskCreate/Update.
//   2. Fallback: fold the FULL transcript via the SDK (`readHistory` →
//      `getSessionMessages`). Covers TodoWrite sessions (which write no store)
//      and any session whose store is absent. We read the whole history on
//      purpose — the live WS replay is capped at `historyMaxEntries`, which
//      cuts off the early `TaskCreate` calls, so a phone that only sees the
//      replay can't reconstruct the list itself.
app.get('/sessions/:agent/:id/tasks', async (c) => {
  const agent = c.req.param('agent') as AgentKind;
  const id = c.req.param('id') ?? '';
  const driver = getDriver(agent);
  if (!driver) return c.json({ error: 'unknown agent' }, 404);
  const located = await driver.findSession(id);
  if (!located) return c.json({ error: 'session not found' }, 404);
  try {
    const fromStore = await readSessionTasks(config.tasksDir, id);
    if (fromStore) return c.json({ agent, id, tasks: fromStore, source: 'store' });
    const entries = await driver.readHistory(id, { limit: 1_000_000 });
    return c.json({ agent, id, tasks: foldTaskState(entries), source: 'transcript' });
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

// Project file tree scoped to the session cwd. Backs the @-mention picker
// (Phase 1 of the mobile-file-visibility SDD) and, later, the Files-tab
// project-tree section. Capability-gated on `projectBrowser` so drivers
// with a synthetic/sandboxed cwd can opt out cleanly.
app.get('/sessions/:agent/:id/tree', async (c) => {
  const agent = c.req.param('agent') as AgentKind;
  const id = c.req.param('id') ?? '';
  const driver = getDriver(agent);
  if (!driver) return c.json({ error: 'unknown agent' }, 404);
  const located = await driver.findSession(id);
  if (!located) return c.json({ error: 'session not found' }, 404);

  // Capability gate. We pull the live session if there is one so the
  // capability snapshot reflects the running agent; falling back to
  // `createSession`-shaped probing would require spawning a session just to
  // ask its capabilities, which is the wrong cost trade-off.
  const live = runtime.get(agent, id);
  const caps = live?.capabilities();
  if (caps && caps.projectBrowser !== true) {
    return c.json({ error: 'projectBrowser capability not supported' }, 404);
  }

  const parsed = treeQuerySchema.safeParse({
    path: c.req.query('path'),
    depth: c.req.query('depth'),
    includeHidden: c.req.query('includeHidden'),
    includeIgnored: c.req.query('includeIgnored'),
  });
  if (!parsed.success) {
    return c.json({ error: 'bad query', issues: parsed.error.issues }, 400);
  }

  try {
    const result = await listDirectory(located.cwd, parsed.data);
    return c.json({ agent, id, cwd: located.cwd, ...result });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
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

  // Optional per-file filter — used by the inline tool-card diff and by
  // tapping a row in the "📂 N files changed" pane. Matches against either
  // newPath (modify/add/rename) or oldPath (delete). The path-traversal
  // guard rejects `..` segments up front; the underlying git command is
  // scoped to cwd anyway, but the validation keeps the API tidy.
  const rawPath = c.req.query('path');
  let pathFilter: string | null = null;
  if (rawPath !== undefined && rawPath !== '') {
    try {
      pathFilter = normalizeClientRelPath(rawPath);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  }

  const diff = await getDiff(located.cwd, baseline);
  const files = pathFilter === null
    ? diff.files
    : diff.files.filter((f) => f.newPath === pathFilter || f.oldPath === pathFilter);
  return c.json({
    agent,
    id,
    cwd: located.cwd,
    baseline: diff.baseline,
    files,
    ...(pathFilter !== null ? { pathFilter } : {}),
  });
});

// Full working-tree git status — staged / unstaged / untracked entries plus
// branch + ahead/behind metadata. Independent of the session's own baseline
// diff (that's `/diff`). Drives the Files tab's git section. Capability-
// gated on `gitStatus` so drivers without a real git cwd can opt out.
app.get('/sessions/:agent/:id/git/status', async (c) => {
  const agent = c.req.param('agent') as AgentKind;
  const id = c.req.param('id') ?? '';
  const driver = getDriver(agent);
  if (!driver) return c.json({ error: 'unknown agent' }, 404);
  const located = await driver.findSession(id);
  if (!located) return c.json({ error: 'session not found' }, 404);
  const live = runtime.get(agent, id);
  const caps = live?.capabilities();
  if (caps && caps.gitStatus !== true) {
    return c.json({ error: 'gitStatus capability not supported' }, 404);
  }
  const result = await runGitStatus(located.cwd);
  return c.json({ agent, id, cwd: located.cwd, ...result });
});

// Per-file git diff — vs HEAD by default (`staged=false`) or vs index when
// `staged=true`. Used by the Files tab's git rows. Different code path
// from `/diff?path=` (which is the session-baseline diff): this is the
// pure git working-tree diff, regardless of when the session started.
app.get('/sessions/:agent/:id/git/diff', async (c) => {
  const agent = c.req.param('agent') as AgentKind;
  const id = c.req.param('id') ?? '';
  const driver = getDriver(agent);
  if (!driver) return c.json({ error: 'unknown agent' }, 404);
  const located = await driver.findSession(id);
  if (!located) return c.json({ error: 'session not found' }, 404);
  const live = runtime.get(agent, id);
  const caps = live?.capabilities();
  if (caps && caps.gitStatus !== true) {
    return c.json({ error: 'gitStatus capability not supported' }, 404);
  }

  const rawPath = c.req.query('path');
  if (!rawPath) return c.json({ error: 'missing path query' }, 400);
  let path: string;
  try {
    path = normalizeClientRelPath(rawPath);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
  if (!path) return c.json({ error: 'missing path query' }, 400);

  const staged = c.req.query('staged') === 'true' || c.req.query('staged') === '1';
  const file = await runGitDiffFile(located.cwd, { path, staged });
  return c.json({ agent, id, cwd: located.cwd, path, staged, file });
});

// File-contents search (ripgrep, fallback to grep). Backs the Files-tab
// search bar. Capability-gated on `projectSearch` so drivers without a
// real filesystem cwd opt out cleanly.
app.get('/sessions/:agent/:id/search', async (c) => {
  const agent = c.req.param('agent') as AgentKind;
  const id = c.req.param('id') ?? '';
  const driver = getDriver(agent);
  if (!driver) return c.json({ error: 'unknown agent' }, 404);
  const located = await driver.findSession(id);
  if (!located) return c.json({ error: 'session not found' }, 404);
  const live = runtime.get(agent, id);
  const caps = live?.capabilities();
  if (caps && caps.projectSearch !== true) {
    return c.json({ error: 'projectSearch capability not supported' }, 404);
  }

  const q = c.req.query('q');
  if (!q || q.length === 0) return c.json({ error: 'missing q query' }, 400);
  // Defensive cap on query length so a runaway client can't push a 10MB
  // string at the shell.
  if (q.length > 1000) return c.json({ error: 'q too long' }, 400);

  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : SEARCH_LIMIT_DEFAULT;
  if (!Number.isFinite(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX) {
    return c.json({ error: `limit must be between 1 and ${SEARCH_LIMIT_MAX}` }, 400);
  }
  const regex = c.req.query('regex') === 'true' || c.req.query('regex') === '1';

  try {
    const result = await searchFiles(located.cwd, { query: q, limit, regex });
    return c.json({ agent, id, cwd: located.cwd, ...result });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Coerce truthy/falsy query strings ("true" / "1" / "false" / "0" / "") into
// a real boolean so the route handler doesn't have to do this dance inline.
const booleanQuery = z
  .union([z.string(), z.undefined()])
  .transform((v) => {
    if (v === undefined || v === '') return false;
    return v === 'true' || v === '1';
  });

const treeQuerySchema = z.object({
  path: z
    .union([z.string(), z.undefined()])
    .transform((v) => (v === undefined ? '' : v)),
  depth: z
    .union([z.string(), z.undefined()])
    .transform((v) => (v === undefined || v === '' ? 1 : Number.parseInt(v, 10)))
    .pipe(z.number().int().min(1).max(4)),
  includeHidden: booleanQuery,
  includeIgnored: booleanQuery,
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
    mode: z.enum(PERMISSION_MODES),
  }),
  z.object({
    type: z.literal('set_model'),
    model: z.string().min(1),
  }),
  z.object({
    type: z.literal('rewind_to'),
    messageId: z.string().min(1),
  }),
  // Visual-feedback-loop Phase 2. The cross-field constraint (uploadId
  // present iff ok=true) is checked at the route handler — Zod's
  // discriminatedUnion can only key on a top-level literal field, and
  // .refine() returns ZodEffects which isn't compatible with the
  // outer discriminator. The reason enum is derived from
  // SCREENSHOT_ERROR_REASONS so adding a new reason to the constant
  // automatically picks it up here.
  z.object({
    type: z.literal('screenshot_result'),
    requestId: z.string().min(1),
    ok: z.boolean(),
    uploadId: z.string().min(1).optional(),
    reason: z
      .enum(
        SCREENSHOT_ERROR_REASONS as readonly [ScreenshotErrorReason, ...ScreenshotErrorReason[]],
      )
      .optional(),
    // Preview-takeover Phase 2 — WebView's final URL after capture
    // (best-effort, only valid when `ok === true`). Surfaced to the
    // agent as a `resolved_url:` text block.
    resolvedUrl: z.string().optional(),
  }),
  z.object({
    type: z.literal('set_screenshot_allow'),
    allow: z.boolean(),
  }),
  // Preview-takeover Phase 0 — phone mirrors the global enable
  // setting up to the bridge so tool handlers can short-circuit
  // before any WS round-trip. Independent of `set_screenshot_allow`
  // (per-session header toggle).
  z.object({
    type: z.literal('set_visual_feedback_enabled'),
    enabled: z.boolean(),
  }),
  // Preview-handoff Phase 1 — user reply to a `prepare_preview` call.
  // Cross-field constraints (`finalUrl`/`note` only meaningful when
  // status is ready/skipped) are checked at the route handler, same
  // pattern as `screenshot_result`.
  z.object({
    type: z.literal('prepare_preview_result'),
    requestId: z.string().min(1),
    status: z.enum(
      HANDOFF_RESULT_STATUSES as readonly [HandoffResultStatus, ...HandoffResultStatus[]],
    ),
    finalUrl: z.string().optional(),
    note: z.string().optional(),
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
    let jsonlTail: JsonlTail | null = null;
    // Captured here so onClose can unregister the exact dispatcher it
    // registered — guards against a stale unmount clobbering a fresh
    // reconnect that's already registered its own dispatcher.
    let screenshotDispatcher:
      | ((args: { requestId: string; path?: string; waitMs?: number }) => void)
      | null = null;
    let handoffDispatcher:
      | ((args: {
          requestId: string;
          instructions: string;
          suggestedPath?: string;
          timeoutSeconds?: number;
        }) => void)
      | null = null;
    // The whole onOpen handler is async (history replay + attach), but a fast
    // client (e.g. the sessions-list one-shot approval helper) sends its first
    // frame the instant the socket reports `open` — which arrives BEFORE we've
    // finished initializing. Track that init as a promise so onMessage can
    // await it instead of silently dropping the frame.
    let readyPromise: Promise<void> | null = null;

    const attach = async (ws: WSContext) => {
      session = await runtime.getOrCreate(agent, id);
      session.subscribers += 1;
      send(ws, { type: 'status', status: session.alive ? 'live-bridge' : 'idle', pid: session.pid });
      // Capability snapshot first — the mobile relies on this to decide which
      // chrome (mode chip, model chip, rewind affordance…) to render before
      // any per-session events arrive.
      send(ws, { type: 'event', event: { type: 'capabilities', capabilities: session.capabilities() } });
      // Tell the new subscriber what permission mode the session is in. The
      // bridge is the source of truth; the mobile client just mirrors this.
      send(ws, { type: 'event', event: { type: 'permission_mode', mode: session.permissionMode } });
      // Replay any approvals that are already pending for this session, so a
      // user opening the chat after the prompt fired still sees the
      // ApprovalSheet. Without this, the sessions-list chip shows the chip
      // (it hydrates from the bridge-wide /events snapshot) but the chat
      // stays blank until the next, unrelated prompt arrives.
      for (const p of permissions.list()) {
        if (p.agent !== agent || p.sessionId !== id) continue;
        send(ws, {
          type: 'event',
          event: {
            type: 'permission_request',
            toolUseId: p.toolUseId,
            tool: p.tool,
            input: p.input,
          },
        });
      }
      // Replay the latest live-activity snapshot so a fresh subscriber
      // (user navigated to sessions list mid-turn, then back) sees the
      // "Compacting…" / "Thinking…" indicators resume immediately instead
      // of going blank until the next live event arrives. Drivers that
      // don't track this leave `getLiveActivity` undefined and we skip.
      if (session.getLiveActivity) {
        const live = session.getLiveActivity();
        if (live.sdkStatus !== 'idle') {
          send(ws, { type: 'event', event: { type: 'sdk_status', status: live.sdkStatus } });
        }
        if (live.thinkingText) {
          send(ws, { type: 'event', event: { type: 'thinking', text: live.thinkingText } });
        }
        if (live.pendingTurns > 0) {
          // Reuse the `status` frame to carry the in-flight count; mobile
          // sets pendingTurns from the optional `pending` field on attach.
          send(ws, {
            type: 'status',
            status: session.alive ? 'live-bridge' : 'idle',
            ...(session.pid !== undefined ? { pid: session.pid } : {}),
            pending: live.pendingTurns,
          });
        }
      }
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
        // file_changed is a top-level wire frame (the mobile already handles
        // it that way); unwrap so we don't break that contract just because
        // the driver started emitting it as an AgentEvent.
        if (e.type === 'file_changed') {
          send(ws, { type: 'file_changed', path: e.path, op: e.op });
          return;
        }
        send(ws, { type: 'event', event: e });
      };
      onExit = (info) => send(ws, { type: 'process_exit', code: info.code, signal: info.signal });
      session.on('event', onEvent);
      session.on('exit', onExit);
      // No external file watcher — every driver registered here is required
      // to advertise `nativeFileChanges: true` and feed `file_changed`
      // AgentEvents itself.

      // Visual-feedback-loop Phase 2: register the dispatcher the SDK
      // tool calls into. We send a `request_screenshot` frame to the
      // phone; the phone replies with `screenshot_result` which the
      // onMessage handler routes back into the screenshot broker.
      screenshotDispatcher = (args) => {
        send(ws, {
          type: 'request_screenshot',
          requestId: args.requestId,
          ...(args.path !== undefined ? { path: args.path } : {}),
          ...(args.waitMs !== undefined ? { waitMs: args.waitMs } : {}),
        });
      };
      registerDispatch(id, screenshotDispatcher);

      // Preview-handoff Phase 1: parallel dispatcher for the
      // `prepare_preview` round-trip. Same pattern as screenshot —
      // bridge → phone WS frame, phone → bridge reply routed to the
      // handoff broker by the onMessage handler.
      handoffDispatcher = (args) => {
        send(ws, {
          type: 'prepare_preview_request',
          requestId: args.requestId,
          instructions: args.instructions,
          ...(args.suggestedPath !== undefined ? { suggestedPath: args.suggestedPath } : {}),
          ...(args.timeoutSeconds !== undefined ? { timeoutSeconds: args.timeoutSeconds } : {}),
        });
      };
      registerHandoffDispatch(id, handoffDispatcher);
    };

    const initialize = async (ws: WSContext): Promise<void> => {
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
            onEntry: (entry) => send(ws, { type: 'history_entry', entry }),
            onError: (err) => console.log(`[bridge] jsonl-tail error: ${err.message}`),
          });
          await jsonlTail.start();
        }
      }
    };

    return {
      onOpen: (_evt, ws) => {
        readyPromise = initialize(ws).catch((err) => {
          send(ws, { type: 'error', message: (err as Error).message });
          ws.close(1011, 'init failed');
        });
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
        // Wait for the open-time history replay + session attach to finish so
        // fast clients (e.g. the sessions-list one-shot approval) don't get
        // their first frame dropped because `session` is still null.
        if (readyPromise) {
          try {
            await readyPromise;
          } catch {
            // initialize already surfaced the error to the client.
            return;
          }
        }
        if (!session) return;
        try {
          switch (parsed.type) {
            case 'user_message': {
              console.log(
                `[bridge] user_message agent=${agent} id=${id.slice(0, 8)} alive=${session.alive} claimed=${session.claimedByBridge}`,
              );
              // Conflict-check only on the very first message for this
              // session in the bridge's current lifetime. The SDK's Query
              // iterator closes between turns (so `alive` flips back to
              // false after each `result` event), but ownership doesn't
              // bounce — once we've spawned (or taken over), we hold the
              // session for the lifetime of this bridge process.
              if (!session.alive && !session.claimedByBridge) {
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
                // Mark ownership the first time a send succeeds; subsequent
                // turns skip the (often-stale) conflict check entirely. Persist
                // it in the runtime so it survives session eviction on idle.
                runtime.claim(agent, id);
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
              if (!session.capabilities().interrupt) {
                send(ws, { type: 'error', message: 'interrupt not supported by this agent' });
                break;
              }
              session.interrupt();
              break;
            case 'set_mode':
              if (!parsed.mode) break;
              if (!session.capabilities().permissionModes?.length || !session.setMode) {
                send(ws, { type: 'error', message: 'set_mode not supported by this agent' });
                break;
              }
              session.setMode(parsed.mode);
              break;
            case 'set_model': {
              const caps = session.capabilities();
              if (!caps.modelSelection || !session.setModel) {
                send(ws, { type: 'error', message: 'set_model not supported by this agent' });
                break;
              }
              const available = caps.modelSelection.available;
              if (available.length > 0 && !available.some((m) => m.value === parsed.model)) {
                send(ws, {
                  type: 'error',
                  message: `model ${parsed.model} not in agent's available list`,
                });
                break;
              }
              session.setModel(parsed.model!);
              break;
            }
            case 'rewind_to': {
              const caps = session.capabilities();
              if (!caps.fileCheckpointing || !session.rewindTo) {
                send(ws, { type: 'error', message: 'rewind not supported by this agent' });
                break;
              }
              try {
                await session.rewindTo(parsed.messageId!);
              } catch (err) {
                send(ws, { type: 'error', message: `rewind failed: ${(err as Error).message}` });
              }
              break;
            }
            case 'ping':
              send(ws, { type: 'event', event: { type: 'raw', payload: { pong: true } } });
              break;
            case 'screenshot_result': {
              // Cross-field guard the Zod schema can't express inside the
              // outer discriminated union — see the schema comment.
              const requestId = parsed.requestId;
              if (typeof requestId !== 'string') {
                send(ws, {
                  type: 'error',
                  message: 'screenshot_result missing requestId',
                });
                break;
              }
              if (parsed.ok === true && typeof parsed.uploadId === 'string') {
                resolveScreenshot(requestId, {
                  ok: true,
                  uploadId: parsed.uploadId,
                  ...(typeof parsed.resolvedUrl === 'string'
                    ? { resolvedUrl: parsed.resolvedUrl }
                    : {}),
                });
              } else if (parsed.ok === false && parsed.reason !== undefined) {
                resolveScreenshot(requestId, {
                  ok: false,
                  reason: parsed.reason,
                });
              } else {
                send(ws, {
                  type: 'error',
                  message: 'screenshot_result missing uploadId or reason',
                });
              }
              break;
            }
            case 'set_screenshot_allow': {
              if (typeof parsed.allow === 'boolean') {
                setScreenshotAllowed(id, parsed.allow);
              }
              break;
            }
            case 'set_visual_feedback_enabled': {
              if (typeof parsed.enabled === 'boolean') {
                setVisualFeedbackEnabled(id, parsed.enabled);
              }
              break;
            }
            case 'prepare_preview_result': {
              const requestId = parsed.requestId;
              const status = parsed.status;
              if (typeof requestId !== 'string' || status === undefined) {
                send(ws, {
                  type: 'error',
                  message: 'prepare_preview_result missing requestId/status',
                });
                break;
              }
              // Treat `ready` + `skipped` as the success surface; the
              // rest are failure modes (the broker resolves them as
              // `ok: false` either way — the agent's tool result
              // wrapper decides how to render).
              if (
                status === HANDOFF_RESULT_STATUS.ready ||
                status === HANDOFF_RESULT_STATUS.skipped
              ) {
                resolveHandoff(requestId, {
                  ok: true,
                  status,
                  ...(typeof parsed.finalUrl === 'string' ? { finalUrl: parsed.finalUrl } : {}),
                  ...(typeof parsed.note === 'string' ? { note: parsed.note } : {}),
                });
              } else {
                resolveHandoff(requestId, { ok: false, status });
              }
              break;
            }
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
        if (jsonlTail) {
          jsonlTail.stop();
          jsonlTail = null;
        }
        // Visual-feedback-loop Phase 2: tear down the screenshot
        // dispatcher and drain any in-flight requests with `cancelled`
        // so the SDK's tool promise resolves instead of hanging until
        // the 10s timeout.
        if (screenshotDispatcher) {
          unregisterDispatch(id, screenshotDispatcher);
          screenshotDispatcher = null;
        }
        cancelPendingForSession(id, SCREENSHOT_ERROR_REASON.cancelled);
        // Preview-handoff Phase 1: parallel teardown.
        if (handoffDispatcher) {
          unregisterHandoffDispatch(id, handoffDispatcher);
          handoffDispatcher = null;
        }
        cancelHandoffsForSession(id, HANDOFF_RESULT_STATUS.cancelled);
        // Per-session allow toggle (see setScreenshotAllowed / isScreenshotAllowed)
        // intentionally persists across reconnects within the same process —
        // sessions can outlive their WS subscribers (e.g. agent still running)
        // and we don't want a transient disconnect to reset the user's
        // explicit "no visual verification" choice.
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
      // Log which search backend will be used; helps the operator notice
      // when ripgrep isn't installed and the grep fallback is in play.
      void detectSearchBackend().then((b) => {
        console.log(`[info] file search backend: ${b}${b === 'grep' ? ' (install ripgrep for faster results)' : ''}`);
      });
      printConnectionQR().catch(() => undefined);
    },
  );

  injectWebSocket(server);

  // A client can vanish mid-connection — a phone backgrounding, a network
  // flip (Wi-Fi↔cellular), or a `tailscale serve` proxy recycling a socket.
  // Node then emits 'error' on the (TLS) socket, and with no listener that
  // surfaces as an *unhandled* 'error' event which kills the whole bridge
  // ("read ECONNRESET at TLSWrap.onStreamRead"). Attach a per-socket guard so
  // a dead client is a non-event. The listener is added at connect time and
  // rides along through a WebSocket upgrade (same socket object), so it covers
  // the WS replay case too. `secureConnection` carries the TLS socket on the
  // HTTPS path; `connection` covers plain HTTP.
  const IGNORABLE_NET_ERRORS = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECANCELED']);
  const guardSocket = (socket: import('node:net').Socket): void => {
    socket.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      // Benign client disappearance — swallow silently. Log anything else so a
      // real socket fault is still visible, but never let it crash the bridge.
      if (!code || !IGNORABLE_NET_ERRORS.has(code)) {
        console.log(`[bridge] socket error: ${(err as Error).message}`);
      }
    });
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).on('connection', guardSocket);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).on('secureConnection', guardSocket);

  // Backstop for any socket error path the per-socket guard doesn't see (e.g.
  // a socket emitted before our listener attaches). We swallow ONLY known
  // benign network resets; every other uncaught error still exits non-zero so
  // we never keep running in a corrupted state.
  process.on('uncaughtException', (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && IGNORABLE_NET_ERRORS.has(code)) {
      console.log(`[bridge] ignored client socket reset (${code})`);
      return;
    }
    console.error('[bridge] uncaught exception:', err);
    process.exit(1);
  });

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
