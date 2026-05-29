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
 * Background-task lifecycle, surfaced by the SDK's `task_*` system messages
 * (SDKTaskStarted/Progress/Updated/Notification). The Claude 4.8 `/workflow`
 * feature rides on these: a workflow run is a background task with
 * `taskType === 'local_workflow'` and a `workflowName` (the `meta.name` from
 * the workflow script). We normalize all four subtypes into one
 * `workflow_task` AgentEvent keyed by `taskId`; clients merge updates by id.
 */
export type WorkflowTaskPhase = 'started' | 'progress' | 'updated' | 'completed';
export type WorkflowTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'paused'
  | 'stopped';

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
/** A selectable model, mirrored from the SDK's `ModelInfo`. `value` is the id
 *  sent to `setModel`; `label` is the human name; `description` summarizes the
 *  model (e.g. "Smartest model for complex tasks"). Alias entries like
 *  `default` resolve to a concrete model the description spells out. */
export interface ModelOption {
  value: string;
  label: string;
  description?: string;
}

export interface AgentCapabilities {
  /** Agent identifier — used by mobile to pick the right tool card pack. */
  agent: AgentKind;
  /** Does this agent ever prompt the user for tool permission? */
  permissionPrompts: boolean;
  /** Permission modes the agent supports; null/empty → no mode picker. */
  permissionModes: readonly PermissionMode[] | null;
  /** Current model + selectable models; null → no model picker. `current` is
   *  the active model's `value` (matches one of `available[].value` once the
   *  list loads). Each option carries a human label + capability description
   *  from the SDK so the picker can show "what is this / what's the default". */
  modelSelection: {
    current: string;
    available: readonly ModelOption[];
  } | null;
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
  /**
   * Driver exposes the `take_screenshot` MCP tool to the agent. When
   * true, the agent can request a capture of the mobile client's live
   * preview WebView at any point during a turn; the bridge brokers the
   * round-trip and returns an image content block in the tool result.
   * Reported false by drivers that can't host MCP tools or when image-
   * modality input isn't supported by the agent.
   */
  screenshotCapture?: boolean;
  /**
   * Slash commands the SDK advertises on its `init` message (e.g.
   * `compact`, `model`, `workflow`, plus any saved workflows / custom
   * commands), WITHOUT the leading slash. Mobile's slash-command picker
   * is driven from this when present, falling back to a built-in list.
   * Undefined when the driver can't enumerate commands.
   */
  supportedCommands?: string[];
}

/**
 * Reasons a screenshot capture request can fail. Used by the visual-
 * feedback-loop wire frames + the take_screenshot MCP tool's text-
 * content fallback so the agent can pattern-match on the cause.
 *
 * Conventions:
 *  - `no_client`         — no mobile client attached / web client.
 *  - `disabled_by_user`  — per-session toggle is off.
 *  - `permission_denied` — user denied the MCP tool via canUseTool.
 *  - `rate_limited`      — request exceeds the per-session token bucket.
 *  - `timeout`           — client failed to respond within the budget.
 *  - `not_mounted`       — phone has no PreviewPane mounted right now.
 *  - `capture_failed`    — captureRef threw on the phone.
 *  - `upload_failed`     — phone-side upload pipeline rejected.
 *  - `cancelled`         — session disconnected mid-request.
 *  - `unsupported`       — running on a platform that can't capture
 *                          (e.g., the web client).
 */
export type ScreenshotErrorReason =
  | 'no_client'
  | 'disabled_by_user'
  | 'permission_denied'
  | 'rate_limited'
  | 'timeout'
  | 'not_mounted'
  | 'capture_failed'
  | 'upload_failed'
  | 'cancelled'
  | 'unsupported';

export const SCREENSHOT_ERROR_REASON = {
  no_client: 'no_client',
  disabled_by_user: 'disabled_by_user',
  permission_denied: 'permission_denied',
  rate_limited: 'rate_limited',
  timeout: 'timeout',
  not_mounted: 'not_mounted',
  capture_failed: 'capture_failed',
  upload_failed: 'upload_failed',
  cancelled: 'cancelled',
  unsupported: 'unsupported',
} as const satisfies Record<ScreenshotErrorReason, ScreenshotErrorReason>;

/** Tuple form of {@link SCREENSHOT_ERROR_REASON} for runtime validators
 *  (Zod, JSON schema generators, …) that need an enum-array shape.
 *  Single source of truth — bumped automatically as new reasons are
 *  added to the const above. */
export const SCREENSHOT_ERROR_REASONS = Object.values(
  SCREENSHOT_ERROR_REASON,
) as readonly ScreenshotErrorReason[];

/** Maximum value the broker / SDK driver accept for the `waitMs`
 *  argument on `take_screenshot`. Semantics: this is the *upper bound*
 *  on how long the phone will wait for the page to become ready
 *  (document.readyState complete + idle + painted) before capturing.
 *  A fast page captures sooner; a slow page captures at the cap.
 *  15s accommodates Next.js cold starts and other slow-to-hydrate
 *  dev servers while still bounding worst-case latency. */
export const SCREENSHOT_WAIT_MS_CAP = 15_000;
/** Default `waitMs` when the agent doesn't specify one. Generous
 *  enough that a typical SPA hydrate finishes in time; the
 *  ready-state probe still resolves earlier on fast pages. */
export const SCREENSHOT_DEFAULT_WAIT_MS = 3_000;
/** End-to-end timeout for the bridge↔phone↔bridge round-trip. Must
 *  be larger than `SCREENSHOT_WAIT_MS_CAP` plus capture + upload time,
 *  otherwise the broker times out before a slow page can be captured. */
