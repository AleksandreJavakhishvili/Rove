# Wire protocol

The bridge ↔ mobile contract. If you're adding a new agent driver, **this is the only schema your driver needs to produce.**

The canonical TypeScript types live in:
- [`bridge/src/types.ts`](../bridge/src/types.ts)
- [`bridge/src/agents/types.ts`](../bridge/src/agents/types.ts)
- [`mobile/lib/types.ts`](../mobile/lib/types.ts) (mirror)

## REST endpoints (HTTP)

### `GET /health`
Returns `{ok: true, user, host, port}`. Auth required.

### `GET /agents`
Returns `{agents: [{kind, displayName, available}]}` — the drivers registered in the bridge and whether each has its CLI available.

### `GET /sessions`
Returns `{sessions: SessionListItem[]}`. Cross-agent, sorted by recency.

```ts
interface SessionListItem {
  agent: AgentKind;
  id: string;
  cwd: string;
  projectName: string;
  lastModified: number;
  preview: string;
  sizeBytes: number;
  status: 'idle' | 'live-bridge' | 'live-desktop';
  bridgePid?: number;
  desktopPids: number[];
}
```

### `GET /sessions/:agent/:id/history?limit=N&before=ISO`
Paginated history page. Entries are **oldest-first** (chronological).

Response:
```ts
{
  agent: AgentKind;
  id: string;
  cwd: string;
  entries: HistoryEntry[];
  cursor: { before: string | null; hasMore: boolean };
}
```

Pagination: pass `before` = oldest entry's timestamp from the current page to get the next older page. `hasMore: true` when `entries.length === limit`.

### `POST /sessions/:agent/:id/interrupt`
SIGINT the live subprocess. Returns `{ok: true|false}`.

### `POST /sessions/:agent/:id/takeover`
Verifies foreign PIDs holding the session are actually agent processes, SIGTERMs them (escalating to SIGKILL after 5s), then returns control to the bridge. Returns `{ok, killed: number[], force?: boolean}`.

### `GET /sessions/:agent/:id/file?path=<...>`
Read a file under the session's cwd. Path-traversal guarded, 512KB cap. Response: `{path, rel, size, truncated, contents}`.

### `GET /sessions/:agent/:id/diff`
Cumulative diff from the session's baseline (HEAD at first spawn) to the current working tree. Response: `{agent, id, cwd, baseline, files: ParsedDiffFile[]}` — see `bridge/src/git.ts` for the file/hunk shape.

### `POST /internal/permission` (internal)
The MCP permission-prompt server posts here with `{agent, sessionId, toolUseId, tool, input}` and an `X-Bridge-Internal-Token` header. Bridge forwards to the WS, awaits the user's decision, returns `{behavior: 'allow', updatedInput} | {behavior: 'deny', message}`.

## WebSocket: `/sessions/:agent/:id/stream`

Bidirectional, line-delimited JSON (each frame is a JSON object).

### Server → client frames

```ts
type ServerToClient =
  | { type: 'history_replay_start' }
  | { type: 'history_entry'; entry: HistoryEntry }
  | { type: 'history_replay_end' }
  | { type: 'status'; status: SessionStatus; pid?: number }
  | { type: 'event'; event: AgentEvent }              // live activity
  | { type: 'file_changed'; path: string; op: 'add' | 'change' | 'unlink' }
  | { type: 'session_busy'; pids: number[]; source: 'desktop' | 'other_bridge' }
  | { type: 'process_exit'; code: number | null; signal: NodeJS.Signals | null }
  | { type: 'error'; message: string };
```

Lifecycle on connect:
1. `history_replay_start` — clear local item list.
2. `history_entry` × N — most recent N history entries, **oldest-first**.
3. `history_replay_end` — replay done.
4. `status` — current subprocess state.
5. (Then live events as they occur.)

### Client → server frames

```ts
type ClientToServer =
  | { type: 'user_message'; content: string }
  | { type: 'approval'; toolUseId: string; decision: 'allow' | 'allow_always' | 'deny' }
  | { type: 'interrupt' }
  | { type: 'ping' };
```

(The full unions also carry the visual-feedback / preview-handoff frames
and the secrets frames below — see `bridge/src/types.ts` for the canonical
list.)

### Rove Secrets round-trip (`set_secret`)

When the agent calls the `mcp__rove__set_secret` tool, the bridge asks the
user to paste a credential into a **secure sheet** (never the chat). The
value rides a dedicated side channel and is written to disk by the bridge —
it never becomes a `user_message`, so it never reaches the SDK stream or the
session JSONL, and the model only ever receives a value-hidden confirmation.
See `docs/sdd/2026-06-07-rove-secrets/`.

