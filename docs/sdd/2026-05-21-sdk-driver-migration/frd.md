# Functional Requirements — SDK Driver Migration

## Problem

The bridge today controls Claude Code by spawning the `claude` CLI binary as
a child process and parsing its stream-json output. This started as a
single-agent solution and several pieces of the bridge and mobile UI
accidentally hard-coded that assumption — tool names, file paths, IPC
shapes, even some UI surfaces only make sense for Claude Code. The cost
shows up as:

- **Mode changes kill the session.** Changing the permission mode
  mid-conversation requires SIGTERM'ing the child and respawning, which
  reads to the user as an unexpected restart and discards in-flight tool
  calls.
- **Permission prompts loop through a separate subprocess** at
  `bridge/src/mcp/permission-server.ts` and a `/internal/permission` HTTP
  hop with a bearer-token tier. One extra process per session, one extra
  hop per prompt, one extra auth surface to maintain.
- **File watching is bridge-side** (chokidar walking the project tree)
  with macOS-specific failure modes around sockets/FIFOs and a hand-tuned
  ignore list.
- **Session storage is read with hand-rolled JSONL parsers** in the same
  file as the driver. Any refactor of `~/.claude/projects/` storage risks
  breaking the bridge.
- **Runtime control of the agent is limited.** No live model swap, no
  rewind, no programmatic subagents, no first-class background tasks —
  features the official SDK already exposes.
- **The "agent" abstraction is leaky.** Mobile's tool-card renderer
  hardcodes Claude's tool vocabulary (`Bash`, `Edit`, `Read`, `Grep`,
  `WebFetch`, `TodoWrite`, `Task`, …). The bridge protocol assumes every
  agent will have a permission mode and a model picker. Adding any second
  agent (Codex is the next planned one) currently requires touching the
  chat list, the header, and the approval flow.

A parallel `ClaudeCodeSdkDriver` (`bridge/src/agents/claudeCodeSdk.ts`)
behind `CLAUDE_DRIVER=sdk` already proves the SDK path works for live
mode swap and in-process permission gating. This effort commits to the
SDK fully, removes the CLI driver, wires the remaining SDK features, AND
fixes the leaky multi-agent abstractions so a second agent is purely
additive when it arrives.

## Goals

1. **Make the SDK the only Claude Code transport.** Remove the
   CLI-spawning driver, the MCP permission server, the `/internal/permission`
   endpoint, the `CLAUDE_DRIVER` env var, and the `chokidar` dependency.
2. **Add the SDK-exposed user-facing features** that are worth shipping:
   live model swap, rewind-to-message, fork session, first-class
   background-task tracking.
3. **Replace bridge-side file watching** with the agent runtime's file
   change events.
4. **Make multi-agent a first-class concern in this migration**, not a
   deferred follow-up. Concretely:
   - The bridge exposes per-session capability metadata; mobile renders
     only what the active agent supports.
   - The chat UI's message rendering (tool cards, agent-specific blocks)
     is keyed by agent kind via a card-pack registry, with a generic
     fallback for any agent.
   - No code path in the bridge or mobile takes "the agent is
     claude-code" as an implicit assumption.
5. **Preserve every existing user-visible feature** for the only agent
   that exists today (claude-code). Sessions list, history replay,
   approvals (in-chat and cross-session), mode picker, takeover-from-
   desktop, dev-server preview pane all keep working byte-identically.

## Non-goals

- Building the Codex driver itself. This effort makes Codex a drop-in
  addition; the actual implementation is a separate SDD.
- Changing the on-disk session format for Claude Code. The SDK reads
  and writes the same JSONL files; existing sessions remain
  interoperable.
- Maintaining our own parser for claude-code sessions or allow-rules.
  Everything claude-specific on disk is read/written by the SDK
  (`listSessions`, `getSessionInfo`, `getSessionMessages`,
  `renameSession`, `deleteSession`, `forkSession`, and
  `canUseTool` returning `updatedPermissions` for the
  `.claude/settings.local.json` writes we used to do by hand).
- Removing the `AgentDriver` / `AgentSession` abstraction. It stays
  and becomes the single seam between agents and the rest of the
  system.
- Mobile redesign. New controls attach to existing chat surfaces
  (header, bubble long-press, header overflow menu) rather than
  introducing new screens.
- Protocol breaks with desktop CLI users running `claude` on their
  laptop. Takeover-from-desktop continues to work as today.
- Multi-account / org-switching, plugin systems, replacing the SQLite
  session-meta store, reworking `ChatPreviewPager`.

## Users & user stories

**Persona — solo developer using the phone client over Tailscale.** Their
flow is: kick off a task on their laptop, walk away, monitor and steer it
from the phone. The mobile experience is what determines whether the
project is useful. Today they're using Claude Code; tomorrow they may
have a second agent (Codex) running alongside in another session.

1. *As a phone user, when I change the permission mode mid-conversation,
   the agent keeps working — it doesn't restart.*
