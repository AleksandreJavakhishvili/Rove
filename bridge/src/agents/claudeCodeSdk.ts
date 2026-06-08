import {
  createSdkMcpServer,
  forkSession as sdkForkSession,
  getSessionInfo as sdkGetSessionInfo,
  getSessionMessages as sdkGetSessionMessages,
  listSessions as sdkListSessions,
  query,
  tool as sdkTool,
  type CanUseTool,
  type Options as SdkOptions,
  type PermissionMode as SdkPermissionMode,
  type PermissionResult as SdkPermissionResult,
  type Query as SdkQuery,
  type SDKMessage,
  type SDKSessionInfo,
  type SDKUserMessage,
  type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { basename } from 'node:path';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { config, runtimeState } from '../config.ts';
import {
  cancelPendingForSession,
  getDispatch,
  isScreenshotAllowed,
  isVisualFeedbackEnabled,
  requestScreenshot,
  type ScreenshotOutcome,
} from '../screenshotBroker.ts';
import { requestHandoff, type HandoffOutcome } from '../handoffBroker.ts';
import { getHandoffDispatch } from '../handoffDispatch.ts';
import { getSecretDispatch, requestSecret, type SecretOutcome } from '../secretBroker.ts';
import { checkAndConsume } from '../screenshotRateLimit.ts';
import {
  HANDOFF_INSTRUCTIONS_MAX_LEN,
  HANDOFF_MAX_TIMEOUT_SECONDS,
  HANDOFF_RESULT_STATUS,
  PREPARE_PREVIEW_MCP_TOOL_NAME,
  SCREENSHOT_ERROR_REASON,
  SCREENSHOT_MCP_SERVER_NAME,
  SCREENSHOT_MCP_SERVER_VERSION,
  SCREENSHOT_MCP_TOOL_NAME,
  SCREENSHOT_RESOLVED_URL_PREFIX,
  SCREENSHOT_RESOLVED_URL_UNKNOWN,
  SCREENSHOT_WAIT_MS_CAP,
  SECRET_NAME_MAX_LEN,
  SECRET_PATH_MAX_LEN,
  SECRET_REASON_MAX_LEN,
  SET_SECRET_MCP_TOOL_NAME,
  SET_SECRET_MCP_TOOL_QUALIFIED,
  type HandoffResultStatus,
  type ScreenshotErrorReason,
} from './types.ts';
import { getHeadSha } from '../git.ts';
import { requestUserAction } from '../requests.ts';
import { runtime } from '../runtime.ts';
import type { HistoryEntry } from '../types.ts';
import { attributeManySessions, getDesktopPidsForSession } from './desktopPids.ts';
import { desktopPidsForSessionFromRegistry } from '../sessionRegistry.ts';
import {
  CLAUDE_CODE_AGENT,
  COMPACT_TRIGGER,
  PERMISSION_MODES,
  SDK_RUN_STATUS,
  isPermissionMode,
  type AgentCapabilities,
  type AgentDriver,
  type AgentEvent,
  type AgentSession,
  type CompactResult,
  type CompactTrigger,
  type DriverSessionListItem,
  type ModelOption,
  type PermissionMode,
  type ReadHistoryOptions,
  type RequestKind,
  type SdkRunStatus,
  type WorkflowTaskStatus,
} from './types.ts';

const DEFAULT_PERMISSION_MODE: PermissionMode = 'default';

/**
 * `type` discriminator values for SDK frames we care about. The SDK doesn't
 * export string constants for these — the values come from the public
 * `SDKMessage` discriminated-union literals — but we want them named so a
 * typo silently dropping a frame is impossible.
 */
const SDK_MESSAGE_TYPE = {
  system: 'system',
  assistant: 'assistant',
  user: 'user',
  streamEvent: 'stream_event',
  result: 'result',
} as const;

/**
 * `subtype` discriminator values for `system` frames we translate into
 * AgentEvents. Each one is the literal the SDK ships in `SDKSystemMessage`,
 * `SDKStatusMessage`, `SDKCompactBoundaryMessage`, etc.
 */
const SDK_SYSTEM_SUBTYPE = {
  init: 'init',
  status: 'status',
  compactBoundary: 'compact_boundary',
  localCommandOutput: 'local_command_output',
  // Background-task lifecycle — the family the Claude 4.8 `/workflow` feature
  // rides on (also used by Task-tool subagents / shell / monitor tasks).
  taskStarted: 'task_started',
  taskProgress: 'task_progress',
  taskUpdated: 'task_updated',
  taskNotification: 'task_notification',
} as const;

/** Set of `system` subtypes that describe a background task. */
const TASK_SUBTYPES: ReadonlySet<string> = new Set([
  SDK_SYSTEM_SUBTYPE.taskStarted,
  SDK_SYSTEM_SUBTYPE.taskProgress,
  SDK_SYSTEM_SUBTYPE.taskUpdated,
  SDK_SYSTEM_SUBTYPE.taskNotification,
]);

/** Default `subtype` value the SDK emits when a turn completes cleanly. */
const RESULT_SUBTYPE_SUCCESS = 'success';

/**
 * Slash commands the SDK advertised on its `init` message, cached at
 * bridge-process (not session-instance) scope keyed by sessionId. The session
 * object is evicted + recreated on idle / turn-end, which would otherwise wipe
 * the list (an instance field) and leave a freshly-attached client falling back
 * to the built-in command set until the next turn's init. Caching here lets
 * `capabilities()` report the real list immediately on attach.
 */
const slashCommandCache = new Map<string, string[]>();

/**
 * Selectable models, discovered once per bridge process from the SDK's
 * `Query.supportedModels()`. Install-wide (not session-specific), so a single
 * module-level cache is enough. Populates `capabilities().modelSelection.available`
 * so the mobile model picker offers real options instead of just the current
 * model. (`/model` is a terminal-only interactive command and fails headlessly,
 * so the picker — not the slash command — is how model switching works in Rove.)
 */
let availableModels: ModelOption[] = [];

/** Drop in-flight user sends that the SDK still hasn't surfaced after this
 *  long. Generous (10 min) — the goal is just to keep stale entries from
 *  haunting the chat forever if something goes wrong server-side. */
const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * Build the standard text-content tool result the `take_screenshot`
 * handler returns on every failure mode. The text starts with a stable
 * machine-readable prefix (`<reason>: <details>`) so the agent can
 * pattern-match the cause without parsing prose.
 */
function textToolResult(reason: ScreenshotErrorReason, details: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `${reason}: ${details}`,
      },
    ],
    isError: true,
  };
}

/**
 * `set_secret` text result. Same `<status>: <details>` shape as the
 * visual-feedback helpers so the agent can pattern-match the status.
 * `isError` is set on everything except `ok` (a deny / timeout is a
 * non-fatal outcome the agent should adapt to, but it's still not a
 * success). The value is NEVER included here.
 */
function secretTextResult(status: string, details: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `${status}: ${details}`,
      },
    ],
    ...(status === 'ok' ? {} : { isError: true as const }),
  };
}

/** Human-readable detail line for each failure reason. Total coverage
 *  is enforced by the `Record<ScreenshotErrorReason, string>` type so
 *  any new reason added to the constant produces a compile error here
 *  until it's documented. */
const REASON_DETAILS: Record<ScreenshotErrorReason, string> = {
  no_client: 'No mobile client is attached to this session.',
  disabled_by_user: 'User has disabled visual verification for this session.',
  permission_denied: 'User denied the take_screenshot permission prompt.',
  rate_limited: 'Too many captures in the rate-limit window.',
  timeout: 'Phone did not respond within the timeout window.',
  not_mounted: 'Preview pane is not currently mounted on the phone.',
  capture_failed: 'captureRef threw on the phone — the WebView may not be drawn yet.',
  upload_failed: 'Phone-side upload pipeline rejected the screenshot.',
  cancelled: 'Session disconnected mid-capture.',
  unsupported: 'Client platform does not support screenshot capture.',
};

function reasonDetails(reason: ScreenshotErrorReason): string {
  return REASON_DETAILS[reason];
}

/**
 * Build the text-content tool result the `prepare_preview` handler
 * returns. Format: `<status>: <details>` so the agent can pattern-
 * match the status without parsing prose. On `ready` the final URL
 * (if the phone supplied one) is included so the agent knows where
 * the user left the preview.
 */
