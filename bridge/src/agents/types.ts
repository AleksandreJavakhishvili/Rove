import type { HistoryEntry } from '../types.ts';

export type AgentKind = 'claude-code' | 'codex' | 'aider' | (string & {});

/**
 * The agent kind exposed to mobile + storage for the Claude Code driver.
 * Kept as a named const so the literal isn't duplicated across every place
 * that needs to refer to "this is a claude-code session" (driver kind,
 * AgentSession.agent field, registry key, etc.).
 */
export const CLAUDE_CODE_AGENT: AgentKind = 'claude-code';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/** Canonical, ordered list of permission modes the claude-code agent supports. */
export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
] as const satisfies readonly PermissionMode[];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

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
 * Capability snapshot a session publishes on attach. The mobile app uses this
 * to decide which controls to render (mode chip, model chip, rewind action,
 * approval surfaces…). Drivers leave optional methods undefined when the
 * matching capability is false; the server only invokes them when the
 * capability says it's safe.
 */
export interface AgentCapabilities {
  /** Agent identifier — used by mobile to pick the right tool card pack. */
  agent: AgentKind;
  /** Does this agent ever prompt the user for tool permission? */
  permissionPrompts: boolean;
  /** Permission modes the agent supports; null/empty → no mode picker. */
  permissionModes: readonly PermissionMode[] | null;
  /** Current model + selectable models; null → no model picker. */
  modelSelection: { current: string; available: readonly string[] } | null;
  /** Per-message file-checkpoint restore (Query.rewindFiles). */
  fileCheckpointing: boolean;
  /** Branch the session into a new one at a given point (forkSession). */
  sessionForking: boolean;
  /** Graceful interrupt of the current turn. */
  interrupt: boolean;
  /**
   * Driver emits `file_changed` AgentEvents itself (typically via an in-
   * process hook). Required by the server today — there's no other file-
   * watch fallback — so drivers that can't surface this should not register.
   */
  nativeFileChanges?: boolean;
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
  | { type: 'model'; model: string }
  | { type: 'rewind'; messageId: string; filesAffected: string[] }
  | { type: 'capabilities'; capabilities: AgentCapabilities }
  | { type: 'file_changed'; path: string; op: 'add' | 'change' | 'unlink' }
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
  interrupt(): boolean;
  shutdown(): void;
  spawnIfNeeded(): void;
  /** Snapshot of what this session supports right now. */
  capabilities(): AgentCapabilities;
  // Optional control methods. Drivers leave them undefined when the matching
  // capability is false; the server only invokes them when capability says
  // it's safe.
  setMode?(mode: PermissionMode): void;
  setModel?(model: string): void;
  rewindTo?(messageId: string): Promise<{ messageId: string; filesAffected: string[] }>;
  fork?(opts?: { atMessage?: string }): Promise<{ sessionId: string }>;
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
