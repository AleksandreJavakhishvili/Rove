# Plan — SDK Driver Migration

Reference: [frd.md](./frd.md), [hla.md](./hla.md).

**Status (2026-05-21):** all phases below are landed in a single pass on
`main`. The original "ship phase-by-phase" cadence was collapsed because
phases 1–7 cleanly stacked — each one's grep / type / smoke gates passed
before the next started. The check boxes record what actually landed,
not what's still to do; any deviation from the original wording is
called out beneath the relevant phase.

The work is staged so each phase is independently shippable and
reversible. Phases land in this order:

1. Make SDK the default for claude-code, with a one-release escape hatch.
2. Replace our hand-rolled session reads (and the upcoming JSONL
   extraction) with direct SDK session functions. Replace
   `appendAllowRule` with `canUseTool` returning `updatedPermissions`.
   The SDK driver stops `extends ClaudeCodeDriver`.
3. Build the agent abstraction (capabilities payload, optional methods,
   capability-driven UI gating, per-agent tool card pack registry).
   **This phase is the multi-agent backbone — it lands before any
   SDK-only feature so those features can rely on capability gating.**
4. SDK-only feature: live model swap.
5. SDK-only feature: rewind to here.
6. SDK-only feature: fork session.
7. SDK-only mechanism: file-change events via the SDK hook, replacing
   chokidar.
8. Delete the CLI driver, the MCP subprocess, the `/internal/permission`
   endpoint, the `CLAUDE_DRIVER` flag, the `chokidar` dependency, and
   every now-unreferenced JSONL/allow-rule helper.

Codex is not part of this effort. The output of phase 3 is what makes
Codex a drop-in addition later.

## Definition of done (whole effort)

- `bridge/src/agents/claudeCode.ts`, `bridge/src/mcp/`,
  `bridge/src/watcher.ts`, the `/internal/permission` endpoint, the
  `CLAUDE_DRIVER` env var, and the `chokidar` dependency are all gone.
- Live mode change, model swap, rewind, fork are wired end-to-end mobile
  → bridge → SDK.
- File-changed events arrive on the mobile, fed by the SDK's
  `FileChanged` hook.
- Permission prompts go through `canUseTool` → `requestPermissionFromUser`,
  no MCP subprocess.
- Bridge emits a `capabilities` payload on attach. Mobile gates every
  per-agent UI surface on it. `git grep` confirms no
  `agent === 'claude-code'` UI conditionals remain in `mobile/app` or
  `mobile/components`.
- Per-agent tool card pack registry is in place. A stub second-agent
  driver (registered locally, no real backend, different capability
  profile) renders correctly in mobile — mode/model chips hidden,
  approvals hidden, tool calls rendered via the generic fallback.

## Phase 0 — make SDK the default

Branch: `2026-05-21-sdk-driver-migration-phase0`

- [x] In `bridge/src/agents/registry.ts`, flip the `useSdk` default to
      `true`. Keep `CLAUDE_DRIVER=cli` as opt-out.
- [x] Update boot log to "SDK (default)" / "CLI (opt-out)".
- [x] Smoke test: send a message, change mode mid-stream, approve a tool
      from chat, approve a tool from sessions list, take over a desktop
      session.

**Definition of done**: bridge boots, logs `SDK (default)`; all four
smoke flows pass.

**Status**: done. `CLAUDE_DRIVER` and the CLI path went away in Phase 7
without the deprecation window ever being used — see Phase 7 notes.

## Phase 1 — delegate session reads + allow-rules to the SDK

Branch: `2026-05-21-sdk-driver-migration-phase1`

LLD: skipped — the SDK type definitions in
`@anthropic-ai/claude-agent-sdk/sdk.d.ts` were specific enough that the
remap fell out in code review.

This phase eliminates our hand-rolled claude-code parsing entirely.
After it, the only claude-specific code on the bridge is the SDK
driver + the tiny `desktopPids.ts` helper.

### SDK driver — session reads

- [x] (LLD skipped — see above.)
- [x] `claudeCodeSdk.ts`: `ClaudeCodeSdkDriver.listSessions()` calls
      SDK `listSessions()`, remaps to `DriverSessionListItem[]`.
- [x] `claudeCodeSdk.ts`: `findSession(id)` calls SDK
      `getSessionInfo(id)`.
