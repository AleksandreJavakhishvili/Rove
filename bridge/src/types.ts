import type {
  AgentEvent,
  AgentKind,
  HandoffResultStatus,
  PermissionMode,
  ScreenshotErrorReason,
} from './agents/types.ts';

export type SessionStatus = 'idle' | 'live-bridge' | 'live-desktop';

export interface SessionListItem {
  agent: AgentKind;
  id: string;
  cwd: string;
  projectName: string;
  /** User-set label (overrides projectName as the displayed title when present). */
  label?: string;
  lastModified: number;
  preview: string;
  sizeBytes: number;
  status: SessionStatus;
  /** PID of bridge subprocess if we're running it. */
  bridgePid?: number;
  /** PIDs holding the session file open from outside the bridge (e.g., desktop `claude`). */
  desktopPids: number[];
}

export type HistoryEntry =
  | { kind: 'user'; uuid: string; parentUuid: string | null; timestamp: string; content: unknown; parentToolUseId?: string }
  | { kind: 'assistant'; uuid: string; parentUuid: string | null; timestamp: string; content: unknown; model?: string; parentToolUseId?: string }
  | { kind: 'tool_use'; uuid: string; parentUuid: string | null; timestamp: string; name: string; input: unknown; toolUseId: string; parentToolUseId?: string }
  | { kind: 'tool_result'; uuid: string; parentUuid: string | null; timestamp: string; toolUseId: string; content: unknown; isError?: boolean; parentToolUseId?: string }
  | { kind: 'system'; uuid: string; timestamp: string; subtype: string; content?: unknown };

export interface ClientToServer {
  type:
    | 'user_message'
    | 'approval'
    | 'interrupt'
    | 'ping'
    | 'set_mode'
    | 'set_model'
    | 'rewind_to'
    // Visual-feedback-loop Phase 2: client → server replies for the
    // bridge-initiated screenshot round-trip and the per-session toggle.
    | 'screenshot_result'
    | 'set_screenshot_allow'
    // Preview-takeover Phase 0: phone mirrors the global
    // `enableVisualFeedback` setting up to the bridge so the
    // `take_screenshot` / `prepare_preview` MCP tools can short-
    // circuit before any WS round-trip when the master switch is off.
    | 'set_visual_feedback_enabled'
    // Preview-handoff Phase 1: phone replies to a `prepare_preview`
    // round-trip with the user's decision + optional `finalUrl` / note.
    | 'prepare_preview_result';
  content?: string;
  toolUseId?: string;
  decision?: 'allow' | 'allow_always' | 'deny';
  mode?: PermissionMode;
  model?: string;
  messageId?: string;
  // Screenshot round-trip (server → client → server) — only set when
  // `type === 'screenshot_result'`. `requestId` echoes the value the
  // bridge sent in `request_screenshot`; `ok` distinguishes the success
  // (uploadId present) and failure (reason present) variants.
  requestId?: string;
  ok?: boolean;
  uploadId?: string;
  reason?: ScreenshotErrorReason;
  /** Preview-takeover Phase 2: WebView's final URL after capture (best-
   *  effort). Surfaced to the agent as a `resolved_url: …` text block
   *  so redirects (auth, 404) are observable without parsing pixels. */
  resolvedUrl?: string;
  // Per-session "allow autonomous screenshots" toggle — only set when
  // `type === 'set_screenshot_allow'`.
  allow?: boolean;
  // `set_visual_feedback_enabled` field — preview-takeover Phase 0.
  enabled?: boolean;
  // `prepare_preview_result` fields — preview-handoff Phase 1.
  status?: HandoffResultStatus;
  finalUrl?: string;
  note?: string;
}

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
  // Visual-feedback-loop Phase 2: bridge → client request that the
  // phone capture its PreviewPane WebView and reply with a
  // `screenshot_result` frame correlated by `requestId`.
  | {
      type: 'request_screenshot';
      requestId: string;
      /** Optional dev-server-relative path to navigate to first. */
      path?: string;
      /** Upper bound on the post-navigation settle time (clamped 0–2000). */
      waitMs?: number;
    }
  // Preview-handoff Phase 1: bridge → client request that the user
  // set the preview to a specific state (log in, navigate to /admin,
  // etc.) before the agent can verify. Phone replies with
  // `prepare_preview_result`.
  | {
      type: 'prepare_preview_request';
      requestId: string;
      instructions: string;
      suggestedPath?: string;
      timeoutSeconds?: number;
    };