function handoffTextResult(
  status: HandoffResultStatus,
  details: string,
  extras?: { finalUrl?: string; note?: string },
) {
  const lines = [`${status}: ${details}`];
  if (extras?.finalUrl) lines.push(`final_url: ${extras.finalUrl}`);
  if (extras?.note) lines.push(`note: ${extras.note}`);
  return {
    content: [
      {
        type: 'text' as const,
        text: lines.join('\n'),
      },
    ],
    // Only `ready` + `skipped` are treated as successful tool outcomes;
    // every other status reads as an error so the agent's tool loop
    // can branch.
    isError:
      status !== HANDOFF_RESULT_STATUS.ready && status !== HANDOFF_RESULT_STATUS.skipped,
  };
}

/** Human-readable detail line for each handoff status. Total coverage
 *  enforced by the `Record<HandoffResultStatus, string>` type. */
const HANDOFF_DETAILS: Record<HandoffResultStatus, string> = {
  ready: 'User reports the preview is ready for verification.',
  skipped: 'User skipped the handoff.',
  cancelled: 'User cancelled the handoff (or the session disconnected).',
  timeout: 'User did not respond within the timeout window.',
  disabled_by_user: 'Visual feedback is disabled for this session.',
  no_client: 'No mobile client is attached to this session.',
  rate_limited: 'Too many handoffs in the rate-limit window.',
};

function envMode(): PermissionMode {
  const raw = process.env.PERMISSION_MODE;
  return isPermissionMode(raw) ? raw : DEFAULT_PERMISSION_MODE;
}

/** File-edit tools that `acceptEdits` ("auto-accept edits") auto-approves.
 *  Mirrors the SDK's own notion of a "file edit operation". */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Pull out the timestamp the SDK preserved from the on-disk JSONL entry.
 *  The SDK's public `SessionMessage` type doesn't surface this field, but the
 *  runtime value carries it through because the JSONL always has one. */
function messageTimestamp(msg: SessionMessage): string {
  const top = (msg as unknown as { timestamp?: unknown }).timestamp;
  if (typeof top === 'string') return top;
  const inner = (msg.message as { timestamp?: unknown } | undefined)?.timestamp;
  if (typeof inner === 'string') return inner;
  return new Date(0).toISOString();
}

/**
 * Remap one SDK `SessionMessage` into our normalized `HistoryEntry[]`. Mirrors
 * the structure of `streamLineToEvents` but produces `HistoryEntry` shapes for
 * the on-attach replay (not live `AgentEvent`s).
 */
function sessionMessageToEntries(msg: SessionMessage): HistoryEntry[] {
  const ts = messageTimestamp(msg);
  const uuid = msg.uuid;
  const parentToolUseId = msg.parent_tool_use_id ?? undefined;
  const inner = (msg.message ?? {}) as Record<string, unknown> & {
    role?: string;
    content?: unknown;
    model?: string;
    parentUuid?: string | null;
  };
  const parentUuid =
    (msg as unknown as { parentUuid?: string | null }).parentUuid ??
    inner.parentUuid ??
    null;

  if (msg.type === SDK_MESSAGE_TYPE.user && inner.role === 'user') {
    const content = inner.content;
    if (Array.isArray(content)) {
      const out: HistoryEntry[] = [];
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_result') {
          out.push({
            kind: 'tool_result',
            uuid: `${uuid}:${block.tool_use_id}`,
            parentUuid,
            timestamp: ts,
            toolUseId: String(block.tool_use_id),
            content: block.content,
            isError: Boolean(block.is_error),
            ...(parentToolUseId ? { parentToolUseId } : {}),
          });
        } else if (block.type === 'text') {
          out.push({
            kind: 'user',
            uuid,
            parentUuid,
            timestamp: ts,
            content: block.text,
            ...(parentToolUseId ? { parentToolUseId } : {}),
          });
        }
      }
      return out;
    }
    return [
      {
        kind: 'user',
        uuid,
        parentUuid,
        timestamp: ts,
        content,
        ...(parentToolUseId ? { parentToolUseId } : {}),
      },
    ];
  }

  if (msg.type === SDK_MESSAGE_TYPE.assistant && inner.role === 'assistant') {
    const out: HistoryEntry[] = [];
    const content = inner.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'text') {
          out.push({
            kind: 'assistant',
            uuid: `${uuid}:t`,
            parentUuid,
            timestamp: ts,
            content: block.text,
            ...(inner.model ? { model: inner.model } : {}),
            ...(parentToolUseId ? { parentToolUseId } : {}),
          });
        } else if (block.type === 'tool_use') {
          out.push({
            kind: 'tool_use',
            uuid: `${uuid}:${block.id}`,
            parentUuid,
            timestamp: ts,
            name: String(block.name),
            input: block.input,
            toolUseId: String(block.id),
            ...(parentToolUseId ? { parentToolUseId } : {}),
          });
        }
      }
    } else if (typeof content === 'string') {
      out.push({
        kind: 'assistant',
        uuid,
        parentUuid,
        timestamp: ts,
        content,
        ...(parentToolUseId ? { parentToolUseId } : {}),
      });
    }
    return out;
  }

  if (msg.type === SDK_MESSAGE_TYPE.system) {
    const subtype =
      (msg as unknown as { subtype?: string }).subtype ??
      ((typeof inner === 'object' && (inner as { type?: string }).type) || SDK_MESSAGE_TYPE.system);
    return [
      {
        kind: 'system',
        uuid,
        timestamp: ts,
        subtype: String(subtype),
        content: msg.message,
      },
    ];
  }
  return [];
}

/**
 * Translate one SDK live message frame into our normalized AgentEvent list.
 *
 * The SDK preserves the same `{ type, message, ... }` shape as the CLI's
 * stream-json output, so the mapping is parallel to the one used during
 * on-disk history replay (`sessionMessageToEntries`) but produces live
 * `AgentEvent`s instead of `HistoryEntry`s.
 */
/**
 * Translate one of the SDK's `task_*` system messages into our normalized
 * `workflow_task` event. The four subtypes carry different fields; we fold
 * them into a single shape keyed by `taskId` so a client can render one
 * live-updating card (started → progress/updated → completed). Workflow runs
 * are the tasks with `taskType === 'local_workflow'` / a `workflowName`;
 * other task types (Task-tool subagents, etc.) flow through the same shape.
 */
function taskMessageToWorkflowEvent(msg: SDKMessage): AgentEvent {
  const m = msg as unknown as {
    subtype: string;
    task_id: string;
    description?: string;
    subagent_type?: string;
    task_type?: string;
    workflow_name?: string;
    skip_transcript?: boolean;
    summary?: string;
    status?: WorkflowTaskStatus;
    patch?: { status?: WorkflowTaskStatus; description?: string; error?: string };
  };
  const base = { type: 'workflow_task' as const, taskId: m.task_id };
  switch (m.subtype) {
    case SDK_SYSTEM_SUBTYPE.taskStarted:
      return {
        ...base,
        phase: 'started',
        status: 'running',
        ...(m.task_type ? { taskType: m.task_type } : {}),
        ...(m.workflow_name ? { workflowName: m.workflow_name } : {}),
        ...(m.subagent_type ? { subagentType: m.subagent_type } : {}),
        ...(m.description ? { description: m.description } : {}),
        ...(m.skip_transcript ? { skipTranscript: true } : {}),
      };
    case SDK_SYSTEM_SUBTYPE.taskProgress:
      return {
        ...base,
        phase: 'progress',
        status: 'running',
        ...(m.subagent_type ? { subagentType: m.subagent_type } : {}),
        ...(m.description ? { description: m.description } : {}),
        ...(m.summary ? { summary: m.summary } : {}),
      };
    case SDK_SYSTEM_SUBTYPE.taskUpdated:
      return {
        ...base,
        phase: 'updated',
        ...(m.patch?.status ? { status: m.patch.status } : {}),
        ...(m.patch?.description ? { description: m.patch.description } : {}),
      };
    case SDK_SYSTEM_SUBTYPE.taskNotification:
    default:
      return {
        ...base,
        phase: 'completed',
        ...(m.status ? { status: m.status } : {}),
        ...(m.summary ? { summary: m.summary } : {}),
      };
  }
}