export const SCREENSHOT_REQUEST_TIMEOUT_MS = 30_000;
/** MCP tool surface — kept here so the bridge driver, the mobile
 *  permission-prompt label lookup, and any future approval UI all
 *  reference the same identifiers. */
export const SCREENSHOT_MCP_TOOL_NAME = 'take_screenshot';
export const SCREENSHOT_MCP_SERVER_NAME = 'rove';
export const SCREENSHOT_MCP_SERVER_VERSION = '0.1.0';
/** Full namespaced name the SDK emits to canUseTool — what the mobile
 *  approval sheet receives. Matches the SDK's `mcp__<server>__<tool>`
 *  convention. */
export const SCREENSHOT_MCP_TOOL_QUALIFIED =
  `mcp__${SCREENSHOT_MCP_SERVER_NAME}__${SCREENSHOT_MCP_TOOL_NAME}` as const;

/** Preview-takeover Phase 2 — prefix on the text content block the
 *  `take_screenshot` MCP tool returns alongside the image so the agent
 *  can read the WebView's final URL with a stable, machine-friendly
 *  marker. Format: `<prefix><url>` (or `(unknown)` when the phone
 *  couldn't determine the URL). */
export const SCREENSHOT_RESOLVED_URL_PREFIX = 'resolved_url: ';
/** Sentinel rendered after the prefix when the phone didn't supply
 *  `resolvedUrl`. Keeps the line shape consistent (always
 *  `resolved_url: <something>`) so a string-matching agent can parse
 *  it without checking for missing data. */
export const SCREENSHOT_RESOLVED_URL_UNKNOWN = '(unknown)';

/* -------------------------------------------------------------------
 *  Preview-handoff (`prepare_preview`) — agent asks the user to set up
 *  the preview state (log in, navigate, …) before the agent can
 *  verify visually. See `docs/sdd/2026-05-25-preview-handoff/`.
 * ------------------------------------------------------------------ */

/**
 * Statuses the user can return from a `prepare_preview` round-trip.
 *  - `ready`     — user got the preview to the requested state.
 *  - `skipped`   — user opted out (preview was already there, or the
 *                  agent can do without it). Optional free-text note.
 *  - `cancelled` — user explicitly cancelled the request (or the
 *                  session disconnected / app backgrounded).
 *  - `timeout`   — broker fired the timeout before the user replied.
 *  - `disabled_by_user` — global setting / per-session toggle is off.
 *  - `no_client` — no mobile client attached to this session.
 *  - `rate_limited` — too many handoffs in the rate-limit window.
 */
export type HandoffResultStatus =
  | 'ready'
  | 'skipped'
  | 'cancelled'
  | 'timeout'
  | 'disabled_by_user'
  | 'no_client'
  | 'rate_limited';

export const HANDOFF_RESULT_STATUS = {
  ready: 'ready',
  skipped: 'skipped',
  cancelled: 'cancelled',
  timeout: 'timeout',
  disabled_by_user: 'disabled_by_user',
  no_client: 'no_client',
  rate_limited: 'rate_limited',
} as const satisfies Record<HandoffResultStatus, HandoffResultStatus>;

/** Tuple form for Zod's `z.enum(...)`. */
export const HANDOFF_RESULT_STATUSES = Object.values(
  HANDOFF_RESULT_STATUS,
) as readonly HandoffResultStatus[];

/** MCP tool surface — paired with `SCREENSHOT_MCP_*` so the two visual-
 *  feedback tools share one server. */
export const PREPARE_PREVIEW_MCP_TOOL_NAME = 'prepare_preview';
export const PREPARE_PREVIEW_MCP_TOOL_QUALIFIED =
  `mcp__${SCREENSHOT_MCP_SERVER_NAME}__${PREPARE_PREVIEW_MCP_TOOL_NAME}` as const;

/** Default time the broker waits for a user reply before resolving
 *  with `timeout`. Generous so the user has time to find their
 *  password / two-factor device. */
export const HANDOFF_DEFAULT_TIMEOUT_SECONDS = 5 * 60;
/** Upper bound the agent can request via `timeoutSeconds`. */
export const HANDOFF_MAX_TIMEOUT_SECONDS = 15 * 60;
/** Cap on the `instructions` argument — keeps the modal body readable
 *  and prevents an adversarial agent from flooding the UI. */
export const HANDOFF_INSTRUCTIONS_MAX_LEN = 800;
/** Cap on the optional `note` the user can attach to a `skipped` reply. */
export const HANDOFF_NOTE_MAX_LEN = 400;
/** Cross-direction grace window: after the user taps Done on a
 *  handoff, the controller stays mounted for this long so a
 *  follow-up `take_screenshot` can re-enter `engaging` directly
 *  without an exit-then-re-engage flicker. */
export const HANDOFF_TO_CAPTURE_GRACE_MS = 500;
/** Sheet ↔ pill cross-fade duration. */
export const HANDOFF_MODAL_FADE_MS = 250;
/** End-to-end timeout for the bridge↔phone↔bridge handoff round-trip.
 *  Derived from `HANDOFF_DEFAULT_TIMEOUT_SECONDS` * 1000; named so
 *  the broker doesn't sprinkle `* 1000` arithmetic. */
export const HANDOFF_DEFAULT_TIMEOUT_MS = HANDOFF_DEFAULT_TIMEOUT_SECONDS * 1000;

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
  | {
      type: 'workflow_task';
      phase: WorkflowTaskPhase;
      taskId: string;
      taskType?: string;
      workflowName?: string;
      subagentType?: string;
      status?: WorkflowTaskStatus;
      description?: string;
      summary?: string;
      skipTranscript?: boolean;
    }
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
