import type { AgentEvent, AgentKind, PermissionMode } from './agents/types.ts';

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
    | 'rewind_to';
  content?: string;
  toolUseId?: string;
  decision?: 'allow' | 'allow_always' | 'deny';
  mode?: PermissionMode;
  model?: string;
  messageId?: string;
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
  | { type: 'process_exit'; code: number | null; signal: NodeJS.Signals | null };
