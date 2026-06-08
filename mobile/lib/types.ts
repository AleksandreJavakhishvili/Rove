// Mirror of the bridge's wire types. Keep in sync with bridge/src/types.ts.

export type AgentKind = 'claude-code' | 'codex' | 'aider' | (string & {});

export type SessionStatus = 'idle' | 'live-bridge' | 'live-desktop';

export interface SessionListItem {
  agent: AgentKind;
  id: string;
  cwd: string;
  projectName: string;
  /** User-set label (takes precedence over projectName as the displayed title). */
  label?: string;
  lastModified: number;
  preview: string;
  sizeBytes: number;
  status: SessionStatus;
  bridgePid?: number;
  desktopPids: number[];
}

export interface AgentMetadata {
  kind: AgentKind;
  displayName: string;
  available: boolean;
}

export type HistoryEntry =
  | {
      kind: 'user';
      uuid: string;
      parentUuid: string | null;
      timestamp: string;
      content: unknown;
      parentToolUseId?: string;
    }
  | {
      kind: 'assistant';
      uuid: string;
      parentUuid: string | null;
      timestamp: string;
      content: unknown;
      model?: string;
      parentToolUseId?: string;
    }
  | {
      kind: 'tool_use';
      uuid: string;
      parentUuid: string | null;
      timestamp: string;
      name: string;
      input: unknown;
      toolUseId: string;
      parentToolUseId?: string;
    }
  | {
      kind: 'tool_result';
      uuid: string;
      parentUuid: string | null;
      timestamp: string;
      toolUseId: string;
      content: unknown;
      isError?: boolean;
      parentToolUseId?: string;
    }
  | { kind: 'system'; uuid: string; timestamp: string; subtype: string; content?: unknown };

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/** Kind of a pending *user request* (the canUseTool gate pipeline). NOT the
 *  same as PermissionMode above. `permission` = allow/deny tool approval;
 *  `question` = an AskUserQuestion answered with a choice or free text.
 *  Mirror of the bridge's `RequestKind`. */
export type RequestKind = 'permission' | 'question';

/** Mirror of the bridge's `SdkRunStatus`. See bridge/src/agents/types.ts. */
export type SdkRunStatus = 'compacting' | 'requesting' | 'idle';
export const SDK_RUN_STATUS = {
  compacting: 'compacting',
  requesting: 'requesting',
  idle: 'idle',
} as const satisfies Record<SdkRunStatus, SdkRunStatus>;

/** Mirror of the bridge's `CompactTrigger`. */
export type CompactTrigger = 'manual' | 'auto';
export const COMPACT_TRIGGER = {
  manual: 'manual',
  auto: 'auto',
} as const satisfies Record<CompactTrigger, CompactTrigger>;

/** Mirror of the bridge's `CompactResult`. */
export type CompactResult = 'success' | 'failed';

/** Mirror of the bridge's `TreeEntryKind`. */
export type TreeEntryKind = 'file' | 'dir' | 'symlink';
export const TREE_ENTRY_KIND = {
  file: 'file',
  dir: 'dir',
  symlink: 'symlink',
} as const satisfies Record<TreeEntryKind, TreeEntryKind>;

/** Mirror of the bridge's `TreeEntry`. Paths are relative to session cwd
 *  and use POSIX separators on every platform. */
export interface TreeEntry {
  name: string;
  path: string;
  kind: TreeEntryKind;
  size?: number;
  modifiedMs?: number;
  gitIgnored?: boolean;
  hidden?: boolean;
}

/** Mirror of the bridge's `GitFileStatus`. */
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

export interface GitStatusEntry {
  path: string;
  renamedFrom?: string;
  indexStatus: GitFileStatus;
  worktreeStatus: GitFileStatus;
  isUntracked: boolean;
  isIgnored: boolean;
}

export interface GitStatusResult {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
  incomplete?: boolean;
}

/** Mirror of the bridge's `SearchHit`. */
export interface SearchHit {
  path: string;
  line: number;
  column: number;
  preview: string;
  matchStart: number;
  matchEnd: number;
}

/** Capability snapshot the bridge publishes on session attach. Mobile mirrors
 *  it into a per-(agent,sessionId) slice and gates chat-header controls,
 *  approval surfaces, and rewind/fork actions on the matching field. */