function sdkMessageToEvents(
  msg: SDKMessage,
  onSystemInit?: (info: { model?: string; slashCommands?: string[] }) => void,
): AgentEvent[] {
  const obj = msg as Record<string, unknown> & {
    parent_tool_use_id?: string | null;
  };
  const parentToolUseId: string | undefined = obj.parent_tool_use_id ?? undefined;

  if (
    msg.type === SDK_MESSAGE_TYPE.system &&
    (msg as { subtype?: string }).subtype === SDK_SYSTEM_SUBTYPE.init
  ) {
    const init = msg as { model?: string; slash_commands?: string[]; skills?: string[] };
    // The SDK splits invocable `/`-commands across two init arrays:
    // `slash_commands` (built-ins like compact/model) and `skills` (which
    // includes the Claude 4.8 workflow feature + any user skills). Both are
    // typed in the `/` autocomplete, so merge them for the mobile picker.
    const slash = init.slash_commands ?? [];
    const skills = init.skills ?? [];
    const commands = [...new Set([...slash, ...skills])];
    onSystemInit?.({ model: init.model, slashCommands: commands });
    if (init.model) return [{ type: 'model', model: init.model }];
    return [];
  }

  // Compaction boundary — emitted after /compact runs (or when the auto-compact
  // threshold fires). Carries pre/post token counts and how it was triggered so
  // we can surface a "Conversation compacted (32k → 8k)" meta line instead of
  // leaking the `<command-name>` / `<local-command-stdout>` transcript noise.
  if (
    msg.type === SDK_MESSAGE_TYPE.system &&
    (msg as { subtype?: string }).subtype === SDK_SYSTEM_SUBTYPE.compactBoundary
  ) {
    const cb = msg as unknown as {
      compact_metadata?: {
        trigger?: CompactTrigger;
        pre_tokens?: number;
        post_tokens?: number;
        duration_ms?: number;
      };
    };
    const meta = cb.compact_metadata ?? {};
    return [
      {
        type: 'compact_boundary',
        trigger: meta.trigger ?? COMPACT_TRIGGER.manual,
        preTokens: meta.pre_tokens ?? 0,
        ...(typeof meta.post_tokens === 'number' ? { postTokens: meta.post_tokens } : {}),
        ...(typeof meta.duration_ms === 'number' ? { durationMs: meta.duration_ms } : {}),
      },
    ];
  }

  // High-level Query status — `compacting` while a /compact (or auto-compact)
  // is running, `requesting` while waiting for the model's next response, null
  // when idle. We rebroadcast this so the mobile can show a dedicated
  // "Compacting…" footer instead of the generic "thinking…" one.
  if (
    msg.type === SDK_MESSAGE_TYPE.system &&
    (msg as { subtype?: string }).subtype === SDK_SYSTEM_SUBTYPE.status
  ) {
    const s = msg as unknown as {
      status?: Exclude<SdkRunStatus, 'idle'> | null;
      compact_result?: CompactResult;
      compact_error?: string;
    };
    return [
      {
        type: 'sdk_status',
        status: s.status ?? SDK_RUN_STATUS.idle,
        ...(s.compact_result ? { compactResult: s.compact_result } : {}),
        ...(s.compact_error ? { compactError: s.compact_error } : {}),
      },
    ];
  }

  // Output captured from a local slash command handler (`/voice`, `/usage`,
  // `/compact`, etc). The SDK already records it as a `<local-command-stdout>`
  // user message in the JSONL, but in the live stream this dedicated event
  // lets the mobile render the result without parsing XML.
  if (
    msg.type === SDK_MESSAGE_TYPE.system &&
    (msg as { subtype?: string }).subtype === SDK_SYSTEM_SUBTYPE.localCommandOutput
  ) {
    const out = msg as unknown as { content?: string };
    const content = (out.content ?? '').trim();
    if (!content) return [];
    return [{ type: 'slash_command_output', content }];
  }

  // Background-task lifecycle (Claude 4.8 workflows + Task-tool subagents).
  // Normalize all four `task_*` subtypes into one `workflow_task` event so
  // the client can render a single live-updating card instead of letting
  // these fall through to the `raw` catch-all (where they were dropped).
  if (
    msg.type === SDK_MESSAGE_TYPE.system &&
    TASK_SUBTYPES.has((msg as { subtype?: string }).subtype ?? '')
  ) {
    return [taskMessageToWorkflowEvent(msg)];
  }

  if (msg.type === SDK_MESSAGE_TYPE.assistant) {
    const events: AgentEvent[] = [];
    const messageId =
      (msg.message as { id?: string } | undefined)?.id ?? (msg as { uuid?: string }).uuid;
    const content = (msg.message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string') {
          events.push({
            type: 'text',
            role: 'assistant',
            text: block.text,
            messageId,
            parentToolUseId,
          });
        } else if (block.type === 'tool_use') {
          events.push({
            type: 'tool_use',
            toolUseId: String(block.id),
            name: String(block.name),
            input: block.input,
            parentToolUseId,
          });
        } else if (block.type === 'thinking') {
          events.push({
            type: 'thinking',
            text: String(block.thinking ?? block.text ?? ''),
            parentToolUseId,
          });
        }
      }
    } else if (typeof content === 'string') {
      events.push({
        type: 'text',
        role: 'assistant',
        text: content,
        messageId,
        parentToolUseId,
      });
    }
    return events;
  }

  if (msg.type === SDK_MESSAGE_TYPE.user) {
    const content = (msg.message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const events: AgentEvent[] = [];
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_result') {
          events.push({
            type: 'tool_result',
            toolUseId: String(block.tool_use_id),
            content: block.content,
            isError: Boolean(block.is_error),
            parentToolUseId,
          });
        } else if (block.type === 'text' && typeof block.text === 'string') {
          events.push({ type: 'text', role: 'user', text: block.text, parentToolUseId });
        }
      }
      return events;
    }
    if (typeof content === 'string') {
      return [{ type: 'text', role: 'user', text: content, parentToolUseId }];
    }
    return [];
  }

  if (msg.type === SDK_MESSAGE_TYPE.streamEvent) {
    const ev = (msg as unknown as { event?: Record<string, unknown> }).event;
    if (
      ev?.type === 'content_block_delta' &&
      typeof ev.delta === 'object' &&
      ev.delta !== null &&
      (ev.delta as { type?: string }).type === 'text_delta'
    ) {
      return [
        {
          type: 'text_delta',
          role: 'assistant',
          delta: String((ev.delta as { text?: string }).text ?? ''),
          parentToolUseId,
        },
      ];
    }
    return [{ type: 'raw', payload: msg }];
  }

  if (msg.type === SDK_MESSAGE_TYPE.result) {
    const r = msg as { subtype?: string; duration_ms?: number; usage?: unknown };
    return [
      {
        type: 'result',
        subtype: r.subtype ?? RESULT_SUBTYPE_SUCCESS,
        durationMs: r.duration_ms,
        usage: r.usage,
      },
    ];
  }

  return [{ type: 'raw', payload: msg }];
}

/**
 * SDK-backed session. The mobile / WS layer treats this identically to the CLI
 * session — events flow through `emit('event', ev)` and lifecycle through
 * `emit('exit', …)` — but the underlying transport is an in-process `Query`
 * iterator, not a child claude binary.
 *
 *  - `setMode()` calls `Query.setPermissionMode()` live (no kill).
 *  - `interrupt()` calls `Query.interrupt()` (graceful — current turn closes).
 *  - There's no `child` process / pid; `alive` tracks whether a Query iterator
 *    is currently running.
 *
 * Sessions on disk are identical to the CLI's (~/.claude/projects/<slug>/<id>.jsonl)
 * so takeover-from-desktop and history replay are interoperable byte-for-byte
 * with the CLI driver.
 */
class ClaudeCodeSdkSession extends EventEmitter implements AgentSession {
  readonly agent = CLAUDE_CODE_AGENT;
  readonly sessionId: string;
  readonly cwd: string;
  lastActivity = Date.now();
  subscribers = 0;
  baselineSha: string | null = null;
  permissionMode: PermissionMode = envMode();
  claimedByBridge = false;
  /**
   * Latest live-activity snapshot. Kept on the session so a re-attaching
   * client (user navigated to sessions list mid-turn, then back) can
   * resume showing "Compacting…" / thinking text without waiting for the
   * next event to land. Reset when the current turn ends (`result`).
   */
  liveActivity: {
    sdkStatus: SdkRunStatus;
    thinkingText: string | null;
    /** Number of user messages we've pushed that haven't seen a `result`
     *  reply yet. Drives the "Claude is thinking…" footer when a turn is
     *  in progress but no thinking text has arrived. */
    pendingTurns: number;
  } = { sdkStatus: SDK_RUN_STATUS.idle, thinkingText: null, pendingTurns: 0 };
  /** The model we report to clients for the picker's "current" highlight + chip
   *  label. Normally the value from the SDK `init` message, but when the user
   *  explicitly picks an ALIAS (`default`/`sonnet`/`haiku`), we keep the alias
   *  here instead of the concrete id the SDK resolves it to — otherwise the
   *  picker can't highlight the row the user chose (e.g. `default` resolves to
   *  `claude-opus-4-8[1m]`, which isn't a verbatim entry in supportedModels()).
   *  '' until the first init so capabilities can omit the picker if we never
   *  learn a model. */
  private currentModel = '';
  /** Set to the value the user picked via `setModel` until the next `init`
   *  reports its resolution; lets us keep displaying the chosen alias rather
   *  than the resolved concrete id. Cleared once that init lands (or on error). */
  private pendingSelectedModel: string | null = null;