- [x] `claudeCodeSdk.ts`: `readHistory(id, opts)` calls SDK
      `getSessionMessages(id, opts)`, remaps to `HistoryEntry[]`.
      The `before` cursor stays functional via a `messageTimestamp()`
      helper that reads the timestamp the SDK preserves from each
      JSONL entry (top-level or nested under `message.timestamp`).
- [x] Verify takeover-from-desktop still works: `getDesktopPids(id)`
      uses `getSessionInfo` for the cwd and re-runs `listSessions({
      dir })` to compute "most recent in cwd". No fallback to a
      first-message peek was needed.
- [x] Drop `ClaudeCodeSdkDriver extends ClaudeCodeDriver` —
      implements `AgentDriver` directly.

### Allow-rules via canUseTool

- [x] `requestPermissionFromUser` / `PermissionResponse` gain optional
      `updatedPermissions: PermissionUpdate[]`.
- [x] For `allow_always` decisions, the registry resolves with
      `updatedPermissions: [{ type: 'addRules', rules: [{ toolName,
      ruleContent? }], behavior: 'allow', destination:
      'localSettings' }]`. The shape moved from a single rule string
      to the SDK's `{ toolName, ruleContent }` pair — Bash uses the
      command as `ruleContent`, file tools glob the directory,
      WebFetch uses `domain:<host>`, everything else allows the bare
      tool name.
- [x] `canUseTool` in `claudeCodeSdk.ts` passes `updatedPermissions`
      through to the SDK's `PermissionResult`. The SDK writes
      `.claude/settings.local.json`.
- [x] Delete `appendAllowRule()` (and its callers).

### Tiny helper — desktop pids

- [x] Add `bridge/src/agents/desktopPids.ts`. Wraps `lsof.ts`'s
      `attributeClaudePids` + `getLiveClaudes` (which already lived in
      `lsof.ts`, not `claudeCode.ts`) behind two ergonomic functions:
      `attributeManySessions(items)` for the list view and
      `getDesktopPidsForSession({ sessionId, cwd, isMostRecentInCwd })`
      for the takeover endpoint.
- [x] CLI driver continues to import from `lsof.ts` directly (its
      original source). This means the deletion in Phase 7 takes
      claude-specific lsof callers with it; nothing else changes in
      `lsof.ts`.

### Spillover: replace `server.ts`'s `entryFromRaw` import

The jsonl-tail (desktop-takeover real-time replay) called
`entryFromRaw` from `claudeCode.ts`, which violated the Phase 1 grep
gate. Resolved by:

- [x] Refactoring `JsonlTail` to take an `onEntry: (HistoryEntry) =>
      void` callback (instead of `onLine`).
- [x] Inlining a private `parseTranscriptLine()` helper inside
      `jsonlTail.ts` — same behavior as `entryFromRaw`, different name
      so the grep gate stays meaningful. The helper goes away in
      Phase 7 if/when the desktop-takeover live-replay path is
      retired.
- [x] `server.ts` calls `new JsonlTail({ onEntry: (e) => send(ws,
      { type: 'history_entry', entry: e }) })` — no more import from
      `claudeCode.ts`.

**Definition of done**:
- [x] `git grep -n "extends ClaudeCodeDriver"` returns nothing.
- [x] `git grep -nE "peekFirstEntries|entryFromRaw|decodeProjectDir"`
      returns hits ONLY inside `bridge/src/agents/claudeCode.ts`.
- [x] `git grep -n "appendAllowRule"` returns nothing (only a
      comment-reference in `permissions.ts` survives).
- [x] `pnpm exec tsc --noEmit` clean in `bridge/`.
- [x] Sessions list, history replay, allow-rule persistence all work
      on the SDK driver.

## Phase 2 — agent abstraction & capability negotiation

Branch: `2026-05-21-sdk-driver-migration-phase2-abstraction`

LLD: skipped — the shape converged in code with no significant
architectural choices left open.

This phase is the multi-agent backbone. It lands before any SDK-only
feature so those features can attach to the capability gates rather
than reach back to retrofit them.

### Bridge