/** A selectable model, mirrored from the bridge. `value` → `set_model`;
 *  `label` is the human name; `description` summarizes capabilities. */
export interface ModelOption {
  value: string;
  label: string;
  description?: string;
}

export interface AgentCapabilities {
  agent: AgentKind;
  permissionPrompts: boolean;
  permissionModes: PermissionMode[] | null;
  modelSelection: { current: string; available: ModelOption[] } | null;
  fileCheckpointing: boolean;
  sessionForking: boolean;
  interrupt: boolean;
  /** Driver emits file_changed events itself. Required by the server today. */
  nativeFileChanges?: boolean;
  /** /tree endpoint supported — drives the @-mention picker and Files tab. */
  projectBrowser?: boolean;
  /** /git/status + /git/diff endpoints supported — drives the Files tab's git section. */
  gitStatus?: boolean;
  /** /search endpoint supported — drives the Files tab's search bar. */
  projectSearch?: boolean;
  /** Driver exposes the `take_screenshot` MCP tool — gates the agent-
   *  initiated capture path. The manual shutter is gated on the client's
   *  own capability (`clientCanCapture`) rather than this field; this
   *  flag governs whether the bridge will register the MCP tool. */
  screenshotCapture?: boolean;
  /** Slash commands the SDK advertised on init (no leading slash), incl.
   *  /workflow + any saved workflows. Drives the slash-command picker when
   *  present; falls back to a built-in list when undefined. */
  supportedCommands?: string[];
}

/** Background-task lifecycle, mirrored from the bridge. Workflow runs are the
 *  tasks with `taskType === 'local_workflow'` / a `workflowName`. */
export type WorkflowTaskPhase = 'started' | 'progress' | 'updated' | 'completed';
export type WorkflowTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'paused'
  | 'stopped';

export type AgentEvent =
  | { type: 'text'; role: 'assistant' | 'user'; text: string; messageId?: string; parentToolUseId?: string }
  | { type: 'text_delta'; role: 'assistant'; delta: string; messageId?: string; parentToolUseId?: string }
  | { type: 'tool_use'; toolUseId: string; name: string; input: unknown; parentToolUseId?: string }
  | { type: 'tool_result'; toolUseId: string; content: unknown; isError?: boolean; parentToolUseId?: string }
  | { type: 'user_request'; kind: RequestKind; toolUseId: string; tool: string; input: unknown; parentToolUseId?: string }
  | { type: 'permission_mode'; mode: PermissionMode }
  | { type: 'model'; model: string }
  | { type: 'rewind'; messageId: string; filesAffected: string[] }
  | { type: 'capabilities'; capabilities: AgentCapabilities }
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

export type ServerToClient =
  | { type: 'event'; event: AgentEvent }
  | { type: 'history_replay_start' }
  | { type: 'history_replay_end' }
  | { type: 'history_entry'; entry: HistoryEntry }
  | { type: 'status'; status: SessionStatus; pid?: number; pending?: number }
  | { type: 'error'; message: string }
  | { type: 'file_changed'; path: string; op: 'add' | 'change' | 'unlink' }
  | { type: 'session_busy'; pids: number[]; source: 'desktop' | 'other_bridge' }
  | { type: 'process_exit'; code: number | null; signal: NodeJS.Signals | null }
  // Visual-feedback-loop Phase 2: bridge asks the phone to capture its
  // PreviewPane WebView and reply with a `screenshot_result` frame
  // correlated by `requestId`.
  | {
      type: 'request_screenshot';
      requestId: string;
      path?: string;
      waitMs?: number;
    }
  // Preview-handoff Phase 1: bridge asks the user to set the preview
  // to a specific state. Phone replies with `prepare_preview_result`.
  | {
      type: 'prepare_preview_request';
      requestId: string;
      instructions: string;
      suggestedPath?: string;
      timeoutSeconds?: number;
    }
  // Rove Secrets: bridge asks the user to paste a credential into a
  // secure sheet (NOT the chat). The value comes back on `secret_provide`
  // and is written to `path` by the bridge; it never enters the SDK
  // stream / JSONL / model context. See `docs/sdd/2026-06-07-rove-secrets/`.
  | {
      type: 'secret_request';
      requestId: string;
      name: string;
      reason: string;
      path: string;
    };