  private q: SdkQuery | null = null;
  private inputQueue: Array<SDKUserMessage | null> = [];
  private inputResolver: (() => void) | null = null;
  private inputClosed = false;
  /**
   * User messages we've handed to the SDK but haven't yet observed in the
   * SDK's on-disk transcript. The SDK writes to JSONL asynchronously, so a
   * client that reattaches a few seconds after sending can miss its own
   * message in `getSessionMessages()`. The driver's `readHistory` merges
   * this list in, deduped by UUID, so the mobile sees its message back
   * regardless of how fast it navigated away.
   *
   * Entries older than `PENDING_TTL_MS` are pruned defensively — if the SDK
   * never flushed, the message is gone for real and showing it forever
   * would mislead the user.
   */
  pendingUserSends: Array<{ uuid: string; content: string; sentAt: number }> = [];

  constructor(sessionId: string, cwd: string) {
    super();
    this.sessionId = sessionId;
    this.cwd = cwd;
  }

  capabilities(): AgentCapabilities {
    return {
      agent: this.agent,
      permissionPrompts: true,
      permissionModes: PERMISSION_MODES,
      // `available` is populated from supportedModels() shortly after the first
      // query spawns (empty for the brief window before that resolves); mobile
      // shows just the current model until it lands, then the full list.
      modelSelection: this.currentModel
        ? { current: this.currentModel, available: availableModels }
        : null,
      fileCheckpointing: true,
      sessionForking: true,
      interrupt: true,
      nativeFileChanges: true,
      // Claude Code's cwd is always a real filesystem path the bridge can
      // read. Gated on the directory still existing — if the user deletes
      // the project after the session was created we degrade to "no
      // browser" instead of erroring out the whole capability payload.
      projectBrowser: existsSync(this.cwd),
      // Git working-tree visibility. Gated on `.git` existing under the
      // cwd; if it doesn't (plain directory, not a repo) we hide the git
      // section in the Files tab rather than failing the call.
      gitStatus: existsSync(`${this.cwd}/.git`),
      // File-contents search. Gated on the cwd existing — the search
      // backend (ripgrep / grep) is probed lazily on first /search call,
      // so we don't need to fail the capability if rg is missing; the
      // grep fallback covers it on every macOS / Linux box.
      projectSearch: existsSync(this.cwd),
      // Phase 1 of visual-feedback-loop (see
      // docs/sdd/2026-05-25-visual-feedback-loop/) ships the *manual*
      // capture only — the agent-side MCP tool wiring is Phase 2. We
      // advertise the capability up front so the mobile client knows
      // the feature is on the roadmap for this driver; the actual
      // bridge-side MCP tool registration follows in Phase 2.
      screenshotCapture: true,
      // SDK-advertised slash commands (incl. any saved workflows). Omitted
      // until an init message has been seen for this session so mobile keeps
      // its built-in fallback list rather than showing an empty picker.
      ...((slashCommandCache.get(this.sessionId)?.length ?? 0) > 0
        ? { supportedCommands: slashCommandCache.get(this.sessionId)! }
        : {}),
    };
  }

  get pid(): number | undefined {
    // The SDK doesn't expose its underlying process pid. We don't use this for
    // anything load-bearing in the SDK path — takeover detection only cares
    // about FOREIGN pids holding the JSONL open, which still works fine.
    return undefined;
  }

  get alive(): boolean {
    return this.q !== null;
  }

  spawnIfNeeded(): void {
    if (this.alive) return;
    const safeAutoAllow = [
      ...(process.env.AUTO_ALLOW_TOOLS ?? 'Read Grep Glob Ls WebSearch')
        .split(/\s+/)
        .filter(Boolean),
      // The secure paste sheet (Provide / Deny) is the real gate for
      // `set_secret`; auto-allowing the tool avoids a redundant "allow
      // this tool?" prompt stacked in front of the secret sheet.
      SET_SECRET_MCP_TOOL_QUALIFIED,
    ];

    const options: SdkOptions = {
      cwd: this.cwd,
      resume: this.sessionId,
      permissionMode: this.permissionMode as SdkPermissionMode,
      // In-process permission gate — no MCP subprocess. Routes through the
      // shared `permissions` registry so the sessions-list approval UI and
      // the in-chat PermissionSheet keep working unchanged.
      canUseTool: this.makeCanUseTool(),
      allowedTools: safeAutoAllow,
      includePartialMessages: true,
      // Enables `Query.rewindFiles()` — without this the SDK won't snapshot
      // file state between turns and rewind requests come back canRewind:false.
      enableFileCheckpointing: true,
      // SDK-side file-change feed. The hook fires when the agent (or its
      // sandboxed tools) write to the project tree — the only thing the
      // mobile files-changed pane needs to stay live.
      hooks: {
        FileChanged: [
          {
            hooks: [
              async (input) => {
                if ((input as { hook_event_name?: string }).hook_event_name !== 'FileChanged') {
                  return {};
                }
                const fc = input as {
                  file_path?: string;
                  event?: 'change' | 'add' | 'unlink';
                };
                if (typeof fc.file_path === 'string' && fc.event) {
                  this.emit('event', { type: 'file_changed', path: fc.file_path, op: fc.event });
                }
                return {};
              },
            ],
          },
        ],
      },
      env: {
        ...process.env,
        ROVE_BRIDGE: '1',
        // Pin Metro's advertised host to our tailnet name so `expo start`
        // spawned by the agent serves a manifest the phone can actually
        // reach. Without this, Expo auto-detects the LAN IP and the
        // bundle URL it embeds is unreachable from the phone on the
        // tailnet. Only inject when (a) we're on a tailnet and (b) the
        // user hasn't already pinned the var themselves — respect the
        // operator's intent in either direction.
        ...(runtimeState.tailscaleHostname && !process.env.REACT_NATIVE_PACKAGER_HOSTNAME
          ? { REACT_NATIVE_PACKAGER_HOSTNAME: runtimeState.tailscaleHostname }
          : {}),
      },
      allowDangerouslySkipPermissions: this.permissionMode === 'bypassPermissions',
      pathToClaudeCodeExecutable: config.claudeBin,
      // Visual-feedback-loop + preview-handoff — `take_screenshot` and
      // `prepare_preview` are registered as in-process MCP tools on
      // the same server, but ONLY when the user has opted into visual
      // feedback (preview-takeover Phase 0). Skipping registration
      // when off saves ~300 tokens of unused tool descriptions per
      // turn and keeps the agent's tool palette clean.
      //
      // Lifecycle note: the SDK captures `mcpServers` once at query
      // spawn time. Flipping the setting ON mid-session takes effect
      // on the next turn boundary (the SDK Query closes between turns
      // and `spawnIfNeeded` runs again with the updated check).
      // Flipping OFF mid-turn still has the `isVisualFeedbackEnabled`
      // handler gate as defense in depth.
      // The `rove` MCP server is always registered now — `set_secret`
      // must be available every turn so the agent can request a credential
      // instead of asking for a chat paste. The screenshot / preview tools
      // inside it stay gated on `isVisualFeedbackEnabled` (see
      // buildRoveMcpServer), so the token cost when visual feedback is off
      // is just the single secret tool.
      mcpServers: { rove: this.buildRoveMcpServer() },
    };

    this.q = query({ prompt: this.userMessageStream(), options });
    this.lastActivity = Date.now();
    console.log(`[claude-sdk ${this.sessionId.slice(0, 8)}] query started cwd=${this.cwd}`);

    // Discover selectable models once per bridge lifetime so the mobile model
    // picker has real options. The init message only carries the *current*
    // model; the full list comes from this dedicated SDK call.
    if (availableModels.length === 0) {
      this.q
        .supportedModels()
        .then((models) => {
          if (!models.length) return;
          availableModels = models.map((m) => ({
            value: m.value,
            label: m.displayName || m.value,
            ...(m.description ? { description: m.description } : {}),
          }));
          this.emit('event', { type: 'capabilities', capabilities: this.capabilities() });
        })
        .catch((err) =>
          console.error(`[claude-sdk] supportedModels failed:`, (err as Error).message),
        );
    }

    // Capture git baseline lazily on first spawn so the diff endpoint can show
    // "everything this session changed."
    if (!this.baselineSha) {
      getHeadSha(this.cwd).then((sha) => {
        this.baselineSha = sha;
      });
    }

    void this.driveQuery();
  }

