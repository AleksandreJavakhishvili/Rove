import {
  query,
  type CanUseTool,
  type Options as SdkOptions,
  type PermissionMode as SdkPermissionMode,
  type PermissionResult as SdkPermissionResult,
  type Query as SdkQuery,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter } from 'node:events';
import { config } from '../config.ts';
import { requestPermissionFromUser } from '../permissions.ts';
import { ClaudeCodeDriver } from './claudeCode.ts';
import type { AgentEvent, AgentSession, PermissionMode } from './types.ts';

const VALID_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

function envMode(): PermissionMode {
  const raw = process.env.PERMISSION_MODE;
  return raw && (VALID_MODES as string[]).includes(raw) ? (raw as PermissionMode) : 'default';
}

/**
 * Translate one SDK message frame into our normalized AgentEvent list.
 *
 * The SDK preserves the same `{ type, message, ... }` shape as the CLI's
 * stream-json output, so this mapping is intentionally parallel to the one
 * in `claudeCode.ts#streamLineToEvents`. It's duplicated rather than shared so
 * the SDK driver stays self-contained and can be deleted (or the CLI driver
 * can) without dragging the other along.
 */
function sdkMessageToEvents(msg: SDKMessage): AgentEvent[] {
  const obj = msg as Record<string, unknown> & {
    parent_tool_use_id?: string | null;
  };
  const parentToolUseId: string | undefined = obj.parent_tool_use_id ?? undefined;

  if (msg.type === 'assistant') {
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

  if (msg.type === 'user') {
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

  if (msg.type === 'stream_event') {
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

  if (msg.type === 'result') {
    const r = msg as { subtype?: string; duration_ms?: number; usage?: unknown };
    return [
      {
        type: 'result',
        subtype: r.subtype ?? 'success',
        durationMs: r.duration_ms,
        usage: r.usage,
      },
    ];
  }

  return [{ type: 'raw', payload: msg }];
}

/**
 * SDK-backed session. Mirrors the public surface of the CLI-backed
 * `ClaudeCodeSession` so the rest of the bridge doesn't care which one is in
 * use. Key behavioural differences from the CLI driver:
 *
 *  - `setMode()` uses `Query.setPermissionMode()` — no kill, the conversation
 *    keeps going with the new mode applied to subsequent tool calls.
 *  - `interrupt()` uses `Query.interrupt()` — graceful, the SDK closes out the
 *    current turn cleanly instead of SIGINT'ing a child process.
 *  - There's no `child` process / pid; `alive` tracks whether a Query iterator
 *    is currently running.
 *
 * Auth, session JSONLs and the MCP permission server are identical — the SDK
 * uses the same on-disk session files at `~/.claude/projects/...jsonl` and the
 * same MCP server we spawn for the CLI, so history replay, the permissions
 * registry, and everything downstream keep working unchanged.
 */
class ClaudeCodeSdkSession extends EventEmitter implements AgentSession {
  readonly agent = 'claude-code' as const;
  readonly sessionId: string;
  readonly cwd: string;
  lastActivity = Date.now();
  subscribers = 0;
  baselineSha: string | null = null;
  permissionMode: PermissionMode = envMode();

  private q: SdkQuery | null = null;
  private inputQueue: Array<SDKUserMessage | null> = [];
  private inputResolver: (() => void) | null = null;
  private inputClosed = false;

  constructor(sessionId: string, cwd: string) {
    super();
    this.sessionId = sessionId;
    this.cwd = cwd;
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
      // In-process permission gate — replaces the MCP permission server we
      // use on the CLI path. Routes through the shared `permissions` registry
      // so the sessions-list approval UI and the in-chat ApprovalSheet keep
      // working with no protocol changes.
      canUseTool: this.makeCanUseTool(),
      allowedTools: safeAutoAllow,
      includePartialMessages: true,
      env: { ...process.env, ROVE_BRIDGE: '1' },
      allowDangerouslySkipPermissions: this.permissionMode === 'bypassPermissions',
      pathToClaudeCodeExecutable: config.claudeBin,
    };

    this.q = query({ prompt: this.userMessageStream(), options });
    this.lastActivity = Date.now();
    console.log(`[claude-sdk ${this.sessionId.slice(0, 8)}] query started cwd=${this.cwd}`);
    void this.driveQuery();
  }

  /**
   * Build the `canUseTool` callback the SDK calls before each tool execution.
   * Defers to the shared `requestPermissionFromUser` orchestration so the
   * MCP-backed CLI path and this SDK path stay byte-identical from the user's
   * perspective (chat ApprovalSheet, sessions-list chip, allow_always rule
   * persistence). Only the transport differs.
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
          return {
            behavior: 'allow',
            updatedInput: (res.updatedInput as Record<string, unknown>) ?? input,
          } satisfies SdkPermissionResult;
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
        for (const ev of sdkMessageToEvents(msg)) this.emit('event', ev);
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
    const userMsg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    } as SDKUserMessage;
    this.pushInput(userMsg);
    this.lastActivity = Date.now();
  }

  sendApproval(_toolUseId: string, _decision: 'allow' | 'allow_always' | 'deny'): void {
    // The SDK driver uses the same MCP permission server as the CLI driver,
    // so approvals already flow through `permissions.resolve()` in the WS
    // handler. There's no legacy stdin path to fall back to.
  }

  interrupt(): boolean {
    if (!this.q) return false;
    this.q.interrupt().catch((err) => {
      console.error(`[claude-sdk ${this.sessionId.slice(0, 8)}] interrupt failed:`, err);
    });
    return true;
  }

  setMode(mode: PermissionMode): void {
    if (!(VALID_MODES as string[]).includes(mode)) return;
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

  shutdown(): void {
    if (!this.q) return;
    this.q.interrupt().catch(() => undefined);
    this.inputClosed = true;
    this.pushInput(null);
  }
}

/**
 * Drop-in replacement for `ClaudeCodeDriver` backed by the Claude Agent SDK.
 * Session-list / history / available checks are inherited from the CLI driver
 * because both speak the exact same on-disk format (`~/.claude/projects/`).
 * Only `createSession` is swapped, so flipping driver via env var is a pure
 * runtime swap — no schema or sessions-list differences.
 */
export class ClaudeCodeSdkDriver extends ClaudeCodeDriver {
  // displayName intentionally inherits from the parent ('Claude Code'). The
  // mobile + sessions list key off `kind`, not display name, and we want users
  // to see the same label regardless of which transport is in use.

  override createSession(id: string, cwd: string): AgentSession {
    return new ClaudeCodeSdkSession(id, cwd);
  }
}
