import { EventEmitter } from 'node:events';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';

export interface PermissionRequest {
  toolUseId: string;
  tool: string;
  input: unknown;
}

export interface PermissionResponse {
  behavior: 'allow' | 'deny';
  updatedInput?: unknown;
  message?: string;
  /**
   * SDK-shaped permission updates the agent runtime should apply (e.g. write
   * the allow rule to .claude/settings.local.json). Populated for
   * `allow_always` decisions so the SDK persists the rule itself — we no
   * longer touch the file from the bridge.
   */
  updatedPermissions?: PermissionUpdate[];
}

interface Pending {
  resolve: (res: PermissionResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  /** Original tool input — echoed back as `updatedInput` when the user allows. */
  input: unknown;
  /** Tool name + session cwd — captured so an `allow_always` decision can build
   *  a `PermissionUpdate` rule for that session. */
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
 * Derive an SDK `PermissionUpdate` for an `allow_always` decision. The shape
 * mirrors what Claude Code writes itself when the user picks "always allow"
 * in its own UI — `{ toolName, ruleContent }` pairs that the SDK persists to
 * `.claude/settings.local.json` via `canUseTool`'s `updatedPermissions`.
 */
function deriveAllowPermissionUpdate(tool: string, input: unknown): PermissionUpdate {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  let ruleContent: string | undefined;

  if (tool === 'Bash') {
    const command = typeof obj.command === 'string' ? obj.command.trim() : '';
    if (command) ruleContent = command;
  } else if (
    tool === 'Read' ||
    tool === 'Edit' ||
    tool === 'Write' ||
    tool === 'MultiEdit' ||
    tool === 'NotebookEdit'
  ) {
    const path = typeof obj.file_path === 'string' ? obj.file_path : '';
    if (path) {
      // Glob the file's directory rather than the file alone — covers
      // neighboring files the user will plausibly also touch, matching how
      // Claude broadens path rules in its own UI.
      const dir = path.replace(/[^/]*$/, '');
      ruleContent = `${dir}**`;
    }
  } else if (tool === 'WebFetch') {
    const url = typeof obj.url === 'string' ? obj.url : '';
    try {
      const host = new URL(url).host;
      if (host) ruleContent = `domain:${host}`;
    } catch {
      // fall through to bare tool name
    }
  }
  // For WebSearch, Glob, Grep, TodoWrite, Task, mcp__* and any tool where we
  // don't have a specific shape, allow the bare tool name (no ruleContent).
  return {
    type: 'addRules',
    rules: [ruleContent ? { toolName: tool, ruleContent } : { toolName: tool }],
    behavior: 'allow',
    destination: 'localSettings',
  };
}

class PermissionRegistry extends EventEmitter {
  private pendingByKey = new Map<string, Pending>();

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

  private key(agent: string, sessionId: string, toolUseId: string): string {
    return `${agent}::${sessionId}::${toolUseId}`;
  }

  /**
   * Called from `requestPermissionFromUser` (which is itself called by the SDK
   * driver's `canUseTool` callback). Returns a promise that resolves when the
   * user answers via the in-chat ApprovalSheet or the sessions-list chip.
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
      const response: PermissionResponse = { behavior: 'allow', updatedInput };
      if (decision === 'allow_always') {
        // Hand the rule to the SDK as `updatedPermissions` — the SDK writes
        // `.claude/settings.local.json` itself. No more in-bridge file IO.
        response.updatedPermissions = [
          deriveAllowPermissionUpdate(pending.tool, pending.input),
        ];
      }
      pending.resolve(response);
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
}

export const permissions = new PermissionRegistry();

/**
 * Single source of truth for "ask the user to approve a tool call". The SDK
 * driver's `canUseTool` callback calls this so the orchestration — emitting
 * the per-session `permission_request` event for the ApprovalSheet, adding
 * to the registry so the sessions-list chip lights up, awaiting the user's
 * decision — lives in exactly one place.
 *
 * `emitSessionEvent` is the per-session AgentEvent emitter (typically
 * `session.emit.bind(session, 'event')`). Pass `null` when there's no
 * session to notify (e.g. internal automation paths) — the registry-side
 * broadcast on /events still fires.
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
