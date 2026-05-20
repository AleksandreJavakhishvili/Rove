# High-Level Architecture — SDK Driver Migration

**Status (2026-05-21):** all phases below are implemented; see
[plan.md](./plan.md) for the per-phase status table. The
"Removed from today's topology" list under [Target topology](#target-topology)
is now actually removed from the repo — the section below describes
the live shape.

## Context

**Historical** — the bridge previously routed mobile clients to one of
two `AgentDriver`s for the only supported agent (`claude-code`):

- **CLI driver** (`bridge/src/agents/claudeCode.ts`) — default. Spawns
  the `claude` CLI as a child process. Permission prompts loop through a
  separate MCP subprocess that POSTs back to the bridge.
- **SDK driver** (`bridge/src/agents/claudeCodeSdk.ts`) — opt-in via
  `CLAUDE_DRIVER=sdk`. Uses `@anthropic-ai/claude-agent-sdk`'s `query()`
  with `canUseTool`. Both paths share `requestPermissionFromUser` in
  `bridge/src/permissions.ts` so the cross-session approval registry
  behavior is identical.

Mobile (`mobile/`) talks to either driver through the same WebSocket
protocol (`/sessions/:agent/:id/stream` + bridge-wide `/events`).

## Architectural pillars

This migration commits to three pillars. All architecture decisions
that follow defer to them:

1. **One transport for claude-code.** SDK only. The CLI driver, MCP
   subprocess, internal HTTP loopback, and bridge-side file watcher go
   away.
2. **The agent abstraction is real, not aspirational.** Anything
   agent-specific lives inside the driver, the capability payload, or a
   per-agent UI card pack. The bridge's HTTP/WS layer, the permissions
   registry, the sessions list, the chat container, and the approval
   UI all speak in agent-neutral terms.
3. **Capabilities are first-class.** A session declares what it supports
   on attach; the UI renders only what's declared. No code path in
   bridge or mobile uses `agent === 'claude-code'` as a feature switch.

## Target topology

```
                  ┌─────────────────────────────────┐
                  │   mobile (Expo / RN)            │
                  │   - sessions list               │
                  │   - chat container (neutral)    │
                  │   - card pack registry          │
                  │     ├─ claude-code pack         │
                  │     └─ generic fallback         │
                  │   - capabilities slice (per     │
                  │     session)                    │
                  │   - approval surfaces (gated)   │
                  └──────┬──────────────────────────┘
                         │ WS /sessions/:agent/:id/stream
                         │ WS /events
                         │ HTTP /sessions, /permissions/pending, …
                         ▼
        ┌──────────────────────────────────────────────┐
        │  bridge (Hono + node-ws)                     │
        │                                              │
        │  server.ts                                   │
        │  ├── /sessions/:agent/:id/stream             │
        │  │     emits `capabilities` on attach        │
        │  │     accepts set_mode | set_model |        │
        │  │     rewind_to | fork (all routed to       │
        │  │     optional AgentSession methods)        │
        │  ├── /events  (cross-session permission bus) │
        │  ├── /sessions, /diff, /file, /fork, …       │
        │  └── (no /internal/permission)               │
        │                                              │
        │  permissions.ts                              │
        │  ├── registry (agent-neutral)                │
        │  └── requestPermissionFromUser               │
        │                                              │
        │  agents/                                     │
        │  ├── types.ts                                │
        │  │     AgentSession, AgentDriver,            │
        │  │     AgentCapabilities, optional methods   │
        │  ├── registry.ts                             │
        │  │     register({ kind, driver })            │
        │  ├── claudeCodeSdk.ts   (the only Claude     │
        │  │     driver — full SDK use for query AND   │
        │  │     session mgmt: listSessions,           │
        │  │     getSessionInfo, getSessionMessages,   │
        │  │     forkSession, canUseTool, setModel,    │
        │  │     rewindFiles, FileChanged hook,        │
        │  │     SDK background tasks)                 │
        │  ├── desktopPids.ts (ps-scan, only thing the │
        │  │     SDK can't do)                         │
        │  └── (codexDriver.ts later, same shape)      │
        └───────────┬──────────────────────────────────┘
                    │ SDK in-process (claude-code)
                    ▼
        ┌────────────────────────┐
        │ @anthropic-ai/         │
        │ claude-agent-sdk       │
        │ (Query iterator)       │
        └────────────────────────┘
                    │
                    ▼
        ~/.claude/projects/<slug>/<id>.jsonl
        ~/.claude/settings.local.json
```

Removed from today's topology:

- `bridge/src/agents/claudeCode.ts` (CLI driver)
- `bridge/src/mcp/` (permission-server.ts + launch plumbing)
- `bridge/src/watcher.ts` + `chokidar` dependency
- `/internal/permission` HTTP endpoint
- `CLAUDE_DRIVER` env var
- All hand-rolled claude-code JSONL parsing (`peekFirstEntries`,
  `entryFromRaw`, `decodeProjectDir`, `listClaudeSessions`,
  `findClaudeSession`, `readClaudeHistory`)
- `permissions.appendAllowRule()` — SDK writes the rule when
  `canUseTool` returns `updatedPermissions`

## Components

### Bridge — driver abstraction (`bridge/src/agents/types.ts`)

The interface grows to carry agent capability and optional methods.
Both are how the abstraction "earns" its right to exist.

```ts
type AgentKind = 'claude-code' | 'codex' | (string & {});

interface AgentCapabilities {
  /** Agent identifier — used by mobile to pick the right tool card pack. */
  agent: AgentKind;
  /** Does this agent ever prompt the user for tool permission? */
  permissionPrompts: boolean;
  /** Permission modes the agent supports; null/empty → no mode picker. */
  permissionModes: PermissionMode[] | null;
  /** Current model + list of selectable models; null → no model picker. */
  modelSelection: { current: string; available: string[] } | null;
  /** Per-message file-checkpoint restore. */
  fileCheckpointing: boolean;
  /** Branch the session into a new one at a given point. */
  sessionForking: boolean;
  /** Graceful interrupt of the current turn. */
  interrupt: boolean;
}

interface AgentSession {
  // existing core: agent, sessionId, cwd, alive, pid, baselineSha,
  // subscribers, lastActivity, sendUserMessage, sendApproval,
  // interrupt, shutdown, spawnIfNeeded, event/exit emitter

  /** Snapshot of what this session supports right now. */
  capabilities(): AgentCapabilities;

  // Optional control methods. Drivers leave them undefined when the
  // matching capability is false; the server only invokes them when the
  // capability says it's safe.
  setMode?(mode: PermissionMode): void;
  setModel?(model: string): void;
  rewindTo?(messageId: string): Promise<{ messageId: string; filesAffected: string[] }>;
  fork?(opts?: { atMessage?: string }): Promise<{ sessionId: string }>;
}
```

Drivers declare capability and implement only what they support. The
server uses the capability snapshot to decide which messages to route
where.

### Bridge — driver layer (`bridge/src/agents/`)

#### `claudeCodeSdk.ts` (existing, evolved)

`ClaudeCodeSdkDriver` + `ClaudeCodeSdkSession`. After Phase 1 it
implements `AgentDriver` directly (no `extends ClaudeCodeDriver`) and
delegates **everything claude-specific** to the SDK:

| `AgentDriver` method            | Implementation                                |
| ------------------------------- | --------------------------------------------- |
| `listSessions()`                | SDK `listSessions()` → map to our list shape  |
| `findSession(id)`               | SDK `getSessionInfo(id)`                      |
| `readHistory(id, opts)`         | SDK `getSessionMessages(id, opts)` → remap to `HistoryEntry[]` |
| `isAvailable()`                 | check `~/.claude/` exists (no SDK equivalent) |
| `getDesktopPids(id)`            | `desktopPids.ts` (ps-scan, see below)         |
| `createSession(id, cwd)`        | `new ClaudeCodeSdkSession(id, cwd)`           |

| `AgentSession` method           | Implementation                                |
| ------------------------------- | --------------------------------------------- |
| `sendUserMessage(content)`      | push onto the SDK `Query` streaming input     |
| `sendApproval(...)`             | no-op (`canUseTool` handles approvals)        |
| `interrupt()`                   | `Query.interrupt()`                           |
| `setMode(mode)`                 | `Query.setPermissionMode(mode)` (live)        |
| `setModel(model)`               | `Query.setModel(model)` (live)                |
| `rewindTo(messageId)`           | `Query.rewindFiles({ messageId })`            |
| `fork({ atMessage? })`          | SDK `forkSession(id, ...)`                    |
| `shutdown()`                    | `Query.interrupt()` + end input stream        |

Capabilities reported:

```
{
  agent: 'claude-code',
  permissionPrompts: true,
  permissionModes: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
  modelSelection: { current: <sdk reports>, available: <sdk reports> },
  fileCheckpointing: true,
  sessionForking: true,
  interrupt: true,
}
```

Permission flow detail: when `canUseTool` allows with `allow_always`,
the driver returns a `PermissionResult` whose `updatedPermissions`
contains an `addRules` entry with `destination: 'localSettings'`. The
SDK then writes `.claude/settings.local.json` itself. Our previous
`appendAllowRule()` helper is gone.

The only non-SDK responsibility the driver retains is light
remapping between SDK message shapes and our internal `HistoryEntry`
/ `AgentEvent` shapes. That's typed-object → typed-object copying,
not parsing.

#### `desktopPids.ts` (new, tiny)

Single helper: `getDesktopPids(sessionId): Promise<number[]>`.
`ps`-based scan to find live `claude` processes that hold the session
JSONL open and weren't spawned by us. Used by the takeover-from-desktop
feature. The SDK doesn't help here because it only knows about its own
in-process queries, not other people's CLIs.

Everything else from the old `claudeCode.ts` JSONL helpers is gone:
no `peekFirstEntries`, no `entryFromRaw`, no `decodeProjectDir`. The
SDK's session functions return what we need directly.

Capabilities reported:

```
{
  agent: 'claude-code',
  permissionPrompts: true,
  permissionModes: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
  modelSelection: { current: '<sdk reports>', available: <sdk reports> },
  fileCheckpointing: true,    // Query.rewindFiles
  sessionForking: true,        // SDK forkSession()
  interrupt: true,
}
```

New responsibilities wired during this migration:

- `setModel` → `Query.setModel()` plus a `model` AgentEvent so the
  mobile chip updates without polling.
- `rewindTo(messageId)` → `Query.rewindFiles({ messageId })`. Emits a
  `rewind` AgentEvent with the affected file list so mobile can prune.
- `fork({ atMessage? })` → SDK `forkSession()`. The runtime spawns the
  new session lazily on first message; the driver does not start it
  eagerly.
- `FileChanged` hook in `Query` options → emits `file_changed`
  AgentEvents in the same shape `watchers.acquire` produces today.
  Replaces chokidar for SDK-driven sessions.
- SDK background-task notifications → folded into the existing
  `tool_use`/`tool_result` chain (or a new minimal AgentEvent if mobile
  needs it; decided in the Phase 5 LLD).

#### `registry.ts`

```ts
register(new ClaudeCodeSdkDriver());
// register(new CodexDriver()); // added by the codex SDD, no changes here
```

No `CLAUDE_DRIVER` branch after Phase 6. Driver registration is the
only place that knows which agent kinds exist.

#### `claudeCode.ts` (CLI driver) — to be deleted

Removed in Phase 6 after the SDK driver is proven stable in real use.

### Bridge — permissions (`bridge/src/permissions.ts`)

Agent-neutral. Loses everything claude-and-MCP-specific:

- `internalToken()`, `isInternalAuth()` — only the MCP subprocess
  needed these.
- `getMcpConfig()` — only the CLI driver passed this to claude.
- `appendAllowRule()` and `deriveAllowRule()` — the SDK writes
  `.claude/settings.local.json` itself when `canUseTool` returns
  `updatedPermissions`.

The cross-session `requestPermissionFromUser` helper stays. It accepts
a generic `emitSessionEvent` callback so any driver (claude-code
today, codex tomorrow) can route a permission request through the
same registry without coupling to claude-specific event shapes. Its
return value gains an optional `updatedPermissions` field so the
caller (`canUseTool` for the SDK driver) can hand it straight to the
SDK without a separate rules-persistence path.

### Bridge — HTTP/WS (`bridge/src/server.ts`)

Existing endpoints stay. Changes:

- `/internal/permission` POST handler deleted.
- `/sessions/:agent/:id/stream` WS handler:
  - emits `capabilities` on attach (alongside the existing
    `permission_mode` event, which becomes one piece of the capabilities
    payload),
  - accepts new client message types: `set_model`, `rewind_to`. Each
    routes only to the optional method on `AgentSession` if the
    capability is present; otherwise the message is rejected with a
    typed error so misbehaving / outdated clients fail loudly.
- `POST /sessions/:agent/:id/fork` HTTP endpoint added (HTTP, not WS, so
  the client gets a clean request/response with the new session ID for
  navigation).
- All driver branches in `server.ts` that read `agent === 'claude-code'`
  are reviewed and either deleted or replaced with a capability check.
  The takeover-from-desktop branch is allowed to remain because
  desktop-pid tracking is fundamentally claude-only today; even that is
  gated by checking whether the driver implements `getDesktopPids`.

### Bridge — file watcher (`bridge/src/watcher.ts`)

Deleted in Phase 5 / 6. The SDK driver's `FileChanged` hook produces
the same `file_changed` event shape. If we find a coverage gap (e.g.
external edits not surfaced), we'll add a `WATCHER_FALLBACK=on` env
flag that re-enables a stripped-down chokidar for the duration of one
release while we sort it out.

### Mobile — capabilities slice

A new zustand slice per session keys on `(agent, sessionId)` and stores
the latest `capabilities` payload received from the bridge. Hooks in
the chat header and sessions list read from it.

```
useSessionCapabilities(agent, sessionId) -> AgentCapabilities | null
```

Initial value is `null` until the WS attach completes; controls hide
until caps arrive (avoids a flicker of mode/model chips before the
bridge has spoken).

### Mobile — chat container

`mobile/app/sessions/[agent]/[id]/index.tsx` is rewritten to read from
the capabilities slice. No string compare against `'claude-code'`
anywhere. The header renders:

- Mode chip — iff `caps.permissionModes` non-empty.
- Model chip — iff `caps.modelSelection` non-null.
- Overflow menu items (Fork, etc.) — iff matching cap is true.

In-chat approval prompts (the `ApprovalSheet`) render iff
`caps.permissionPrompts`.

### Mobile — message renderer (per-agent card packs)

`mobile/components/chat/ToolCard.tsx` is refactored from a Claude-only
switch into a per-agent **card pack registry**:

```ts
type ToolCard = (input: unknown, ctx: { running?: boolean }) => ReactNode;
type CardPack = {
  agent: AgentKind;
  cards: Record<string, ToolCard>;
};

const packs: Record<AgentKind, CardPack> = {
  'claude-code': claudeCodeCardPack,
  // 'codex': codexCardPack, // added by the codex SDD
};

function pickCard(agent: AgentKind, toolName: string): ToolCard {
  return packs[agent]?.cards[toolName] ?? GenericFallbackCard;
}
```

- `claudeCodeCardPack` is the current per-tool renderers (Bash, Edit,
  Read, Grep, WebFetch, TodoWrite, Task, BashOutput, KillShell,
  NotebookEdit, etc.), moved as-is into one file.
- `GenericFallbackCard` renders the tool name + collapsible JSON of
  `input`. Used for unknown tools regardless of agent — including new
  Claude tools we haven't written cards for yet.
- The chat row passes the session's `agent` field into `pickCard`. The
  chat container never inspects tool names directly.

`Markdown.tsx` rendering of assistant text is already agent-neutral
and unchanged.

### Mobile — sessions list approval surfaces

Sessions-list chips + top banner render only for sessions whose
capabilities include `permissionPrompts: true`. A session whose agent
doesn't surface permission prompts will never appear in the pending-
approvals stream because the agent will never enqueue one.

### Out-of-process components

Removed entirely: `bridge/src/mcp/permission-server.ts` and the `tsx`
spawn that started it. The SDK driver's `canUseTool` callback runs
in-process.

## Data flow — permission prompt (target state)

```
1. agent runtime wants to run a tool
2. SDK / driver invokes its permission gate
   (canUseTool for the SDK; analogous in any future driver)
3. → requestPermissionFromUser({
      agent, sessionId, cwd, toolUseId, tool, input,
      emitSessionEvent: ev => session.emit('event', ev),
   })
4. requestPermissionFromUser:
     - emits permission_request AgentEvent → in-chat approval UI
     - calls permissions.await() which:
         - registers in pendingByKey
         - emits 'permission_added' on permissions registry
         - bridge-wide /events WS broadcasts to sessions list
5. user taps Allow (in chat OR on sessions list)
6. WS approval frame → server.onMessage → permissions.resolve()
     - clears pendingByKey
     - emits 'permission_resolved'
     - resolves the Promise from step 4
7. requestPermissionFromUser returns { behavior, updatedInput?, message? }
8. driver returns the agent-runtime-shaped permission result
9. agent runtime applies the decision and continues / aborts
```

No subprocess hop, no internal HTTP, no MCP server. Identical for any
agent that surfaces permission prompts.

**Attach-time replay.** When a chat WS attaches to a session that
already has pending prompts (e.g. the user answered nothing yet and
walked from the sessions list into the chat), `server.ts:attach`
replays each entry in `permissions.list()` for that
`(agent, sessionId)` as a `permission_request` AgentEvent. Without
this, the sessions-list chip (fed by the `/events` snapshot on attach)
and the chat ApprovalSheet (fed only by live events) would disagree
about whether there's anything to approve.

## Data flow — capabilities advertisement

```
1. mobile opens WS to /sessions/:agent/:id/stream
2. bridge initializes session via runtime.getOrCreate
3. bridge sends 'capabilities' event with AgentCapabilities snapshot
4. mobile stores in capabilities slice keyed by (agent, sessionId)
5. chat header / sessions list components re-render with appropriate
   controls visible
6. if anything that affects capabilities changes mid-session (model
   switched, mode changed), bridge re-emits 'capabilities' (or the
   narrower event for that one field — e.g. existing 'permission_mode')
   and mobile updates the slice
```

## Data flow — model swap

```
1. user taps model chip → picker → selects a model
2. mobile sends { type: 'set_model', model } on session WS
3. server validates caps.modelSelection is non-null AND model in list
4. server routes to session.setModel(model)
5. driver:
     - updates internal currentModel
     - emits 'model' AgentEvent (mobile chip updates immediately)
     - calls runtime's setModel (live; no kill)
6. next assistant turn uses the new model
```

## Data flow — rewind

```
1. user long-presses assistant bubble → "Rewind to here"
2. confirmation modal shows file count + filenames
3. mobile sends { type: 'rewind_to', messageId } on session WS
4. server validates caps.fileCheckpointing
5. server routes to session.rewindTo(messageId)
6. driver calls runtime rewind; on success emits
   'rewind' AgentEvent { messageId, filesAffected }
7. mobile prunes items to that messageId, refreshes files-changed pane
```

## Tech stack

- Node (existing) + `@anthropic-ai/claude-agent-sdk` (existing dep).
- Removed: `chokidar`.
- `tsx` stays as the bridge's dev runner; only the MCP subprocess
  invocation goes.

## Compatibility

- Sessions on disk are unchanged — claude-code uses the same JSONL.
- Allow rules in `.claude/settings.local.json` are unchanged.
- Mobile clients that don't yet know about the capabilities payload
  still work: the previous behavior (mode chip visible, no model chip,
  no rewind/fork) is the same as a session whose caps happen to match
  that pattern. We don't break older clients.
- Operators who pin `CLAUDE_DRIVER=cli` during the one-release
  deprecation window keep the old behavior on the bridge side.

## Risks

- **SDK behavior drift.** The SDK could change message shapes in a minor
  version. Mitigation: pin a working version; smoke-test list
  documented in the plan.
- **`canUseTool` semantics differ subtly from MCP.** We've shown parity
  for `allow` / `deny` / `allow_always`. Edge case: `updatedInput`
  ergonomics — we echo input unchanged today, consistent with the MCP
  path; revisit if a use case appears.
- **FileChanged hook coverage.** If the SDK hook misses external edits
  (made outside the agent), keep chokidar behind a `WATCHER_FALLBACK`
  flag for one release while investigating.
- **Capabilities mid-session change.** Some capabilities (e.g.
  `permissionModes`) are static; others (current model) change. The
  server must re-emit `capabilities` (or the narrower already-existing
  event) when something changes, and mobile must merge rather than
  replace its slice for these.
- **Stale clients hitting new endpoints.** A new mobile build that
  knows about `set_model` could be paired with an old bridge that
  doesn't. The bridge replies with a typed `error` for unknown message
  types; mobile must handle that gracefully (rollback the optimistic
  UI change).
- **`agent === 'claude-code'` regression.** It's easy to slip a check
  back in. Phase 6 includes a `git grep` gate (success criterion 9 in
  the FRD) to keep us honest.

## Decision log

- **Why `canUseTool` over MCP** — one fewer process, one fewer auth
  tier, no HTTP loopback. The shared `requestPermissionFromUser`
  helper means user-facing flow is byte-identical.
- **Why delete the CLI driver instead of keeping both** — every
  feature we wire is SDK-only. Maintaining two implementations costs
  more than the optionality is worth.
- **Why lean fully on the SDK for session reads/writes** — we used to
  extract JSONL helpers to keep parsing alive after the CLI driver
  was deleted. With SDK-only as the target, we don't need our own
  parser at all. The SDK exposes `listSessions`, `getSessionInfo`,
  `getSessionMessages`, `forkSession`, `deleteSession`,
  `renameSession`, and writes `settings.local.json` for us via
  `canUseTool` `updatedPermissions`. Less code, less drift risk when
  the on-disk format evolves, and `desktopPids.ts` is the only
  claude-specific helper that survives because the SDK has no view
  into non-SDK processes.
- **Why capability negotiation NOW, not when Codex lands** —
  capabilities are a coordination contract. Building Codex against an
  uncoordinated contract is more work than building the contract once
  and using it twice. Without this, every new agent will discover the
  same set of leaky abstractions in turn.
- **Why per-agent card packs over a single switch with agent
  branches** — keeps each agent's tool-rendering knowledge in one
  file, makes it trivial to add an agent (one entry in the pack
  registry), keeps the chat container free of imports it doesn't
  need.
- **Why a generic fallback card** — Claude itself ships new tools
  faster than we wire them. The fallback isn't a multi-agent
  affordance; it's how the chat handles surprise from any agent.