```ts
// Server → client
| {
    type: 'secret_request';
    requestId: string;   // correlates the reply
    name: string;        // env-var name, e.g. OPENAI_API_KEY
    reason: string;      // shown verbatim in the sheet
    path: string;        // resolved default destination (cwd-relative); user-editable
  }

// Client → server
| { type: 'secret_provide'; requestId: string; value: string; path?: string }  // value: side-channel only
| { type: 'secret_deny'; requestId: string }
```

Flow: `secret_request` → user pastes → `secret_provide` → bridge writes
`NAME=value` into `path` (default `.env`, confined to the session cwd,
auto-gitignored) → tool result to the agent is `ok:` / `denied:` /
`timeout:` / `no_client:` / `error:` (value-hidden). `secret_deny` resolves
the tool non-fatally so the agent can adapt.

## `HistoryEntry` — persisted past

These come back during history replay. Drivers parse their session files into this shape:

```ts
type HistoryEntry =
  | { kind: 'user';     uuid; parentUuid; timestamp; content }
  | { kind: 'assistant';uuid; parentUuid; timestamp; content; model? }
  | { kind: 'tool_use'; uuid; parentUuid; timestamp; name; input; toolUseId }
  | { kind: 'tool_result'; uuid; parentUuid; timestamp; toolUseId; content; isError? }
  | { kind: 'system';   uuid; timestamp; subtype; content? };
```

`content` for `user` / `assistant` / `tool_result` can be a string (preferred) or a nested object (will be rendered via `JSON.stringify`). Drivers should produce strings when possible.

## `AgentEvent` — live activity

These come over WebSocket as the subprocess runs. **This is what your driver's parser must emit.**

```ts
type AgentEvent =
  | { type: 'text';       role: 'assistant' | 'user'; text: string; messageId? }
  | { type: 'text_delta'; role: 'assistant'; delta: string; messageId? }
  | { type: 'tool_use';   toolUseId; name; input }
  | { type: 'tool_result'; toolUseId; content; isError? }
  | { type: 'permission_request'; toolUseId; tool; input }
  | { type: 'result';     subtype; durationMs?; usage? }
  | { type: 'thinking';   text }
  | { type: 'raw';        payload };
```

Notes for driver implementers:

- **Use `text_delta` for streaming chunks**, `text` for the final complete message of a turn. The mobile renderer merges `text_delta` into a streaming bubble, then replaces the bubble's content with the final `text` payload (avoids duplicate bubbles).
- **`role: 'user'` text events are suppressed on mobile** — the phone already inserted the user message optimistically on send.
- **Unknown/unmapped output → `raw`.** The mobile UI skips `raw` events, so they're a safe escape hatch. Don't lose data, just emit it as raw and add proper mapping later.
- **`thinking` is invisible on mobile by default** but the mobile app could expose it as a "Claude is thinking…" indicator if you want.
- **`permission_request` is what triggers the approval modal.** For Claude Code, this comes via the MCP permission-prompt server (see `bridge/src/permissions.ts`). For other agents you'd implement the equivalent path.
- **`result.subtype === 'success'` is the happy-path "turn complete" signal.** Anything else (`error_during_execution`, `error_max_turns`, etc.) is rendered as a meta-line on mobile.

## Adding a driver — checklist

1. Implement `AgentDriver` (`bridge/src/agents/types.ts`):
   - `listSessions()` — discover sessions on disk for your agent.
   - `findSession(id)` — look up a specific session.
   - `readHistory(id, {limit, before})` — stream-parse the session file, return last N `HistoryEntry`s (oldest-first).
   - `createSession(id, cwd)` — return an `AgentSession` that wraps the subprocess.
   - `getDesktopPids(id)` — find any agent processes already running on the session (for single-writer guard).
   - `isAvailable()` — quick check that the agent's CLI is installed/usable.
2. Implement `AgentSession` (also `bridge/src/agents/types.ts`):
   - `spawnIfNeeded()` — launch the CLI in headless mode.
   - `sendUserMessage(content)` — feed a user turn via stdin (whatever the CLI's stream-input format is).
   - `sendApproval(toolUseId, decision)` — for agents that support approval IPC.
   - `interrupt()` — SIGINT the subprocess.
   - `shutdown()` — graceful SIGTERM → SIGKILL.
   - Emit `event` / `exit` / `spawn` / `error` via EventEmitter; the bridge subscribes and broadcasts to WebSocket clients.
3. Translate the agent's per-line output into `AgentEvent`s. Use `{type: 'raw', payload}` for anything you don't yet know how to map.
4. Register the driver in `bridge/src/agents/registry.ts`.
5. Optional: add tool-card cases in `mobile/components/chat/ToolCard.tsx` for the agent's distinctive tool names. The default case already renders something useful.

See `bridge/src/agents/claudeCode.ts` for the fully-worked reference implementation.