2. *As a phone user, when the agent needs permission to run a tool, the
   approval feels instant — no subprocess delay.*
3. *As a phone user, I can switch models mid-conversation ("try this
   with Opus") without leaving the chat.*
4. *As a phone user, when the agent edits a file I don't like, I can
   long-press the message and rewind to before that edit.*
5. *As a phone user, I can branch the current session into a "what if"
   conversation without losing the original.*
6. *As a phone user, when a long-running tool is in flight (foreground or
   backgrounded), I see the same surface for it.*
7. *As a phone user with a Claude session AND a Codex session, the same
   app opens both. Controls that don't apply to one agent are hidden, not
   broken. Tool cards for each agent's native tools render correctly.*
8. *As the project owner, the bridge has one fewer subprocess and one
   fewer dependency to reason about per session.*

## Functional requirements

### FR-1 — SDK as the only Claude Code driver

- The bridge interacts with the `claude-code` agent via
  `@anthropic-ai/claude-agent-sdk` exclusively, for both the live query
  loop and the session-management functions (list, find, history, rename,
  delete, fork). No hand-rolled JSONL parsing remains.
- `bridge/src/agents/claudeCode.ts` (CLI driver),
  `bridge/src/mcp/permission-server.ts`, the `/internal/permission` HTTP
  endpoint, the `CLAUDE_DRIVER` env var, and our `appendAllowRule` /
  `getMcpConfig` helpers in `permissions.ts` are removed once the SDK
  driver is proven stable in real use.
- `CLAUDE_DRIVER=cli` is a one-release opt-out so the migration can be
  reverted if an unforeseen SDK bug surfaces.

### FR-2 — Behavior parity for the existing agent

- Sessions list (status badges, last-modified, preview, label) is
  unchanged from the user's perspective.
- Chat history replay loads exactly the same messages.
- In-chat approval prompts, cross-session approval chips + top banner,
  mode picker, takeover-from-desktop card, file-changed pane, and
  dev-server preview pager all keep working.
- Permission decisions still route through the shared
  `requestPermissionFromUser` helper so the registry-backed
  cross-session approval UI remains the single source of truth.

### FR-3 — Live mode change

- Changing the permission mode mid-conversation does **not** kill the
  running query. The new mode applies to the next tool call.
- The chat surface reflects the new mode immediately.

### FR-4 — Model picker

- The chat header gains a tappable model chip alongside the mode chip,
  rendered only when the active agent reports model selection support.
- Tapping opens a picker listing the models the agent reports as
  available.
- Selecting a model applies it for subsequent responses in the active
  session — no restart.
- The current model is displayed in the chip and persists across
  reconnects.

### FR-5 — Rewind to here

- Each assistant message bubble exposes a "Rewind to here" action
  (long-press / overflow menu), rendered only when the active agent
  reports rewind support.
- Confirming restores files to the state they were in immediately
  before that message was produced and trims the displayed chat history
  to that point.
- A confirmation dialog shows which files will change. The action is
  destructive but reversible (the agent runtime keeps the prior
  checkpoint).

### FR-6 — Fork session

- The chat header overflow menu gains a "Fork session" action, rendered
  only when the active agent reports forking support.
- Confirming forks the current session at the latest message into a new
  session ID, leaves the original session untouched, and navigates the
  user into the fork.
- The forked session appears at the top of the sessions list.

### FR-7 — Background tasks

- When the active agent backgrounds a long-running tool, the bridge
  surfaces a background-task entry derived from the agent runtime's
  task notifications rather than tool-name heuristics.
- Mobile renders an existing tool-card-style item; no new component
  required.

### FR-8 — File-change events from the agent runtime

- The bridge stops walking the project tree itself. The agent runtime's
  file-change events feed the existing `file_changed` server-to-client
  frame.
- The mobile "files changed" pane and the diff view are unaffected.
- `bridge/src/watcher.ts` and the `chokidar` dependency are removed.
- If the agent runtime misses external (non-agent) edits, the bridge
  may keep a fallback watcher gated by config; this is a discovery item
  for the HLA / plan.

### FR-9 — Capability-driven UI

The bridge declares per-session capabilities; the mobile renders only
what the active agent supports. No mobile code path may inspect
`session.agent === 'claude-code'` to decide whether to render a control.

- On WebSocket attach, the bridge sends a `capabilities` payload
  describing what the session supports: at minimum
  `permissionPrompts`, `permissionModes` (list or null), `modelSelection`
  (current + list or null), `fileCheckpointing`, `sessionForking`,
  `interrupt`, and an agent identifier the mobile uses to look up its
  tool card pack.
- Mobile mirrors the payload per-session and gates UI accordingly:
  mode chip, model chip, rewind affordance, fork action, in-chat
  approval UI, and cross-session approval chips all hide when the
  corresponding capability is absent.
- The capability payload is the only place that holds agent-specific
  knowledge on the wire. The mobile chat container itself is agnostic.

### FR-10 — Agent-aware message rendering

Different agents emit different tool names, different message blocks,
and different result shapes. The chat list must render any agent's
output without modifying the chat container itself.

- Tool-invocation card rendering is delegated to a per-agent **card
  pack** selected by the session's agent identifier. Each pack maps
  `(toolName, input)` to an optional renderer.
- A **generic fallback card** (tool name + collapsible JSON of input)
  handles unknown tools — both new tools an agent adds without us
  knowing, and every tool of a yet-unrecognized agent.
- The current Claude Code per-tool cards (Bash, Edit, Read, Grep,
  WebFetch, etc.) become the `claude-code` card pack — code moves, no
  behavior change for the existing agent.
- Any auxiliary message block kinds an agent emits (thinking, citations,
  agent-specific summaries) flow through the existing `AgentEvent`
  taxonomy. If a kind doesn't apply to a given agent, the corresponding
  event simply never fires; no claude-specific gating is needed in the
  chat list.

### FR-11 — Bridge-internal abstraction

The bridge code itself has no Claude-specific branches outside the
claude-code driver and the on-disk JSONL helpers.

- `bridge/src/server.ts` does not name `claude-code` except in the
  takeover-from-desktop conditional (which legitimately only applies to
  agents that surface live desktop pids).
- `bridge/src/permissions.ts` is fully agent-neutral.
- The `AgentDriver` / `AgentSession` interface in
  `bridge/src/agents/types.ts` carries everything a driver needs to
  declare its capabilities and respond to capability-gated commands
  (`setMode`, `setModel`, `rewindTo`, `fork`). Drivers leave optional
  methods unimplemented if they don't support that capability.

### FR-12 — Backward compatibility

- Claude Code sessions created by the CLI driver continue to load and
  resume — the SDK reads the same on-disk format.
- Existing `.claude/settings.local.json` allow rules keep working —
  same file, same shape; only the writer changes (SDK rather than
  our `appendAllowRule`).
- Mobile clients on older versions keep working — capability gating is
  additive; clients that don't read `capabilities` fall back to the
  previous behavior (which is still safe for the only agent that
  existed then).

## Success criteria

Status of each criterion as of the implementation landing
(2026-05-21). Items not marked ✅ are gated only on a real-session
smoke pass, not on code correctness.

1. ✅ `CLAUDE_DRIVER` is no longer present in the codebase or docs.
2. ⚠️ Live mode change is observable: send a message, change mode
   while it streams, the streaming continues uninterrupted. *(SDK
   `setPermissionMode` is wired; behavioral confirmation pending the
   next streaming session.)*
3. ⚠️ Model picker is wired and a model change is reflected in the
   next assistant turn within the same session. *(Wired via
   `Query.setModel`; the picker ships with `available: []` because
   the SDK doesn't expose a list — the chip shows the current model
   and accepts any model the bridge forwards.)*
4. ⚠️ Rewind to a message restores files and the user can verify via
   the files-changed pane and `git diff`. *(Long-press → confirm →
   `rewind_to` wired; `enableFileCheckpointing: true` set on the
   query. Real-session confirmation pending.)*
5. ⚠️ Fork creates a new session, distinct ID, original session
   unchanged. *(`POST /sessions/:agent/:id/fork` wired; mobile
   replaces route to the new session on success.)*
6. ✅ `bridge/src/watcher.ts` and the `chokidar` dependency are gone.
   `file_changed` events continue to flow via the SDK `FileChanged`
   hook. (Coverage of external/non-agent edits is the one open smoke
   item — see plan.md "Open questions".)
7. ✅ `bridge/src/mcp/`, `bridge/src/agents/claudeCode.ts`, and the
   `/internal/permission` endpoint are gone. Bridge type-checks and
   boots cleanly without them.
8. ✅ The bridge contains no hand-rolled JSONL parser caught by the
   grep gate — no `peekFirstEntries`, no `entryFromRaw`, no
   `appendAllowRule`, no `decodeProjectDir`. The only remaining
   transcript parser is `parseTranscriptLine` inside `jsonlTail.ts`,
   used by the desktop-takeover live-replay path. `desktopPids.ts`
   (`ps`-based) is the only claude-specific helper that survives
   because the SDK can't see processes it didn't spawn.
9. ⚠️ The bridge emits `capabilities` on attach (✅). Stub agent
   driver is registered behind `STUB_AGENT=1` and reports the
   minimal capability profile (✅). Visual confirmation that the
   stub-agent chat hides every gated control + renders synthetic
   tool_use via the generic fallback card is pending a manual smoke
   pass.
10. ✅ `git grep '\'claude-code\''` in `mobile/app` and
    `mobile/components` finds only the card-pack registry key in
    `cardPacks/index.ts` and a self-referencing comment in
    `ToolCard.tsx`. No UI-gating conditional uses the literal.