  /**
   * Build the `canUseTool` callback the SDK calls before each tool execution.
   * Defers to `requestUserAction` so the chat PermissionSheet, sessions-
   * list chip, and allow-always rule persistence stay byte-identical with the
   * legacy CLI/MCP path from the user's perspective.
   */
  /**
   * Build the in-process MCP server that hosts the two visual-feedback
   * tools (`take_screenshot` + `prepare_preview`). The SDK invokes each
   * handler the same way it would any other MCP tool; both go through
   * `canUseTool` first.
   *
   * All failure paths resolve to a `text` content block with a stable
   * machine-readable prefix so the agent can pattern-match the cause
   * and decide whether to retry, fall back, or proceed.
   */
  private buildRoveMcpServer() {
    return createSdkMcpServer({
      name: SCREENSHOT_MCP_SERVER_NAME,
      version: SCREENSHOT_MCP_SERVER_VERSION,
      tools: [
        // Always registered — the agent should obtain credentials through
        // this tool, never by asking the user to paste a key into chat.
        // The value is entered in a secure sheet on the client and written
        // to disk by the bridge; the model only ever sees a value-hidden
        // confirmation. See `docs/sdd/2026-06-07-rove-secrets/`.
        sdkTool(
          SET_SECRET_MCP_TOOL_NAME,
          'Securely obtain a secret (API key, token, password, connection ' +
            'string) from the user and write it into a project file WITHOUT ' +
            'ever seeing the value yourself. ALWAYS use this instead of asking ' +
            'the user to paste a secret into the chat — never request raw ' +
            'credentials in the conversation. The user pastes the value into a ' +
            'secure sheet in their Rove client; the bridge writes `NAME=value` ' +
            'into the destination file (default `.env`, auto-gitignored) and ' +
            'returns only a value-hidden confirmation. After it is stored, use ' +
            'the secret the normal way (your app/test reads it from the ' +
            'environment / .env at runtime). Returns `ok:` on success, or ' +
            '`denied:` / `timeout:` / `no_client:` / `error:` with a reason.',
          {
            name: z
              .string()
              .min(1)
              .max(SECRET_NAME_MAX_LEN)
              .describe(
                'Environment-variable name to store the secret under, e.g. ' +
                  '"OPENAI_API_KEY". Letters, digits, and underscores; must not ' +
                  'start with a digit.',
              ),
            reason: z
              .string()
              .min(1)
              .max(SECRET_REASON_MAX_LEN)
              .describe(
                'Short, plain-language reason shown to the user in the sheet, ' +
                  'e.g. "Needed to run the integration tests against OpenAI."',
              ),
            path: z
              .string()
              .max(SECRET_PATH_MAX_LEN)
              .optional()
              .describe(
                'Destination file, relative to the project root. Default ' +
                  '".env". Must stay inside the project directory; the user can ' +
                  'change it in the sheet before pasting.',
              ),
          },
          async (args) => {
            return await this.handleSetSecret({
              name: args.name,
              reason: args.reason,
              path: args.path,
            });
          },
        ),
        // Visual-feedback tools — registered only when the user has opted
        // in, so the token cost stays at one tool when the feature is off.
        ...(isVisualFeedbackEnabled(this.sessionId)
          ? [
              sdkTool(
          SCREENSHOT_MCP_TOOL_NAME,
          'Capture the live preview from the user\'s mobile client and ' +
            'receive it as an image. Use this to visually verify ' +
            'frontend changes (layout, colors, alignment) instead of ' +
            'asking the user to describe what they see. The phone ' +
            'waits for the page to be ready (document.readyState ' +
            'complete + browser idle + painted) before capturing — ' +
            'fast pages capture quickly, slow ones get up to `waitMs` ' +
            'of headroom. If the result shows a loading spinner or ' +
            'incomplete UI, retry with a larger `waitMs`.',
          {
            path: z
              .string()
              .optional()
              .describe(
                'Optional dev-server-relative path to navigate to before capturing. ' +
                  'Must start with a single "/" (no protocol, no traversal segments). ' +
                  'Omit to capture whatever is currently shown.',
              ),
            waitMs: z
              .number()
              .int()
              .min(0)
              .max(SCREENSHOT_WAIT_MS_CAP)
              .optional()
              .describe(
                `Maximum time (ms) to wait for the page to become ready before capturing. ` +
                  `Default ~3000ms. For Next.js / heavy SPA cold starts pass 8000–15000ms. ` +
                  `Capped server-side at ${SCREENSHOT_WAIT_MS_CAP}ms; the phone may capture ` +
                  `sooner if the page is ready.`,
              ),
          },
          async (args) => {
            return await this.handleTakeScreenshot({
              path: args.path,
              waitMs: args.waitMs,
            });
          },
        ),
        sdkTool(
          PREPARE_PREVIEW_MCP_TOOL_NAME,
          'Ask the user to prepare the live preview for visual verification — ' +
            'log in, navigate to a screen, dismiss a modal, etc. Use this ' +
            'before `take_screenshot` when the route requires user setup ' +
            '(auth, multi-step flows). The tool returns `ready` once the ' +
            'user signals they\'re done, `skipped` if they declined with ' +
            'an explanation, `cancelled` if they aborted, or `timeout` if ' +
            'they didn\'t respond.',
          {
            instructions: z
              .string()
              .min(1)
              .max(HANDOFF_INSTRUCTIONS_MAX_LEN)
              .describe(
                'Short, plain-language description of what the user should do ' +
                  '(e.g. "Log in to /admin"). Shown verbatim in a sheet on the ' +
                  'phone.',
              ),
            suggestedPath: z
              .string()
              .optional()
              .describe(
                'Optional dev-server-relative path the phone navigates to when ' +
                  'the user taps "Open Preview". Validated client-side.',
              ),
            timeoutSeconds: z
              .number()
              .int()
              .min(1)
              .max(HANDOFF_MAX_TIMEOUT_SECONDS)
              .optional()
              .describe('How long to wait for the user. Server-capped.'),
          },
          async (args) => {
            return await this.handlePreparePreview({
              instructions: args.instructions,
              suggestedPath: args.suggestedPath,
              timeoutSeconds: args.timeoutSeconds,
            });
          },
              ),
            ]
          : []),
      ],
    });
  }

  /**
   * Handle a `set_secret` MCP call (Rove Secrets SDD). Gate chain:
   *   1. Non-empty `name`.
   *   2. A Rove client is attached (no_client otherwise — don't register
   *      a request that's guaranteed to time out).
   *   3. Broker round-trip → the user pastes into the secure sheet → the
   *      bridge writes the value to disk and resolves a value-FREE outcome.
   * The value never passes through this method; the model receives only a
   * value-hidden text result.
   */
  private async handleSetSecret(args: { name: string; reason: string; path?: string }) {
    const name = (args.name ?? '').trim();
    if (!name) {
      return secretTextResult('error', 'set_secret requires a non-empty `name`.');
    }
    const dispatch = getSecretDispatch(this.sessionId);
    if (!dispatch) {
      return secretTextResult(
        'no_client',
        'No Rove client is attached to this session to receive the secure paste prompt.',
      );
    }
    let outcome: SecretOutcome;
    try {
      outcome = await requestSecret(
        this.sessionId,
        { cwd: this.cwd, name, reason: (args.reason ?? '').trim(), path: args.path },
        dispatch,
      );
    } catch (err) {
      return secretTextResult('error', String((err as Error).message ?? err));
    }
    if (outcome.ok) {
      const gi = outcome.addedGitignore ? '; added it to .gitignore' : '';
      return secretTextResult(
        'ok',
        `wrote ${outcome.name} to ${outcome.where} (value hidden${gi}). The value was ` +
          `written to a project file you did not receive — read it from the environment / ` +
          `file at runtime. Note: the file can be read like any other project file; do not ` +
          `print or echo it.`,
      );
    }
    switch (outcome.status) {
      case 'denied':
        return secretTextResult('denied', `User declined to provide ${outcome.name}.`);
      case 'timeout':
        return secretTextResult('timeout', `User did not provide ${outcome.name} in time.`);
      case 'no_client':
        return secretTextResult('no_client', 'No Rove client attached to receive the prompt.');
      case 'cancelled':
        return secretTextResult(
          'cancelled',
          `The ${outcome.name} request was cancelled (client disconnected).`,
        );
      case 'error':
      default:
        return secretTextResult('error', outcome.detail ?? `Failed to store ${outcome.name}.`);
    }
  }

