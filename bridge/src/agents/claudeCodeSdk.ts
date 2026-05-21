import {
  forkSession as sdkForkSession,
  getSessionInfo as sdkGetSessionInfo,
  getSessionMessages as sdkGetSessionMessages,
  listSessions as sdkListSessions,
  query,
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
import { existsSync } from 'node:fs';
import { config } from '../config.ts';
import { getHeadSha } from '../git.ts';
import { requestPermissionFromUser } from '../permissions.ts';
import { runtime } from '../runtime.ts';
import type { HistoryEntry } from '../types.ts';
import { attributeManySessions, getDesktopPidsForSession } from './desktopPids.ts';
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
  type PermissionMode,
  type ReadHistoryOptions,
  type SdkRunStatus,
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
} as const;

/** Default `subtype` value the SDK emits when a turn completes cleanly. */
const RESULT_SUBTYPE_SUCCESS = 'success';

/** Drop in-flight user sends that the SDK still hasn't surfaced after this
 *  long. Generous (10 min) — the goal is just to keep stale entries from
 *  haunting the chat forever if something goes wrong server-side. */
const PENDING_TTL_MS = 10 * 60 * 1000;

function envMode(): PermissionMode {
  const raw = process.env.PERMISSION_MODE;
  return isPermissionMode(raw) ? raw : DEFAULT_PERMISSION_MODE;
}

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
function sdkMessageToEvents(
  msg: SDKMessage,
  onSystemInit?: (info: { model?: string }) => void,
): AgentEvent[] {
  const obj = msg as Record<string, unknown> & {
    parent_tool_use_id?: string | null;
  };
  const parentToolUseId: string | undefined = obj.parent_tool_use_id ?? undefined;

  if (
    msg.type === SDK_MESSAGE_TYPE.system &&
    (msg as { subtype?: string }).subtype === SDK_SYSTEM_SUBTYPE.init
  ) {
    const init = msg as { model?: string };
    onSystemInit?.({ model: init.model });
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
  /** Tracks the model the SDK reports in its `init` system message; '' until
   *  the first turn so the capabilities snapshot can omit the model picker if
   *  we never get one. */
  private currentModel = '';

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
      // `available` stays empty until Phase 3 wires the discovery; mobile
      // hides the picker when the list is empty, the chip stays visible
      // because `current` is non-empty as soon as the SDK reports one.
      modelSelection: this.currentModel
        ? { current: this.currentModel, available: [] }
        : null,
      fileCheckpointing: true,
      sessionForking: true,
      interrupt: true,
      nativeFileChanges: true,
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
    const safeAutoAllow = (process.env.AUTO_ALLOW_TOOLS ?? 'Read Grep Glob Ls WebSearch')
      .split(/\s+/)
      .filter(Boolean);

    const options: SdkOptions = {
      cwd: this.cwd,
      resume: this.sessionId,
      permissionMode: this.permissionMode as SdkPermissionMode,
      // In-process permission gate — no MCP subprocess. Routes through the
      // shared `permissions` registry so the sessions-list approval UI and
      // the in-chat ApprovalSheet keep working unchanged.
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
      env: { ...process.env, ROVE_BRIDGE: '1' },
      allowDangerouslySkipPermissions: this.permissionMode === 'bypassPermissions',
      pathToClaudeCodeExecutable: config.claudeBin,
    };

    this.q = query({ prompt: this.userMessageStream(), options });
    this.lastActivity = Date.now();
    console.log(`[claude-sdk ${this.sessionId.slice(0, 8)}] query started cwd=${this.cwd}`);

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
   * Defers to `requestPermissionFromUser` so the chat ApprovalSheet, sessions-
   * list chip, and allow-always rule persistence stay byte-identical with the
   * legacy CLI/MCP path from the user's perspective.
   */
  private makeCanUseTool(): CanUseTool {
    return async (toolName, input, opts) => {
      try {
        const res = await requestPermissionFromUser({
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
        const events = sdkMessageToEvents(msg, ({ model }) => {
          if (model && model !== this.currentModel) {
            this.currentModel = model;
            // Re-emit capabilities so the mobile chip refreshes the moment
            // we learn what model the SDK is using.
            this.emit('event', { type: 'capabilities', capabilities: this.capabilities() });
          }
        });
        for (const ev of events) this.emit('event', ev);
      }
    } catch (err) {
      console.error(`[claude-sdk ${this.sessionId.slice(0, 8)}] query threw:`, err);
      this.emit('event', { type: 'raw', payload: { error: String((err as Error).message) } });
    } finally {
      console.log(`[claude-sdk ${this.sessionId.slice(0, 8)}] query loop ended`);
      this.q = null;
      this.inputQueue = [];
      this.inputClosed = false;
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
    this.pushInput(userMsg);
    this.lastActivity = Date.now();
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
 * Claude-code driver, fully SDK-backed. Session reads (`listSessions`,
 * `findSession`, `readHistory`) delegate to the SDK's session-management
 * functions; we keep zero hand-rolled JSONL parsing on the bridge side. The
 * only non-SDK helper is `desktopPids.ts` (ps-scan) because the SDK can't see
 * processes it didn't spawn.
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
    return { cwd: info.cwd ?? '' };
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