/** Reasons a screenshot capture can fail. Mirrors the bridge constant
 *  in `bridge/src/agents/types.ts`. */
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

/** Mirror of the bridge's `HandoffResultStatus`. See preview-handoff
 *  SDD + `bridge/src/agents/types.ts`. */
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

/** Default cushion the handoff controller waits after a `ready` reply
 *  before exiting, so a follow-up `take_screenshot` can re-enter the
 *  takeover mode without flickering chrome. */
export const HANDOFF_TO_CAPTURE_GRACE_MS = 500;
/** Cross-fade duration on the handoff sheet ↔ pill transitions. */
export const HANDOFF_MODAL_FADE_MS = 250;
/** Cap on the optional skip-note the user attaches to a `skipped` reply. */
export const HANDOFF_NOTE_MAX_LEN = 400;

/** Rove Secrets — cap on the user-editable destination path in the secure
 *  sheet. Mirror of the bridge constant in `bridge/src/agents/types.ts`. */
export const SECRET_PATH_MAX_LEN = 256;

export interface ClientToServer {
  type:
    | 'user_message'
    // Resolve a pending user request (canUseTool gate pipeline):
    // `kind:'permission'` carries `decision`; `kind:'question'` carries
    // `answers` (the AskUserQuestion reply).
    | 'resolve_request'
    | 'interrupt'
    | 'ping'
    | 'set_mode'
    | 'set_model'
    | 'rewind_to'
    // Visual-feedback-loop Phase 2 — phone replies to a screenshot
    // request, or flips the per-session allow toggle.
    | 'screenshot_result'
    | 'set_screenshot_allow'
    // Preview-takeover Phase 0 — phone mirrors the global
    // `enableVisualFeedback` setting up to the bridge so the
    // `take_screenshot` / `prepare_preview` MCP tools can short-
    // circuit before any WS round-trip when the master switch is off.
    | 'set_visual_feedback_enabled'
    // Preview-handoff Phase 1 — phone's reply to a `prepare_preview`
    // request. `status` carries the user's decision.
    | 'prepare_preview_result'
    // Rove Secrets — phone's reply to a `secret_request`. `secret_provide`
    // carries the pasted `value` (+ optional user-edited `path`) on a side
    // channel that never becomes a `user_message`; `secret_deny` declines.
    | 'secret_provide'
    | 'secret_deny';
  content?: string;
  toolUseId?: string;
  decision?: 'allow' | 'allow_always' | 'deny';
  // `resolve_request` fields. `kind` discriminates the resolution; `answers`
  // carries the AskUserQuestion reply (question text → chosen label(s) / free text).
  kind?: RequestKind;
  answers?: Record<string, string>;
  mode?: PermissionMode;
  model?: string;
  messageId?: string;
  // screenshot_result fields. uploadId present iff ok=true; reason
  // present iff ok=false. Also carries the optional resolvedUrl echo
  // (preview-takeover Phase 2).
  requestId?: string;
  ok?: boolean;
  uploadId?: string;
  reason?: ScreenshotErrorReason;
  resolvedUrl?: string;
  // set_screenshot_allow field.
  allow?: boolean;
  // set_visual_feedback_enabled field.
  enabled?: boolean;
  // prepare_preview_result fields. `status` is required; `finalUrl` +
  // `note` are only meaningful when status is ready/skipped.
  status?: HandoffResultStatus;
  finalUrl?: string;
  note?: string;
  // Rove Secrets — `secret_provide` carries the pasted `value` (+ optional
  // user-edited `path`); `secret_deny` carries only `requestId` (above).
  // `value` exists ONLY on the outbound `secret_provide` frame.
  value?: string;
  path?: string;
}

export interface DevServerCandidate {
  port: number;
  pid: number;
  bindAddress: string;
  framework: string | null;
  command: string;
  reachable: boolean;
  url: string | null;
  note?: string;
}

export interface PreviewResponse {
  hostname: string;
  candidates: DevServerCandidate[];
}