  private async handleTakeScreenshot(args: { path?: string; waitMs?: number }) {
    // Outermost gate (preview-takeover Phase 0) — mirrors the mobile
    // app's `enableVisualFeedback` master switch. When the user hasn't
    // opted into the feature, the entire surface short-circuits: no
    // WS frame goes to the phone, no permission prompt fires.
    if (!isVisualFeedbackEnabled(this.sessionId)) {
      return textToolResult(
        SCREENSHOT_ERROR_REASON.disabled_by_user,
        reasonDetails(SCREENSHOT_ERROR_REASON.disabled_by_user),
      );
    }

    // Per-session kill switch — set by the user via the chat header
    // menu. Defaults to true; once flipped off, every call short-
    // circuits until the user re-enables.
    if (!isScreenshotAllowed(this.sessionId)) {
      return textToolResult(
        SCREENSHOT_ERROR_REASON.disabled_by_user,
        'User has disabled visual verification for this session.',
      );
    }

    // No mobile client attached — return immediately so we don't
    // register a Promise that's guaranteed to time out.
    const dispatch = getDispatch(this.sessionId);
    if (!dispatch) {
      return textToolResult(
        SCREENSHOT_ERROR_REASON.no_client,
        'No mobile client is currently attached to this session.',
      );
    }

    // Per-session token bucket — protect the user from a runaway agent
    // burning image-input tokens.
    const rate = checkAndConsume(this.agent, this.sessionId);
    if (!rate.ok) {
      return textToolResult(
        SCREENSHOT_ERROR_REASON.rate_limited,
        `Retry in ${rate.retryAfterSeconds}s.`,
      );
    }

    let outcome: ScreenshotOutcome;
    try {
      outcome = await requestScreenshot(
        this.sessionId,
        { path: args.path, waitMs: args.waitMs },
        dispatch,
      );
    } catch (err) {
      // requestScreenshot never rejects in normal flow; this branch
      // only triggers on a programming error.
      return textToolResult(
        SCREENSHOT_ERROR_REASON.capture_failed,
        String((err as Error).message ?? err),
      );
    }

    if (!outcome.ok) {
      return textToolResult(outcome.reason, reasonDetails(outcome.reason));
    }

    // The phone sent back the absolute desktop path of the just-
    // uploaded PNG (the bridge gave it to the phone during upload).
    // Read the bytes, return as an MCP image content block.
    try {
      const bytes = readFileSync(outcome.uploadId);
      const base64 = bytes.toString('base64');
      // Preview-takeover Phase 2 — append the WebView's final URL as a
      // text block so the agent can spot redirects (auth, 404) without
      // having to inspect the screenshot. Format is stable
      // (`resolved_url: <url>` or `resolved_url: (unknown)`) so an
      // agent string-matching the prefix doesn't have to worry about
      // missing data.
      const resolvedUrl = outcome.resolvedUrl ?? SCREENSHOT_RESOLVED_URL_UNKNOWN;
      return {
        content: [
          {
            type: 'image' as const,
            data: base64,
            mimeType: 'image/png',
          },
          {
            type: 'text' as const,
            text: `${SCREENSHOT_RESOLVED_URL_PREFIX}${resolvedUrl}`,
          },
        ],
      };
    } catch (err) {
      return textToolResult(
        SCREENSHOT_ERROR_REASON.upload_failed,
        String((err as Error).message ?? err),
      );
    }
  }

  /**
   * Handle a `prepare_preview` MCP call. Gate chain mirrors
   * `handleTakeScreenshot`:
   *   1. Global `enableVisualFeedback` (preview-takeover Phase 0).
   *   2. Per-session "Allow visual verification" header toggle.
   *   3. Dispatcher attached (no_client otherwise).
   *   4. Rate limiter (shared bucket — protects against either tool
   *      runaway-burning the user's UI).
   *   5. Broker round-trip → format the typed text result.
   */
  private async handlePreparePreview(args: {
    instructions: string;
    suggestedPath?: string;
    timeoutSeconds?: number;
  }) {
    if (!isVisualFeedbackEnabled(this.sessionId)) {
      return handoffTextResult(
        HANDOFF_RESULT_STATUS.disabled_by_user,
        HANDOFF_DETAILS[HANDOFF_RESULT_STATUS.disabled_by_user],
      );
    }
    if (!isScreenshotAllowed(this.sessionId)) {
      return handoffTextResult(
        HANDOFF_RESULT_STATUS.disabled_by_user,
        HANDOFF_DETAILS[HANDOFF_RESULT_STATUS.disabled_by_user],
      );
    }
    const dispatch = getHandoffDispatch(this.sessionId);
    if (!dispatch) {
      return handoffTextResult(
        HANDOFF_RESULT_STATUS.no_client,
        HANDOFF_DETAILS[HANDOFF_RESULT_STATUS.no_client],
      );
    }
    const rate = checkAndConsume(this.agent, this.sessionId);
    if (!rate.ok) {
      return handoffTextResult(
        HANDOFF_RESULT_STATUS.rate_limited,
        `Retry in ${rate.retryAfterSeconds}s.`,
      );
    }

    let outcome: HandoffOutcome;
    try {
      outcome = await requestHandoff(
        this.sessionId,
        {
          instructions: args.instructions,
          ...(args.suggestedPath !== undefined ? { suggestedPath: args.suggestedPath } : {}),
          ...(args.timeoutSeconds !== undefined
            ? { timeoutMs: args.timeoutSeconds * 1000 }
            : {}),
        },
        dispatch,
      );
    } catch (err) {
      return handoffTextResult(
        HANDOFF_RESULT_STATUS.cancelled,
        String((err as Error).message ?? err),
      );
    }

    const details = HANDOFF_DETAILS[outcome.status];
    if (outcome.ok) {
      return handoffTextResult(outcome.status, details, {
        ...(outcome.finalUrl !== undefined ? { finalUrl: outcome.finalUrl } : {}),
        ...(outcome.note !== undefined ? { note: outcome.note } : {}),
      });
    }
    return handoffTextResult(outcome.status, details);
  }

