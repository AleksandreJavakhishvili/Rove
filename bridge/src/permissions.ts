import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, runtimeState } from './config.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = resolve(HERE, 'mcp', 'permission-server.ts');

function resolveTsxBin(): string {
  // Prefer the workspace-local tsx so spawned children don't have to inherit PATH.
  const local = resolve(HERE, '..', '..', 'node_modules', '.bin', 'tsx');
  if (existsSync(local)) return local;
  return 'tsx';
}

export interface PermissionRequest {
  toolUseId: string;
  tool: string;
  input: unknown;
}

export interface PermissionResponse {
  behavior: 'allow' | 'deny';
  updatedInput?: unknown;
  message?: string;
}

interface Pending {
  resolve: (res: PermissionResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  /** Original tool input — echoed back as `updatedInput` when the user allows. */
  input: unknown;
  /** Tool name + session cwd — captured so an `allow_always` decision can persist
   *  a rule to that session's `.claude/settings.local.json`. */
  tool: string;
  cwd: string | null;
  agent: string;
  sessionId: string;
  toolUseId: string;
  createdAt: number;
}

/** Snapshot of a pending permission, safe to broadcast to clients. */
export interface PendingPermissionSnapshot {
  agent: string;
  sessionId: string;
  toolUseId: string;
  tool: string;
  input: unknown;
  cwd: string | null;
  createdAt: number;
}

export type PermissionEvent =
  | { type: 'permission_added'; pending: PendingPermissionSnapshot }
  | {
      type: 'permission_resolved';
      agent: string;
      sessionId: string;
      toolUseId: string;
      decision: 'allow' | 'allow_always' | 'deny' | 'timeout';
    };

/**
 * Derive a `.claude/settings.local.json` permission rule from a tool invocation.
 * Mirrors Claude Code's own conventions (Bash(cmd), Read(path/**), WebFetch(domain:host),
 * mcp__<server>__<tool>, bare tool name as fallback) so rules saved by us are
 * indistinguishable from rules Claude writes itself.
 */
function deriveAllowRule(tool: string, input: unknown): string {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (tool === 'Bash') {
    const command = typeof obj.command === 'string' ? obj.command.trim() : '';
    if (!command) return 'Bash';
    return `Bash(${command})`;
  }
  if (tool === 'Read' || tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const path = typeof obj.file_path === 'string' ? obj.file_path : '';
    if (!path) return tool;
    // Glob the file's directory rather than the file alone — covers neighboring
    // files the user will plausibly also touch, matching how Claude broadens
    // path rules in its own UI.
    const dir = path.replace(/[^/]*$/, '');
    return `${tool}(${dir}**)`;
  }
  if (tool === 'WebFetch') {
    const url = typeof obj.url === 'string' ? obj.url : '';
    try {
      const host = new URL(url).host;
      if (host) return `WebFetch(domain:${host})`;
    } catch {
      // fall through to bare tool name
    }
    return 'WebFetch';
  }
  // WebSearch, Glob, Grep, TodoWrite, Task, mcp__* — bare tool name matches.
  return tool;
}

async function appendAllowRule(cwd: string, rule: string): Promise<void> {
  const dir = join(cwd, '.claude');
  const file = join(dir, 'settings.local.json');
  await mkdir(dir, { recursive: true });
  let data: { permissions?: { allow?: unknown; deny?: unknown; ask?: unknown } } = {};
  try {
    const text = await readFile(file, 'utf8');
    data = JSON.parse(text);
  } catch (err: unknown) {
    // File missing → start fresh. Malformed JSON → log and start fresh (don't
    // silently overwrite — surface it).
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[permissions] settings.local.json unreadable at ${file}:`, err);
    }
  }
  const perms = (data.permissions ??= {});
  const allow = Array.isArray(perms.allow) ? (perms.allow as string[]) : [];
  if (!allow.includes(rule)) allow.push(rule);
  perms.allow = allow;
  if (!Array.isArray(perms.deny)) perms.deny = [];
  if (!Array.isArray(perms.ask)) perms.ask = [];
  await writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

class PermissionRegistry extends EventEmitter {
  private pendingByKey = new Map<string, Pending>();
  private internalTokenValue: string;

  constructor() {
    super();
    this.internalTokenValue = randomUUID();
  }

  /** Snapshot of every pending permission across all sessions. */
  list(): PendingPermissionSnapshot[] {
    return Array.from(this.pendingByKey.values()).map((p) => ({
      agent: p.agent,
      sessionId: p.sessionId,
      toolUseId: p.toolUseId,
      tool: p.tool,
      input: p.input,
      cwd: p.cwd,
      createdAt: p.createdAt,
    }));
  }

  onChange(listener: (e: PermissionEvent) => void): () => void {
    this.on('change', listener as (...args: unknown[]) => void);
    return () => this.off('change', listener as (...args: unknown[]) => void);
  }

  /** Token shared between bridge and the MCP permission server it spawns. */
  internalToken(): string {
    return this.internalTokenValue;
  }

  private key(agent: string, sessionId: string, toolUseId: string): string {
    return `${agent}::${sessionId}::${toolUseId}`;
  }

  /**
   * Called from the bridge's /internal/permission endpoint when the MCP server
   * forwards a request. Returns a promise that resolves when the phone responds.
   */
  await(
    agent: string,
    sessionId: string,
    req: PermissionRequest,
    cwd: string | null,
    timeoutMs = 120_000,
  ): Promise<PermissionResponse> {
    return new Promise<PermissionResponse>((resolve, reject) => {
      const k = this.key(agent, sessionId, req.toolUseId);
      const createdAt = Date.now();
      const timer = setTimeout(() => {
        this.pendingByKey.delete(k);
        this.emit('change', {
          type: 'permission_resolved',
          agent,
          sessionId,
          toolUseId: req.toolUseId,
          decision: 'timeout',
        } satisfies PermissionEvent);
        reject(new Error(`permission_prompt timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const pending: Pending = {
        resolve,
        reject,
        timer,
        input: req.input,
        tool: req.tool,
        cwd,
        agent,
        sessionId,
        toolUseId: req.toolUseId,
        createdAt,
      };
      this.pendingByKey.set(k, pending);
      this.emit('change', {
        type: 'permission_added',
        pending: {
          agent,
          sessionId,
          toolUseId: req.toolUseId,
          tool: req.tool,
          input: req.input,
          cwd,
          createdAt,
        },
      } satisfies PermissionEvent);
    });
  }

  /** Called from the WS `approval` handler when the user taps Allow/Deny. */
  resolve(agent: string, sessionId: string, toolUseId: string, decision: 'allow' | 'allow_always' | 'deny'): boolean {
    const k = this.key(agent, sessionId, toolUseId);
    const pending = this.pendingByKey.get(k);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingByKey.delete(k);
    if (decision === 'deny') {
      pending.resolve({ behavior: 'deny', message: 'denied by user' });
    } else {
      // Claude requires `updatedInput` to be an object. Echo the original input
      // (unmodified) so the tool runs as proposed.
      const updatedInput =
        pending.input && typeof pending.input === 'object'
          ? (pending.input as Record<string, unknown>)
          : {};
      pending.resolve({ behavior: 'allow', updatedInput });
      if (decision === 'allow_always' && pending.cwd) {
        // Fire-and-forget — don't block the response back to Claude. Claude reads
        // settings.local.json at the start of each turn, so the rule takes effect
        // on the next prompt regardless of how long the write takes.
        const rule = deriveAllowRule(pending.tool, pending.input);
        appendAllowRule(pending.cwd, rule).catch((err) => {
          console.error(`[permissions] failed to persist rule "${rule}" in ${pending.cwd}:`, err);
        });
      }
    }
    this.emit('change', {
      type: 'permission_resolved',
      agent,
      sessionId,
      toolUseId,
      decision,
    } satisfies PermissionEvent);
    return true;
  }

  isInternalAuth(headerToken: string | undefined): boolean {
    return !!headerToken && headerToken === this.internalTokenValue;
  }
}

