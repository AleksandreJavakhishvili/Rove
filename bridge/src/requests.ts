import { EventEmitter } from 'node:events';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { RequestKind } from './agents/types.ts';

/**
 * Generic "user request" pipeline.
 *
 * Every tool call hits the SDK's `canUseTool`. For most tools we need a
 * permission *decision* (allow/deny); for `AskUserQuestion` we need a
 * structured *answer*. Both are the same underlying thing — the agent hit a
 * gate and needs the user to resolve it before the tool proceeds — so they
 * share one registry, keyed by (agent, sessionId, toolUseId), surfaced
 * in-session and in the cross-session "Waiting on you" queue, with one
 * timeout and one resolution path. The `kind` discriminates the UI and the
 * resolution payload; the registry always resolves to a {@link PermissionResponse}
 * (the SDK's allow/deny result) regardless of kind.
 *
 * NOTE: this is distinct from *permission mode* (the agent's autonomy:
 * default / acceptEdits / plan / bypass), which is unrelated and keeps its
 * own naming.
 */

/** The SDK-facing result the registry resolves to. Always an allow/deny
 *  permission result, even for a `question` (which resolves as a `deny`
 *  whose message carries the answer — the only way `canUseTool` can return
 *  data to the model). */
export interface PermissionResponse {
  behavior: 'allow' | 'deny';
  updatedInput?: unknown;
  message?: string;
  /**
   * SDK-shaped permission updates the agent runtime should apply (e.g. write
   * the allow rule to .claude/settings.local.json). Populated for
   * `allow_always` decisions so the SDK persists the rule itself.
   */
  updatedPermissions?: PermissionUpdate[];
}

/** What `requests.await` is given — the gate that needs resolving. */
export interface RequestInput {
  kind: RequestKind;
  toolUseId: string;
  tool: string;
  input: unknown;
}

/** How a client resolves a pending request. Discriminated by `kind`. */
export type RequestResolution =
  | { kind: 'permission'; decision: 'allow' | 'allow_always' | 'deny' }
  | { kind: 'question'; answers: Record<string, string> };

interface PendingRequest {
  kind: RequestKind;
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

/** Snapshot of a pending request, safe to broadcast to clients. */
export interface PendingRequestSnapshot {
  kind: RequestKind;
  agent: string;
  sessionId: string;
  toolUseId: string;
  tool: string;
  input: unknown;
  cwd: string | null;
  createdAt: number;
}

export type RequestEvent =
  | { type: 'request_added'; pending: PendingRequestSnapshot }
  | {
      type: 'request_resolved';
      agent: string;
      sessionId: string;
      toolUseId: string;
      decision: 'allow' | 'allow_always' | 'deny' | 'timeout';
    };

/** Questions get the same generous window as the other user round-trips
 *  (secret / handoff) — reading 1–4 questions takes longer than an
 *  allow/deny tap. Permissions keep the snappier default. */
const QUESTION_TIMEOUT_MS = 5 * 60 * 1000;
const PERMISSION_TIMEOUT_MS = 120_000;

/**
 * Derive an SDK `PermissionUpdate` for an `allow_always` decision. The shape
 * mirrors what Claude Code writes itself when the user picks "always allow" —
 * `{ toolName, ruleContent }` pairs the SDK persists to
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
  return {
    type: 'addRules',
    rules: [ruleContent ? { toolName: tool, ruleContent } : { toolName: tool }],
    behavior: 'allow',
    destination: 'localSettings',
  };
}

/**
 * Format the user's `AskUserQuestion` answers into the tool_result text the
 * model receives. Phrased as a clear answer (not an error) even though it
 * rides the `deny` channel, so the model proceeds on the user's choice. Free
 * text (the "reply in your own words" path) flows through unchanged.
 */
export function formatQuestionAnswers(answers: Record<string, string>): string {
  const lines = Object.entries(answers)
    .filter(([, a]) => typeof a === 'string' && a.trim().length > 0)
    .map(([q, a]) => `Q: ${q}\nA: ${a.trim()}`);
  if (lines.length === 0) {
    return 'The user dismissed the question without choosing an answer. Ask again only if you genuinely cannot proceed; otherwise use your best judgment.';
  }
  return `[The user answered your question via Rove — this is their response, not an error.]\n\n${lines.join('\n\n')}\n\nProceed using these answers.`;
}

class RequestRegistry extends EventEmitter {
  private pendingByKey = new Map<string, PendingRequest>();

  /** Snapshot of every pending request across all sessions. */
  list(): PendingRequestSnapshot[] {
    return Array.from(this.pendingByKey.values()).map((p) => ({
      kind: p.kind,
      agent: p.agent,
      sessionId: p.sessionId,
      toolUseId: p.toolUseId,
      tool: p.tool,
      input: p.input,
      cwd: p.cwd,
      createdAt: p.createdAt,
    }));
  }