  private makeCanUseTool(): CanUseTool {
    return async (toolName, input, opts) => {
      // AskUserQuestion is a built-in tool that wants a structured answer, not
      // an allow/deny — route it as a `question` request so the client renders
      // the interactive picker. Everything else is a permission gate.
      const kind: RequestKind = toolName === 'AskUserQuestion' ? 'question' : 'permission';

      // We supply `canUseTool`, so the SDK routes tool calls through us instead
      // of applying its own permission-mode auto-allow. That means the modes
      // the user picks (the chip/`/mode` picker) only take effect if WE honor
      // them here — otherwise "auto-accept edits" still prompts on every edit.
      // Questions always fall through so the picker still appears.
      if (kind === 'permission') {
        const mode = this.permissionMode;
        if (mode === 'bypassPermissions' || (mode === 'acceptEdits' && EDIT_TOOLS.has(toolName))) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      try {
        const res = await requestUserAction({
          kind,
          agent: this.agent,
          sessionId: this.sessionId,
          cwd: this.cwd,
          toolUseId: opts.toolUseID,
          tool: toolName,
          input,
          emitSessionEvent: (ev) => this.emit('event', ev),
        });
        if (res.behavior === 'allow') {
          const result: SdkPermissionResult = {
            behavior: 'allow',
            updatedInput: (res.updatedInput as Record<string, unknown>) ?? input,
          };
          if (res.updatedPermissions && res.updatedPermissions.length > 0) {
            result.updatedPermissions = res.updatedPermissions;
          }
          return result;
        }
        return {
          behavior: 'deny',
          message: res.message ?? 'denied by user',
        } satisfies SdkPermissionResult;
      } catch (err) {
        // Timeout or other registry error — deny so the turn ends cleanly
        // instead of hanging the model.
        return {
          behavior: 'deny',
          message: (err as Error).message ?? 'permission timed out',
        } satisfies SdkPermissionResult;
      }
    };
  }

  private async *userMessageStream(): AsyncIterable<SDKUserMessage> {
    while (true) {
      while (this.inputQueue.length === 0 && !this.inputClosed) {
        await new Promise<void>((resolve) => {
          this.inputResolver = resolve;
        });
      }
      while (this.inputQueue.length > 0) {
        const next = this.inputQueue.shift();
        if (next === null) return; // explicit end-of-stream sentinel
        if (next) yield next;
      }
      if (this.inputClosed) return;
    }
  }

  private pushInput(msg: SDKUserMessage | null): void {
    this.inputQueue.push(msg);
    const resolver = this.inputResolver;
    this.inputResolver = null;
    resolver?.();
  }

  private async driveQuery(): Promise<void> {
    const q = this.q;
    if (!q) return;
    try {
      for await (const msg of q) {
        this.lastActivity = Date.now();
        const events = sdkMessageToEvents(msg, ({ model, slashCommands }) => {
          let changed = false;
          if (model) {
            // If this init is resolving an alias the user just picked, keep the
            // alias for display rather than the concrete id it resolved to.
            const effective =
              this.pendingSelectedModel !== null ? this.pendingSelectedModel : model;
            this.pendingSelectedModel = null;
            if (effective !== this.currentModel) {
              this.currentModel = effective;
              changed = true;
            }
          }
          if (slashCommands && slashCommands.length && !slashCommandCache.has(this.sessionId)) {
            slashCommandCache.set(this.sessionId, slashCommands);
            changed = true;
          }
          // Re-emit capabilities so the mobile chips / slash picker refresh the
          // moment we learn the model + command list from the init message.
          if (changed) {
            this.emit('event', { type: 'capabilities', capabilities: this.capabilities() });
          }
        });
        for (const ev of events) {
          this.trackLiveActivity(ev);
          this.emit('event', ev);
        }
      }
    } catch (err) {
      console.error(`[claude-sdk ${this.sessionId.slice(0, 8)}] query threw:`, err);
      this.emit('event', { type: 'raw', payload: { error: String((err as Error).message) } });
    } finally {
      console.log(`[claude-sdk ${this.sessionId.slice(0, 8)}] query loop ended`);
      this.q = null;
      this.inputQueue = [];
      this.inputClosed = false;
      // Clear live-activity state so a re-attaching client doesn't replay a
      // stale "Thinking…" indicator. If the query threw between sendUserMessage
      // (which bumps pendingTurns) and the SDK emitting a `result` event, the
      // counter would otherwise stay at 1 forever and every fresh subscriber
      // would see the live-status bar even though no turn is actually running.
      this.liveActivity.pendingTurns = 0;
      this.liveActivity.thinkingText = null;
      this.liveActivity.sdkStatus = SDK_RUN_STATUS.idle;
      this.emit('exit', { code: 0, signal: null });
    }
  }

  sendUserMessage(content: string): void {
    if (!this.alive) this.spawnIfNeeded();
    // Mint our own uuid + hand it to the SDK so the on-disk transcript entry
    // carries the same id we'll dedupe against in `readHistory`. Without
    // this, a quick re-attach can lose the message: the SDK hasn't flushed
    // to JSONL yet, so `getSessionMessages` doesn't include it and the
    // optimistic local item in mobile is gone after navigation.
    const uuid = randomUUID();
    const userMsg = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      uuid,
    } as unknown as SDKUserMessage;
    this.pendingUserSends.push({ uuid, content, sentAt: Date.now() });
    // Bump pending-turns so a re-attaching client knows a turn is in
    // flight even before the first assistant chunk arrives. Decremented
    // when the SDK emits a `result` event (see trackLiveActivity).
    this.liveActivity.pendingTurns += 1;
    this.pushInput(userMsg);
    this.lastActivity = Date.now();
  }

  /**
   * Snoop on every event we're about to emit and update the per-session
   * `liveActivity` cache. The cache is the source of truth a re-attaching
   * client reads (via `getLiveActivity`) to restore the chat's "Thinking…"
   * / "Compacting…" indicators without waiting for the next live event.
   */
  private trackLiveActivity(ev: AgentEvent): void {
    if (ev.type === 'sdk_status') {
      this.liveActivity.sdkStatus = ev.status;
      return;
    }
    if (ev.type === 'thinking') {
      const last3 = ev.text.split('\n').slice(-3).join('\n').trim();
      if (last3) this.liveActivity.thinkingText = last3;
      return;
    }
    if (ev.type === 'text' || ev.type === 'text_delta' || ev.type === 'tool_use') {
      // Real output ends the "thinking" phase — drop the buffered thinking
      // ticker so a late re-attach doesn't show a stale block.
      this.liveActivity.thinkingText = null;
      return;
    }
    if (ev.type === 'result') {
      this.liveActivity.thinkingText = null;
      this.liveActivity.sdkStatus = SDK_RUN_STATUS.idle;
      if (this.liveActivity.pendingTurns > 0) this.liveActivity.pendingTurns -= 1;
      return;
    }
  }

  /** Snapshot used by the WS attach handler to replay live state to a
   *  fresh subscriber so navigating-away-and-back doesn't lose the
   *  "Thinking…" / "Compacting…" indicators mid-turn. */
  getLiveActivity(): {
    sdkStatus: SdkRunStatus;
    thinkingText: string | null;
    pendingTurns: number;
  } {
    return { ...this.liveActivity };
  }

  /** Snapshot of in-flight user sends, with TTL-stale entries pruned. The
   *  driver's `readHistory` calls this to merge un-persisted messages into
   *  the transcript replay. */
  takePendingUserSends(): Array<{ uuid: string; content: string; sentAt: number }> {
    const cutoff = Date.now() - PENDING_TTL_MS;
    this.pendingUserSends = this.pendingUserSends.filter((p) => p.sentAt >= cutoff);
    return [...this.pendingUserSends];
  }

  /** Mark a uuid as confirmed (seen in the SDK's persisted transcript) so
   *  future history reads stop synthesizing the entry. Called from the
   *  driver's `readHistory` whenever a pending uuid matches a real one. */
  confirmPendingUserSend(uuid: string): void {
    this.pendingUserSends = this.pendingUserSends.filter((p) => p.uuid !== uuid);
  }

  sendApproval(_toolUseId: string, _decision: 'allow' | 'allow_always' | 'deny'): void {
    // No-op for the SDK path — `canUseTool` is the gate and the WS handler
    // resolves it via `permissions.resolve()`. There's no stdin to write to.
  }

  interrupt(): boolean {
    if (!this.q) return false;
    this.q.interrupt().catch((err) => {
      console.error(`[claude-sdk ${this.sessionId.slice(0, 8)}] interrupt failed:`, err);
    });
    return true;
  }

  setMode(mode: PermissionMode): void {
    if (!isPermissionMode(mode)) return;
    if (this.permissionMode === mode) {
      this.emit('event', { type: 'permission_mode', mode });
      return;
    }
    this.permissionMode = mode;
    this.emit('event', { type: 'permission_mode', mode });
    // Apply live — the SDK supports a runtime mode swap, so unlike the CLI
    // driver we don't have to kill the running query.
    if (this.q) {
      this.q.setPermissionMode(mode as SdkPermissionMode).catch((err) => {
        console.error(`[claude-sdk ${this.sessionId.slice(0, 8)}] setPermissionMode failed:`, err);
      });
    }
  }

  async rewindTo(messageId: string): Promise<{ messageId: string; filesAffected: string[] }> {
    if (!this.q) throw new Error('session not running — cannot rewind');
    const res = await this.q.rewindFiles(messageId);
    if (!res.canRewind) {
      throw new Error(res.error ?? 'rewind not possible at this checkpoint');
    }
    const filesAffected = res.filesChanged ?? [];
    this.emit('event', { type: 'rewind', messageId, filesAffected });
    return { messageId, filesAffected };
  }

  async fork(opts?: { atMessage?: string }): Promise<{ sessionId: string }> {
    return sdkForkSession(this.sessionId, {
      ...(opts?.atMessage ? { upToMessageId: opts.atMessage } : {}),
      ...(this.cwd ? { dir: this.cwd } : {}),
    });
  }

