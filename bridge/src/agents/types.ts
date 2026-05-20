import type { HistoryEntry } from '../types.ts';

export type AgentKind = 'claude-code' | 'codex' | 'aider' | (string & {});

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export interface AgentMetadata {
  kind: AgentKind;
  displayName: string;
  available: boolean;
}

export interface DriverSessionListItem {
  id: string;
  cwd: string;
  projectName: string;
  lastModified: number;
  preview: string;
  sizeBytes: number;
  /**
   * PIDs (outside this bridge) currently holding the session backing file
   * open. Non-empty means a desktop CLI is live on this session.
   */
  desktopPids: number[];
}

/**
 * Normalized live-event shape that all drivers must emit. The mobile app
 * speaks AgentEvent only; per-agent details get wrapped in `raw` if they
 * don't map cleanly to one of the structured kinds.
 */
export type AgentEvent =
  | { type: 'text'; role: 'assistant' | 'user'; text: string; messageId?: string; parentToolUseId?: string }
  | { type: 'text_delta'; role: 'assistant'; delta: string; messageId?: string; parentToolUseId?: string }
  | { type: 'tool_use'; toolUseId: string; name: string; input: unknown; parentToolUseId?: string }
  | { type: 'tool_result'; toolUseId: string; content: unknown; isError?: boolean; parentToolUseId?: string }
  | { type: 'permission_request'; toolUseId: string; tool: string; input: unknown; parentToolUseId?: string }
  | { type: 'permission_mode'; mode: PermissionMode }
  | { type: 'result'; subtype: string; durationMs?: number; usage?: unknown }
  | { type: 'thinking'; text: string; parentToolUseId?: string }
  | { type: 'raw'; payload: unknown };

export interface SessionLifecycleListeners {
  event: (e: AgentEvent) => void;
  exit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  spawn: (info: { pid: number }) => void;
  error: (err: Error) => void;
}

export interface AgentSession {
  readonly agent: AgentKind;
  readonly sessionId: string;
  readonly cwd: string;
  readonly alive: boolean;
  readonly pid: number | undefined;
  /** Git HEAD captured the first time the session was spawned (or null when cwd isn't a git repo). */
  baselineSha: string | null;
  /** Current permission mode passed to the agent on spawn. */
  permissionMode: PermissionMode;
  subscribers: number;
  lastActivity: number;
  on<K extends keyof SessionLifecycleListeners>(event: K, listener: SessionLifecycleListeners[K]): this;
  off<K extends keyof SessionLifecycleListeners>(event: K, listener: SessionLifecycleListeners[K]): this;
  /** Synthesize an event to subscribers (used by the bridge to forward MCP-originated events). */
  emit<K extends keyof SessionLifecycleListeners>(event: K, ...args: Parameters<SessionLifecycleListeners[K]>): boolean;
  sendUserMessage(content: string): void;
  sendApproval(toolUseId: string, decision: 'allow' | 'allow_always' | 'deny'): void;
  /** Update the permission mode for future spawns; kills the live child so the next message respawns with the new mode. */
  setMode(mode: PermissionMode): void;
  interrupt(): boolean;
  shutdown(): void;
  spawnIfNeeded(): void;
}

export interface ReadHistoryOptions {
  /** Maximum number of entries to return (most recent N). */
  limit?: number;
  /** ISO timestamp — only return entries strictly before this. */
  before?: string;
}

export interface AgentDriver {
  readonly kind: AgentKind;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  listSessions(): Promise<DriverSessionListItem[]>;
  findSession(id: string): Promise<{ cwd: string; path?: string } | null>;
  readHistory(id: string, opts?: ReadHistoryOptions): Promise<HistoryEntry[]>;
  createSession(id: string, cwd: string): AgentSession;
  /** PIDs (excluding our bridge's children) that hold the session file open. */
  getDesktopPids(id: string): Promise<number[]>;
}