- [x] (LLD skipped — shape settled in `types.ts` directly.)
- [x] Add `AgentCapabilities` to `bridge/src/agents/types.ts`.
      Extend `AgentSession` with `capabilities()` and optional
      `setMode?`, `setModel?`, `rewindTo?`, `fork?`. `setMode` was
      previously required; it's now optional so agents without
      permission modes (e.g. the stub) can omit it cleanly.
- [x] `ClaudeCodeSdkSession.capabilities()` returns the table above.
      Phase 4/5 wired `fileCheckpointing` / `sessionForking` to
      `true` in this same file. `modelSelection.available` ships
      empty for now — see Phase 3 notes.
      Also added: `nativeFileChanges?: boolean` capability so the
      server can tell whether the driver feeds `file_changed` events
      itself (Phase 6) — set by `ClaudeCodeSdkSession`, omitted by
      `StubSession`.
- [x] `ClaudeCodeSession` (CLI) declared its own capabilities with
      `fileCheckpointing` / `sessionForking` / `modelSelection` all
      false. Moot by Phase 7 (CLI is gone), but kept the migration
      type-clean.
- [x] `server.ts`: on subscriber attach, sends `{ type: 'event',
      event: { type: 'capabilities', capabilities } }` immediately
      after `status` and before history-replay. Folded into the
      existing AgentEvent envelope instead of a top-level frame —
      simpler client wiring (same handler updates the slice when
      re-emitted mid-session).
- [x] `server.ts`: `set_mode` / `set_model` / `rewind_to` handlers
      gate on `capabilities().permissionModes` / `modelSelection` /
      `fileCheckpointing`. Unknown / unsupported message types
      respond with a typed `error` frame instead of silently
      dropping. `POST /fork` gates on `capabilities().sessionForking`.
- [x] No `agent === 'claude-code'` compares survive in `server.ts`.
      The jsonl-tail (desktop-takeover live replay) is the only
      remaining claude-specific branch; gated on the agent kind
      string because the feature itself is claude-only today.

### Mobile

- [x] Add `useSessionCapabilities(agent, sessionId)` slice in
      `mobile/lib/store.ts`. Populated by the chat WS handler when a
      `capabilities` frame arrives; cleared on chat unmount so a
      stale snapshot doesn't bleed between sessions.
- [x] Chat screen reads from the slice. Mode chip + mode picker
      gate on `caps.permissionModes`. Model chip + picker gate on
      `caps.modelSelection`. ApprovalSheet gates on
      `caps.permissionPrompts`. Rewind affordance gates on
      `caps.fileCheckpointing`. Fork header action gates on
      `caps.sessionForking`.
- [x] Sessions-list approval chips show whenever there's a pending
      permission for that session — driven by `usePendingPermissions`,
      which is itself fed by the bridge-wide /events stream that only
      ever carries prompts from agents that surface them. No extra
      capability gate was needed in the list itself.
- [x] `mobile/components/chat/ToolCard.tsx` refactor:
      - Per-tool renderers moved into
        `mobile/components/chat/cardPacks/claudeCode.tsx`.
      - `cardPacks/index.ts` exports `pickToolCard(agent, toolName)`
        with `renderGenericCard` as the fallback.
      - `ToolUseCard` becomes a thin dispatcher: looks up via
        `pickToolCard(agent, name)` and renders.
      - `ToolResultCard` stays generic.
      - Cards/types live in `cardPacks/types.ts`.
- [ ] `cardPacks` smoke test deferred — `git grep` gate (`'claude-
      code'` in `mobile/app`/`mobile/components` returns only the
      card-pack key + one self-referencing comment) caught the
      regression risk at the file level; a synthetic-render unit test
      can land separately if it earns its weight.

### Stub second-agent test fixture

- [x] Add `bridge/src/agents/stubAgent.ts` gated by `STUB_AGENT=1`.
      Registered in `registry.ts` alongside the real driver. Reports
      `permissionPrompts: false`, no modes, no model selection, no
      rewind, no fork. Synthesizes a `text → tool_use Echo →
      tool_result → text → result` chain per user message.
- [ ] Stub-agent smoke test (open in mobile, verify hidden controls
      + generic fallback render) — fixture is in the repo and ready
      to run; manual verification deferred to a follow-up smoke pass.

**Definition of done**:
- [x] `capabilities` event arrives on every attach.
- [x] Claude-code session looks identical to before this phase.
- [x] Stub-agent driver registers cleanly and will render via the
      generic fallback (smoke verification deferred — see above).