  setModel(model: string): void {
    if (!model || model === this.currentModel) return;
    // Remember the picked value so the next init keeps showing it (aliases like
    // `default` resolve to concrete ids that aren't verbatim picker entries).
    this.pendingSelectedModel = model;
    this.currentModel = model;
    // Mirror onto the per-session subscribers immediately so the mobile chip
    // updates without waiting for the SDK's next init frame. We also re-emit
    // the full capability snapshot so the picker's "selectable" list refreshes
    // if it ever changes (it's static today; will matter once `available`
    // gets populated from a discovery source).
    this.emit('event', { type: 'model', model });
    this.emit('event', { type: 'capabilities', capabilities: this.capabilities() });
    if (this.q) {
      this.q.setModel(model).catch((err) => {
        // Clear the pending alias so a later unrelated init isn't misattributed.
        this.pendingSelectedModel = null;
        console.error(`[claude-sdk ${this.sessionId.slice(0, 8)}] setModel failed:`, err);
      });
    }
  }

  shutdown(): void {
    if (!this.q) return;
    this.q.interrupt().catch(() => undefined);
    this.inputClosed = true;
    this.pushInput(null);
  }
}

/**
 * Translate one `SDKSessionInfo` into our wire shape. The SDK guarantees `cwd`
 * for sessions that came from a local-filesystem store (which is our case); we
 * fall back to an empty cwd just to keep the type honest.
 */
function sdkSessionToListItem(
  info: SDKSessionInfo,
  desktopPids: number[],
): DriverSessionListItem {
  const cwd = info.cwd ?? '';
  return {
    id: info.sessionId,
    cwd,
    projectName: cwd ? basename(cwd) : info.sessionId,
    lastModified: info.lastModified,
    preview: (info.firstPrompt ?? info.summary ?? '').slice(0, 200),
    sizeBytes: info.fileSize ?? 0,
    desktopPids,
  };
}

/**
 * Resolve a session's "first" cwd by reading the head of its on-disk JSONL.
 * The SDK's `getSessionInfo().cwd` returns whatever the most recent record
 * carries, which drifts whenever the session is resumed from a different
 * directory (typical of mobile takeover after a `cd subdir`). Drift makes
 * the session invisible to desktop `claude --resume`, which filters by the
 * project hash of the current cwd. Anchoring to the first recorded cwd
 * matches the CLI's resume behavior and keeps the session findable from
 * the directory it was originally started in.
 *
 * `permission-mode` and `file-history-snapshot` entries are written before
 * the first message and don't carry a cwd, so we skip them and pick the
 * first cwd-bearing line.
 */
function readFirstRecordedCwd(sessionId: string): string | null {
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(config.projectsDir);
  } catch {
    return null;
  }
  let path: string | null = null;
  for (const proj of projectDirs) {
    const candidate = join(config.projectsDir, proj, `${sessionId}.jsonl`);
    if (existsSync(candidate)) {
      path = candidate;
      break;
    }
  }
  if (!path) return null;

  // 64KB is comfortably more than the head needs — the first real record
  // sits within the first few entries, never more than a couple of KB in.
  let head: string;
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = readSync(fd, buf, 0, buf.length, 0);
      head = buf.toString('utf8', 0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  for (const line of head.split('\n')) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as { cwd?: unknown };
      if (typeof obj.cwd === 'string' && obj.cwd) return obj.cwd;
    } catch {
      // Partial last line or malformed entry — keep scanning.
    }
  }
  return null;
}

/**
 * Claude-code driver, fully SDK-backed. Session reads (`listSessions`,
 * `findSession`, `readHistory`) delegate to the SDK's session-management
 * functions. The one exception is `readFirstRecordedCwd` (see above), which
 * peeks at the JSONL head to anchor a session's cwd to its origin instead
 * of letting it drift across resumes.
 */
export class ClaudeCodeSdkDriver implements AgentDriver {
  readonly kind = CLAUDE_CODE_AGENT;
  readonly displayName = 'Claude Code';

  async isAvailable(): Promise<boolean> {
    // The SDK reads from the on-disk projects dir. If it doesn't exist, there
    // are no sessions and most likely claude has never run on this host.
    return existsSync(config.projectsDir);
  }

  async listSessions(): Promise<DriverSessionListItem[]> {
    let sdkSessions: SDKSessionInfo[];
    try {
      sdkSessions = await sdkListSessions();
    } catch (err) {
      console.error('[claude-sdk] listSessions failed:', (err as Error).message);
      return [];
    }
    const items = sdkSessions
      .filter((s) => Boolean(s.cwd))
      .map((s) => ({ id: s.sessionId, cwd: s.cwd!, lastModified: s.lastModified }));
    const desktopByid = await attributeManySessions(items);
    const out = sdkSessions.map((s) =>
      sdkSessionToListItem(s, desktopByid.get(s.sessionId) ?? []),
    );
    out.sort((a, b) => b.lastModified - a.lastModified);
    return out;
  }

  async findSession(id: string): Promise<{ cwd: string; path?: string } | null> {
    let info: SDKSessionInfo | undefined;
    try {
      info = await sdkGetSessionInfo(id);
    } catch (err) {
      console.error(`[claude-sdk] getSessionInfo(${id.slice(0, 8)}) failed:`, (err as Error).message);
      return null;
    }
    if (!info) return null;
    const firstCwd = readFirstRecordedCwd(id);
    return { cwd: firstCwd ?? info.cwd ?? '' };
  }

  async readHistory(id: string, opts: ReadHistoryOptions = {}): Promise<HistoryEntry[]> {
    const limit = opts.limit ?? 100;
    let messages: SessionMessage[];
    try {
      messages = await sdkGetSessionMessages(id);
    } catch (err) {
      console.error(`[claude-sdk] getSessionMessages(${id.slice(0, 8)}) failed:`, (err as Error).message);
      return [];
    }
    const entries: HistoryEntry[] = [];
    const seenUuids = new Set<string>();
    for (const msg of messages) {
      seenUuids.add(msg.uuid);
      for (const e of sessionMessageToEntries(msg)) {
        if (opts.before && e.timestamp >= opts.before) continue;
        entries.push(e);
      }
    }

    // Merge in user messages we forwarded to the SDK but haven't yet seen
    // round-trip back through `getSessionMessages` (the SDK writes JSONL
    // asynchronously, so a quick re-attach can otherwise lose the message).
    // Anything whose uuid already appears in the SDK transcript is dropped
    // from the pending list and skipped here.
    const live = runtime.get(this.kind, id);
    if (live instanceof ClaudeCodeSdkSession) {
      for (const p of live.takePendingUserSends()) {
        if (seenUuids.has(p.uuid)) {
          live.confirmPendingUserSend(p.uuid);
          continue;
        }
        const ts = new Date(p.sentAt).toISOString();
        if (opts.before && ts >= opts.before) continue;
        entries.push({
          kind: 'user',
          uuid: p.uuid,
          parentUuid: null,
          timestamp: ts,
          content: p.content,
        });
      }
    }

    // Oldest-first; clients render newest-at-bottom from the tail.
    return entries.length > limit ? entries.slice(-limit) : entries;
  }

  async getDesktopPids(id: string): Promise<number[]> {
    // Registry-first (claude v2.x): exact pid -> session id, no cwd lookup or
    // sibling listing needed. Returns null only on pre-2.x claude, where we
    // fall through to the legacy cwd + most-recent heuristic below.
    const fromRegistry = await desktopPidsForSessionFromRegistry(id);
    if (fromRegistry !== null) return fromRegistry;

    let info: SDKSessionInfo | undefined;
    try {
      info = await sdkGetSessionInfo(id);
    } catch {
      return [];
    }
    if (!info?.cwd) return [];

    // "Most recent in cwd" — re-list sessions for that directory so the
    // attribution heuristic matches a no-resume desktop claude correctly.
    let siblings: SDKSessionInfo[] = [];
    try {
      siblings = await sdkListSessions({ dir: info.cwd });
    } catch {
      siblings = [info];
    }
    let bestId = id;
    let bestTime = 0;
    for (const s of siblings) {
      if (s.lastModified > bestTime) {
        bestTime = s.lastModified;
        bestId = s.sessionId;
      }
    }
    return getDesktopPidsForSession({
      sessionId: id,
      cwd: info.cwd,
      isMostRecentInCwd: bestId === id,
    });
  }

  createSession(id: string, cwd: string): AgentSession {
    return new ClaudeCodeSdkSession(id, cwd);
  }

  /** Fork the session via the SDK. Returns the new session id. */
  async forkSession(id: string, opts?: { upToMessageId?: string }): Promise<{ sessionId: string }> {
    return sdkForkSession(id, opts);
  }
}
