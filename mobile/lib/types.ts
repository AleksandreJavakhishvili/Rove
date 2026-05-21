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

/** Capability snapshot the bridge publishes on session attach. Mobile mirrors
 *  it into a per-(agent,sessionId) slice and gates chat-header controls,
 *  approval surfaces, and rewind/fork actions on the matching field. */
export interface AgentCapabilities {
  agent: AgentKind;
  permissionPrompts: boolean;
  permissionModes: PermissionMode[] | null;
  modelSelection: { current: string; available: string[] } | null;
  fileCheckpointing: boolean;
  sessionForking: boolean;
  interrupt: boolean;
}

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

export type ServerToClient =
  | { type: 'event'; event: AgentEvent }
  | { type: 'history_replay_start' }
  | { type: 'history_replay_end' }
  | { type: 'history_entry'; entry: HistoryEntry }
  | { type: 'status'; status: SessionStatus; pid?: number }
  | { type: 'error'; message: string }
  | { type: 'file_changed'; path: string; op: 'add' | 'change' | 'unlink' }
  | { type: 'session_busy'; pids: number[]; source: 'desktop' | 'other_bridge' }
  | { type: 'process_exit'; code: number | null; signal: NodeJS.Signals | null };

export interface ClientToServer {
  type:
    | 'user_message'
    | 'approval'
    | 'interrupt'
    | 'ping'
    | 'set_mode'
    | 'set_model'
    | 'rewind_to';
  content?: string;
  toolUseId?: string;
  decision?: 'allow' | 'allow_always' | 'deny';
  mode?: PermissionMode;
  model?: string;
  messageId?: string;
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