export const permissions = new PermissionRegistry();

/**
 * Single source of truth for "ask the user to approve a tool call". Both the
 * CLI driver (via the /internal/permission endpoint that the MCP server hits)
 * and the SDK driver (via `canUseTool`) call this so the orchestration —
 * emitting the per-session `permission_request` event for the ApprovalSheet,
 * adding to the registry so the sessions-list chip lights up, awaiting the
 * user's decision — lives in exactly one place.
 *
 * `emitSessionEvent` is the per-session AgentEvent emitter (typically
 * `session.emit.bind(session, 'event')`). Pass `null` when there's no session
 * to notify (e.g. internal automation paths) — the registry-side broadcast on
 * /events still fires.
 */
export interface RequestPermissionParams {
  agent: string;
  sessionId: string;
  cwd: string | null;
  toolUseId: string;
  tool: string;
  input: unknown;
  emitSessionEvent: ((event: { type: 'permission_request'; toolUseId: string; tool: string; input: unknown }) => void) | null;
}

export async function requestPermissionFromUser(
  params: RequestPermissionParams,
): Promise<PermissionResponse> {
  params.emitSessionEvent?.({
    type: 'permission_request',
    toolUseId: params.toolUseId,
    tool: params.tool,
    input: params.input,
  });
  return permissions.await(
    params.agent,
    params.sessionId,
    { toolUseId: params.toolUseId, tool: params.tool, input: params.input },
    params.cwd,
  );
}

export function getMcpConfig(extraEnv?: Record<string, string>): string {
  // Inline MCP config — claude will spawn the permission server with these env vars.
  // Absolute paths so claude (whose cwd is the session's project dir) can find them.
  //
  // We prefer the .ts.net hostname when available because our Let's Encrypt cert
  // is issued to it — TLS validates cleanly without skipping checks. Fall back
  // to the bind IP (works, but MCP server's node:https still has
  // rejectUnauthorized:false for the cert-vs-IP hostname mismatch), then to
  // loopback for non-tailscale dev setups.
  const scheme = runtimeState.urlScheme;
  const bridgeHost =
    runtimeState.tailscaleHostname ?? runtimeState.bindHost ?? '127.0.0.1';
  const env: Record<string, string> = {
    ...extraEnv,
    BRIDGE_INTERNAL_URL: `${scheme}://${bridgeHost}:${config.port}`,
    BRIDGE_INTERNAL_TOKEN: permissions.internalToken(),
  };

  const conf = {
    mcpServers: {
      rove: {
        command: resolveTsxBin(),
        args: [MCP_SERVER_PATH],
        env,
      },
    },
  };
  return JSON.stringify(conf);
}