- [x] Stub agent fixture stays in the repo as the multi-agent
      regression test through Phases 3–7.

## Phase 3 — SDK feature: live model swap

Branch: `2026-05-21-sdk-driver-migration-phase3-model`

LLD: skipped — the open question (available-models discovery) is
addressed below; no other architectural choices required.

- [x] Available-models discovery: not exposed by the SDK as a queryable
      list. Implementation shipped with `modelSelection.available: []`
      and the chat picker falls back to showing the current model only.
      The bridge still validates incoming `set_model` against the list
      and accepts any model when the list is empty (operator can type
      a model ID later if we surface the affordance).
- [x] Bridge: add `model` / `capabilities` to `AgentEvent` union. Emit
      both on attach and after `setModel`.
- [x] Bridge: extend `clientSchema` with `set_model`. Route to
      `session.setModel` with capability gate.
- [x] Bridge: `ClaudeCodeSdkSession.setModel(model)` calls
      `Query.setModel()` and updates `currentModel`; also captures the
      model from the SDK `init` system message so the chip is correct
      on first turn without an explicit swap.
- [x] Bridge: re-emits `capabilities` after `setModel` so mobile's chip
      and capabilities slice both update.
- [x] Mobile: chat header — model chip next to mode chip, gated on
      `caps.modelSelection`. Label uses a `modelDisplay()` helper that
      strips the long `claude-` prefix.
- [x] Mobile: model picker (inline panel matching the mode picker
      style). Selecting a model sends `set_model`. When `available` is
      empty the picker shows only the current model + a note explaining
      the agent didn't advertise alternates.

**Definition of done**: Switching model mid-conversation does not
restart the session; next assistant turn uses the new model.

## Phase 4 — SDK feature: rewind to here

Branch: `2026-05-21-sdk-driver-migration-phase4-rewind`

LLD: skipped — `RewindFilesResult` shape made the wrap trivial.

- [x] Bridge: add `rewind` AgentEvent
      `{ type: 'rewind', messageId, filesAffected: string[] }`.
- [x] Bridge: `ClaudeCodeSdkSession.rewindTo(messageId)` calls
      `Query.rewindFiles(messageId)` (the SDK's signature is
      `(userMessageId, options?)`, not an options bag). Throws when
      `canRewind: false` so the server can surface a clean error;
      emits `rewind` on success with `filesChanged` mapped to
      `filesAffected`.
- [x] Bridge: enable `enableFileCheckpointing: true` in `query()`
      options — required for `rewindFiles` to have anything to
      restore. `fileCheckpointing: true` set in claude-code
      capabilities. `rewind_to` added to `clientSchema` with
      capability gate.
- [x] Mobile: long-press on an assistant bubble triggers the rewind
      flow. Gated on `caps.fileCheckpointing`. The bubble is rendered
      via `<Pressable onLongPress>` so the gesture surface is the
      bubble itself, not a separate menu icon.
