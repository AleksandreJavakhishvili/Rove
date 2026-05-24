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

/**
 * High-level run-state mirror of the SDK's `SDKStatus`. The SDK emits
 * `compacting` while /compact (or the auto-compact threshold) is processing,
 * `requesting` while waiting for the model's response, and `null` when idle —
 * we coalesce `null` to the explicit `idle` label so downstream code never
 * has to special-case null.
 */
export type SdkRunStatus = 'compacting' | 'requesting' | 'idle';
export const SDK_RUN_STATUS = {
  compacting: 'compacting',
  requesting: 'requesting',
  idle: 'idle',
} as const satisfies Record<SdkRunStatus, SdkRunStatus>;

/**
 * How a compact boundary was reached: `manual` is a user-typed /compact,
 * `auto` is the SDK's threshold-based auto-compact.
 */
export type CompactTrigger = 'manual' | 'auto';
export const COMPACT_TRIGGER = {
  manual: 'manual',
  auto: 'auto',
} as const satisfies Record<CompactTrigger, CompactTrigger>;

/** Outcome of an attempted compaction, when the SDK reports it. */
export type CompactResult = 'success' | 'failed';

/**
 * Kind of entry returned by the project-tree endpoint. `symlink` is exposed
 * so the UI can render a visual cue; resolution still happens server-side
 * and any symlink escaping the session cwd is rejected at the route layer.
 */
export type TreeEntryKind = 'file' | 'dir' | 'symlink';
export const TREE_ENTRY_KIND = {
  file: 'file',
  dir: 'dir',
  symlink: 'symlink',
} as const satisfies Record<TreeEntryKind, TreeEntryKind>;

/**
 * Single entry returned by `GET /sessions/:agent/:id/tree`. Paths are
 * always relative to the session cwd and use POSIX separators so the
 * mobile / web client never has to worry about platform path quirks.
 */
export interface TreeEntry {
  /** basename — e.g. `Markdown.tsx`. */
  name: string;
  /** Relative-to-cwd POSIX path — e.g. `mobile/components/chat/Markdown.tsx`. */
  path: string;
  kind: TreeEntryKind;
  size?: number;
  modifiedMs?: number;
  /** True when `.gitignore` would exclude this entry. UI dims rather than hides. */
  gitIgnored?: boolean;
  /** True for dotfiles (leading `.`). UI can collapse these under a toggle. */
  hidden?: boolean;
}

/**
 * Status flags returned by `git status --porcelain=v2` for the index and
 * worktree halves of a path. `unmodified` is the porcelain `.` character;
 * the rest mirror git's letter codes. Returned for both the index and the
 * worktree position so the UI can render "M /" vs "/M" vs "MM" correctly.
 */
export type GitFileStatus =
  | 'unmodified'
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'ignored'
  | 'typeChange'
  | 'updatedButUnmerged';
export const GIT_FILE_STATUS = {
  unmodified: 'unmodified',
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  untracked: 'untracked',
  ignored: 'ignored',
  typeChange: 'typeChange',
  updatedButUnmerged: 'updatedButUnmerged',
} as const satisfies Record<GitFileStatus, GitFileStatus>;

/**
 * Single entry parsed out of `git status --porcelain=v2 -z`. Both
 * `indexStatus` and `worktreeStatus` are surfaced separately so the UI
 * can group "staged" (index ≠ unmodified) vs "modified" (worktree ≠
 * unmodified) without re-deriving from a single combined glyph.
 */
export interface GitStatusEntry {
  path: string;
  /** Set when `path` is a rename target — original path on the index side. */
  renamedFrom?: string;
  indexStatus: GitFileStatus;
  worktreeStatus: GitFileStatus;
  isUntracked: boolean;
  isIgnored: boolean;
}

/** Top-level shape of `GET /sessions/:agent/:id/git/status`. */
export interface GitStatusResult {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
  /** True when the parse was cut short by the server-side timeout / cap. */
  incomplete?: boolean;
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
  /**
   * Driver's session cwd is a real filesystem path the bridge can read.
   * Enables `GET /sessions/:agent/:id/tree` for the @-mention picker and
   * (later) the Files-tab project tree. Reported false by drivers whose
   * cwd is synthetic or sandboxed.
   */
  projectBrowser?: boolean;
  /**
   * Session cwd is a git working tree. Enables `GET /git/status` (full
   * working-tree state, independent of the session's own baseline diff)
   * and `GET /git/diff` (per-file diff vs HEAD or vs index). Reported
   * false when `.git` is absent or git isn't on PATH.
   */
  gitStatus?: boolean;
  /**
   * `GET /search` endpoint supported — drives the Files-tab search bar.
   * Backed by ripgrep when available, falling back to POSIX grep. The
   * driver should set this to false if its cwd isn't a real filesystem
   * path or if both binaries are missing from PATH.
   */
  projectSearch?: boolean;
}

/** Single match returned by `GET /sessions/:agent/:id/search`. */
export interface SearchHit {
  /** Relative-to-cwd POSIX path. */
  path: string;
  /** 1-based line number of the match. */
  line: number;
  /** 1-based column where the match starts on the line. */
  column: number;
  /** Full text of the matched line (trimmed at MAX_PREVIEW_LEN by the bridge). */
  preview: string;
  /** Character offset (within `preview`) where the match starts. */
  matchStart: number;
  /** Character offset (within `preview`) where the match ends, exclusive. */
  matchEnd: number;
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
  | {
      type: 'compact_boundary';
      trigger: CompactTrigger;
      preTokens: number;
      postTokens?: number;
      durationMs?: number;
    }
  | {
      type: 'sdk_status';
      status: SdkRunStatus;
      compactResult?: CompactResult;
      compactError?: string;
    }
  | { type: 'slash_command_output'; content: string }
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
  /**
   * Set to `true` once the bridge has either spawned this session
   * successfully or completed a takeover of a desktop process holding it.
   * Once claimed, the per-message conflict check is skipped — otherwise
   * the SDK's Query iterator closing between turns (which flips `alive`
   * back to `false`) would re-trigger `session_busy` against any lingering
   * desktop `claude` pid even though the user already has ownership.
   * Resets only if the bridge process restarts.
   */
  claimedByBridge: boolean;
  /**
   * Snapshot of the session's live activity (sdk status, most recent
   * thinking text, pending-turns count). Optional — drivers that don't
   * track this leave it undefined and re-attaching clients just get the
   * regular live-event stream as it arrives.
   */
  getLiveActivity?(): {
    sdkStatus: SdkRunStatus;
    thinkingText: string | null;
    pendingTurns: number;
  };
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