  onChange(listener: (e: RequestEvent) => void): () => void {
    this.on('change', listener as (...args: unknown[]) => void);
    return () => this.off('change', listener as (...args: unknown[]) => void);
  }

  private key(agent: string, sessionId: string, toolUseId: string): string {
    return `${agent}::${sessionId}::${toolUseId}`;
  }

  /**
   * Called from `requestUserAction` (itself called by the SDK driver's
   * `canUseTool`). Returns a promise that resolves when the user answers via
   * the in-chat sheet or the cross-session tray.
   */
  await(
    agent: string,
    sessionId: string,
    req: RequestInput,
    cwd: string | null,
    timeoutMs = PERMISSION_TIMEOUT_MS,
  ): Promise<PermissionResponse> {
    return new Promise<PermissionResponse>((resolve, reject) => {
      const k = this.key(agent, sessionId, req.toolUseId);
      const createdAt = Date.now();
      const timer = setTimeout(() => {
        this.pendingByKey.delete(k);
        this.emit('change', {
          type: 'request_resolved',
          agent,
          sessionId,
          toolUseId: req.toolUseId,
          decision: 'timeout',
        } satisfies RequestEvent);
        reject(new Error(`user request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const pending: PendingRequest = {
        kind: req.kind,
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
        type: 'request_added',
        pending: {
          kind: req.kind,
          agent,
          sessionId,
          toolUseId: req.toolUseId,
          tool: req.tool,
          input: req.input,
          cwd,
          createdAt,
        },
      } satisfies RequestEvent);
    });
  }

  /**
   * Resolve a pending request from a client reply. The resolution is
   * discriminated by `kind`:
   *  - `permission` → allow / allow_always / deny.
   *  - `question`   → structured answers, returned to the model as the
   *    tool_result via a `deny`-with-message (see formatQuestionAnswers).
   * Returns false if no pending entry matches (late / duplicate reply).
   */
  resolve(
    agent: string,
    sessionId: string,
    toolUseId: string,
    resolution: RequestResolution,
  ): boolean {
    const k = this.key(agent, sessionId, toolUseId);
    const pending = this.pendingByKey.get(k);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingByKey.delete(k);

    let resolvedDecision: 'allow' | 'allow_always' | 'deny';
    if (resolution.kind === 'question') {
      pending.resolve({ behavior: 'deny', message: formatQuestionAnswers(resolution.answers) });
      // Reuse 'allow' so every pending surface drains this toolUseId cleanly;
      // the label is cosmetic — the model already got its answer.
      resolvedDecision = 'allow';
    } else if (resolution.decision === 'deny') {
      pending.resolve({ behavior: 'deny', message: 'denied by user' });
      resolvedDecision = 'deny';
    } else {
      const updatedInput =
        pending.input && typeof pending.input === 'object'
          ? (pending.input as Record<string, unknown>)
          : {};
      const response: PermissionResponse = { behavior: 'allow', updatedInput };
      if (resolution.decision === 'allow_always') {
        response.updatedPermissions = [deriveAllowPermissionUpdate(pending.tool, pending.input)];
      }
      pending.resolve(response);
      resolvedDecision = resolution.decision;
    }

    this.emit('change', {
      type: 'request_resolved',
      agent,
      sessionId,
      toolUseId,
      decision: resolvedDecision,
    } satisfies RequestEvent);
    return true;
  }
}

export const requests = new RequestRegistry();

/**
 * Single source of truth for "ask the user to resolve a tool gate". The SDK
 * driver's `canUseTool` calls this so the orchestration — emitting the
 * per-session `user_request` event for the in-chat sheet, registering for the
 * cross-session tray, awaiting the user's resolution — lives in one place.
 *
 * `emitSessionEvent` is the per-session AgentEvent emitter. Pass `null` when
 * there's no session to notify; the registry-side /events broadcast still fires.
 */
export interface UserActionParams {
  kind: RequestKind;
  agent: string;
  sessionId: string;
  cwd: string | null;
  toolUseId: string;
  tool: string;
  input: unknown;
  emitSessionEvent:
    | ((event: {
        type: 'user_request';
        kind: RequestKind;
        toolUseId: string;
        tool: string;
        input: unknown;
      }) => void)
    | null;
}

export async function requestUserAction(params: UserActionParams): Promise<PermissionResponse> {
  params.emitSessionEvent?.({
    type: 'user_request',
    kind: params.kind,
    toolUseId: params.toolUseId,
    tool: params.tool,
    input: params.input,
  });
  return requests.await(
    params.agent,
    params.sessionId,
    { kind: params.kind, toolUseId: params.toolUseId, tool: params.tool, input: params.input },
    params.cwd,
    params.kind === 'question' ? QUESTION_TIMEOUT_MS : PERMISSION_TIMEOUT_MS,
  );
}