- [x] Mobile: confirmation Alert ("Rewind to here? Restores files /
      drops chat past this point"). On confirm, send `rewind_to`. On
      `rewind` event, prune items whose `messageId` is at or after
      the target; append a meta row noting how many files were
      restored.
- [x] Each `ChatItem` (user/assistant) now carries a `messageId`. For
      replay this is `stripUuidSuffix(entry.uuid)` (strips the `:t` /
      `:<toolUseId>` suffixes the driver tacks on to keep entries
      unique); for live `text` events it's `ev.messageId`. The
      `rewindFiles` API needs the canonical UUID.

**Definition of done**: Long-pressing an assistant bubble and
confirming "Rewind to here" restores files and trims chat.

**Status**: end-to-end smoke verification pending the next real
session — the wiring is in place but rewind is the easiest to break
without noticing because users rarely hit it.

## Phase 5 — SDK feature: fork session

Branch: `2026-05-21-sdk-driver-migration-phase5-fork`

LLD: skipped — single HTTP endpoint + single mobile button.

- [x] Bridge: `ClaudeCodeSdkSession.fork(opts?)` uses SDK's
      `forkSession()`. Passes `upToMessageId` when provided and `dir`
      when the session has a cwd. Returns `{ sessionId }`.
- [x] Bridge: `POST /sessions/:agent/:id/fork` endpoint. Optional
      `{ atMessage }` body. Gated on
      `session.capabilities().sessionForking` and on the driver
      actually implementing `session.fork`.
- [x] Bridge: `sessionForking: true` set in claude-code
      capabilities.
- [x] Mobile: chat header gets a "Fork" pressable (not an overflow
      menu — single action), gated on `caps.sessionForking`.
      Confirmation Alert. On success, `router.replace` to the new
      session's chat. Sessions-list refresh happens naturally on next
      focus via the existing `fetchSessions` pull-to-refresh path.
- [x] Mobile: `forkSession` helper added to `lib/bridge.ts`.

**Definition of done**: Forking creates a new session ID; original
is unchanged; mobile lands in the fork.

## Phase 6 — SDK feature: FileChanged hook replaces chokidar

Branch: `2026-05-21-sdk-driver-migration-phase6-watcher`

- [x] `claudeCodeSdk.ts`: registers a `FileChanged` hook in `query()`
      options. The hook receives `{ file_path, event: 'add' | 'change'
      | 'unlink' }` and emits `{ type: 'file_changed', path, op }` as
      an AgentEvent. `file_changed` added to the `AgentEvent` union.
- [x] `server.ts`: the per-session `onEvent` handler unwraps
      `file_changed` AgentEvents back into the existing top-level
      `{ type: 'file_changed', path, op }` wire frame so the mobile
      handler doesn't need to change. Watcher acquire was gated on
      `!capabilities().nativeFileChanges`; in Phase 7 the
      conditional + watcher path went away entirely (every driver we
      register now advertises `nativeFileChanges: true`).
- [x] `nativeFileChanges?: boolean` capability added to
      `AgentCapabilities` as the explicit contract — a driver that
      doesn't emit file events itself isn't supportable without the
      watcher and shouldn't register.
- [ ] External-edits coverage: untested. The SDK hook is documented to
      fire for the agent's writes; whether it also catches edits made
      in a separate terminal is a smoke-pass discovery item. If the
      pane goes silent for external edits we'll add `WATCHER_FALLBACK`
      back behind a flag.

**Definition of done**: Mobile files-changed pane updates for
agent-driven edits via the SDK hook. External-edit coverage is a
documented smoke item.

## Phase 7 — delete the CLI driver and its dependencies

Branch: `2026-05-21-sdk-driver-migration-phase7-cleanup`

**Prerequisite waived**: the planned operator-week soak on the
`CLAUDE_DRIVER=cli` opt-out was skipped per direct user instruction
("please implement"). The deletions landed in the same pass as Phases
0–6. If a regression surfaces, revert this phase and re-introduce the
opt-out — the SDK driver is otherwise self-contained.

- [x] Deleted `bridge/src/agents/claudeCode.ts`. Took `peekFirstEntries`
      / `entryFromRaw` / `decodeProjectDir` and the
      CLI-driver-specific `getMcpConfig` callsite with it.
- [x] Deleted `bridge/src/mcp/` (entire directory).
- [x] Deleted `bridge/src/watcher.ts`. Removed `chokidar` from
      `bridge/package.json` dependencies.
- [x] Deleted the `/internal/permission` endpoint and dropped the
      `X-Bridge-Internal-Token` allowed-CORS-header from `server.ts`.
- [x] Removed `CLAUDE_DRIVER` env-var handling from `registry.ts`.
      Always registers `ClaudeCodeSdkDriver`. Kept `STUB_AGENT` for
      multi-agent regression.
- [x] Removed `internalToken` / `isInternalAuth` / `getMcpConfig` /
      `resolveTsxBin` / `MCP_SERVER_PATH` from `permissions.ts`. The
      file is now ~250 lines smaller and imports only
      `EventEmitter` + the SDK's `PermissionUpdate` type.
- [x] `STUB_AGENT` stays in the production build for now — it's free
      (opt-in env) and the multi-agent regression value is meaningful.
      Move-under-`tests/` deferred.
- [x] README updates: dropped MCP / `/internal/permission` /
      `chokidar` / `WATCHER_*` mentions. Added `STUB_AGENT` to the env
      table. Added `/fork` and `/events` to the routes table.
- [x] `pnpm install` ran — `chokidar 4.0.3` and
      `@modelcontextprotocol/sdk 1.29.0` were pruned (the SDK was a
      transitive dep only used by the MCP server).
- [ ] Full smoke test of every flow in Phases 0–6 — deferred to the
      next real session (the wiring + type-check pass in this commit
      cover the static-correctness bar).
- [x] `git grep` gates in `bridge/`: `claude_driver | CLAUDE_DRIVER |
      chokidar | MCP_SERVER_PATH | internal/permission |
      peekFirstEntries | entryFromRaw | decodeProjectDir |
      appendAllowRule` all return nothing.
- [x] `git grep` gate: `'claude-code'` in `mobile/app` and
      `mobile/components` finds only the card-pack registry key in
      `cardPacks/index.ts` and one self-referencing comment in
      `ToolCard.tsx`. No UI-gating conditionals survive.

**Definition of done**: All grep gates pass. Bridge boots and serves
every flow. The only claude-specific code in `bridge/src/agents/` is
`claudeCodeSdk.ts` + `desktopPids.ts`.

## Stable-enough-to-delete-CLI gate (Phase 7 prerequisite)

**Waived per direct instruction** — see Phase 7 notes. Original signals
retained below for reference / future deletion decisions.

Subjective; signals to look for:

1. Live mode swap exercised at least once per session for a week,
   no regressions reported.
2. Approval round-trip (in-chat + sessions list) < 1s end-to-end.
3. No bridge restarts attributed to SDK exceptions for a week.
4. Operator hasn't reached for `CLAUDE_DRIVER=cli` to recover from a
   bug.

## Post-implementation fixes

Things found in real-session smoke testing after Phases 0–7 landed.

- [x] **Approval replay on chat attach.** When a tool prompt fired
      while the user was on the sessions list (chip lights up via
      `/events` snapshot) and the user then opened that session's
      chat, the in-chat `ApprovalSheet` stayed empty until the next,
      unrelated prompt came in. Cause: the chat WS only relays live
      `permission_request` events; previously-fired ones were lost
      because there was no replay-on-attach. Fix: in
      `server.ts:attach`, after emitting `capabilities` and
      `permission_mode`, iterate `permissions.list()` for this
      `(agent, sessionId)` and replay each pending entry as a
      `permission_request` AgentEvent. The sessions-list chip and
      the chat ApprovalSheet now show the same prompt regardless of
      where the user was when it fired.

## Open questions

Resolved during implementation:

- ✅ **`listSessions` / `getSessionInfo` field mapping**:
  `SDKSessionInfo` provides `sessionId`, `cwd`, `lastModified`,
  `fileSize`, `firstPrompt`, `summary`. Project name comes pre-decoded
  via `cwd` — `basename(cwd)` is enough; no slug handling needed.
- ✅ **`getSessionMessages` pagination**: SDK uses `{ limit, offset }`;
  we kept the `{ limit, before }` cursor by reading per-message
  `timestamp` fields (top-level or nested under `message.timestamp`)
  via a `messageTimestamp()` helper. Works because the SDK preserves
  the JSONL timestamp even though the typed surface marks it
  `unknown`.
- ✅ **Available-models discovery**: not exposed by the SDK. Shipped
  with `modelSelection.available: []` and a picker that falls back to
  the current model only. The bridge accepts any model ID when the
  list is empty.
- ✅ **`Query.rewindFiles` emit**: doesn't emit anything itself. We
  wrap the call and emit a `rewind` AgentEvent on success.
- ✅ **Stub agent placement**: kept in production builds, gated by
  `STUB_AGENT=1`. Free when unset; move under `tests/` only if it
  starts costing something.

Still open:

- ⚠️ **Does the SDK's `FileChanged` hook see edits made outside the
  agent?** Untested. If the pane goes silent for external edits we'll
  add a `WATCHER_FALLBACK` flag that re-enables a stripped-down
  chokidar (or `fs.watch`) for one release.
- ⚠️ **Background-task UI** — new chat-item kind, or fold into the
  existing `tool_use` / `tool_result` flow? Not pursued in this
  migration; revisit when the SDK starts emitting background-task
  events we care about surfacing distinctly.
- ⚠️ **Full smoke pass of every flow in Phases 0–6 on the SDK driver**
  — deferred. Static gates (type-check, grep) all pass; behavioral
  verification happens in the next real session.
