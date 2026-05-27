# Plan — Preview Handoff (user-direction)

Reference: [frd.md](./frd.md), [hla.md](./hla.md),
[preview-takeover](../2026-05-25-preview-takeover/) (required
dependency), [visual-feedback-loop](../2026-05-25-visual-feedback-loop/).

## Status

**Both phases (1 / 2) implemented and `pnpm exec tsc --noEmit` clean
on both projects. Reducer unit tests pass (32/32 including new
handoff transitions).** Remaining work is the real-device smoke pass,
deferred to a separate session.

## Required prior work

- The full preview-takeover SDD (all three phases — Phase 0
  settings, Phase 1 controller, Phase 2 navigation/polish) must
  have landed before this effort starts. Specifically:
  - The `enableVisualFeedback` + `alwaysAskBeforeCapture`
    settings store fields, the Settings UI, the
    `set_visual_feedback_enabled` WS frame, and the bridge's
    per-session `isVisualFeedbackEnabled` map (Phase 0).
  - The reducer file (`previewDirectionMachine.ts`), the
    controller component, the imperative handles on pager /
    workspace / preview frame, the `validatePreviewPath` helper,
    and the `<TakeoverIndicator>` (Phases 1–2).

## Overview

Two phases:

1. **Phase 1 — Wire + tool + reducer extension.** Add the
   `prepare_preview` MCP tool, the new WS frames, the new
   constants, the new bridge broker, and extend the shared reducer.
   Mobile gets the new states + effect interpretation but UI is
   minimal (uses raw `Alert`s as a placeholder).
2. **Phase 2 — Modal + pill UX + handoff-to-capture grace + smoke.**
   Build the polished `<HandoffSheet>` and `<HandoffPill>`,
   implement the cross-direction grace window, run smoke on a real
   device.

Each phase ships independently. Phase 1 is the protocol; Phase 2
is the UX.

## Definition of done (whole effort)

- `prepare_preview` honors the takeover SDD's
  `enableVisualFeedback` global setting + the
  `alwaysAskBeforeCapture` sub-option. No new settings introduced.
- `prepare_preview` MCP tool registered with per-tool
  canUseTool gate.
- `prepare_preview_request` + `prepare_preview_result` wire frames
  + `HANDOFF_RESULT_STATUS` + all timing constants exist on bridge
  and mobile. No magic strings or numbers.
- `previewDirectionMachine` reducer accepts both directions
  + both policies. Unit tests cover every new transition.
- `<HandoffSheet>` (modal) + `<HandoffPill>` (top pill) ship.
- Handoff-to-capture grace window works (smoke verified).
- Manual shutter disabled while handoff `active`.
- Approval-sheet copy lookup covers `prepare_preview`.
- Smoke punch-list checked.
- `pnpm exec tsc --noEmit` clean on both projects.

## Phase 1 — Wire + tool + reducer extension

Branch: `2026-05-25-preview-handoff-phase1-wire`

Goal: agent can call `prepare_preview` and get back a typed
result. UI is placeholder (Alert with three buttons) — Phase 2
makes it pretty.

### LLD (write first)

- [x] **`handoff-machine-lld.md`** — pin down:
  - Exact widened state / event / effect TS unions in
    `previewDirectionMachine.ts`.
  - Full transition table for the new events.
  - Phone-side timeout vs broker-side timeout responsibility split.
  - Cross-broker dispatcher-registry sharing pattern.

### Bridge

- [x] **`bridge/src/agents/types.ts`** — add:
  - `HandoffResultStatus` union + `HANDOFF_RESULT_STATUS` const +
    `HANDOFF_RESULT_STATUSES` derived tuple.
  - `PREPARE_PREVIEW_MCP_TOOL_NAME` +
    `PREPARE_PREVIEW_MCP_TOOL_QUALIFIED`.
  - `HANDOFF_DEFAULT_TIMEOUT_SECONDS`,
    `HANDOFF_MAX_TIMEOUT_SECONDS`,
    `HANDOFF_INSTRUCTIONS_MAX_LEN`,
    `HANDOFF_NOTE_MAX_LEN`,
    `HANDOFF_TO_CAPTURE_GRACE_MS`,
    `HANDOFF_MODAL_FADE_MS` constants.
- [x] **`bridge/src/types.ts`** — extend `ServerToClient` with
  `prepare_preview_request`. Extend `ClientToServer` with
  `prepare_preview_result` (status / finalUrl / note fields).
- [x] **`bridge/src/screenshotBroker.ts`** — export the
  `dispatchers` map + `registerDispatch` / `unregisterDispatch` /
  `getDispatch` helpers so the handoff broker can reuse them.
  Rename the file internally? No — too disruptive. Just export.
- [x] **`bridge/src/handoffBroker.ts`** (NEW). Mirrors
  `screenshotBroker.ts`:
  - `pendingHandoffs: Map<requestId, { sessionId; resolve;
    timer }>`.
  - `requestHandoff(sessionId, options, dispatch): Promise<HandoffOutcome>`.
  - `resolveHandoff(requestId, payload)`.
  - `cancelHandoffsForSession(sessionId, reason)`.
  - Reuses the screenshotBroker dispatcher registry.
- [x] **`bridge/src/agents/claudeCodeSdk.ts`** — register the
  second tool on the same MCP server:
  ```ts
  sdkTool(
    PREPARE_PREVIEW_MCP_TOOL_NAME,
    'Ask the user to prepare the preview ...',
    {
      instructions: z.string().min(1).max(HANDOFF_INSTRUCTIONS_MAX_LEN),
      suggestedPath: z.string().optional(),
      timeoutSeconds: z.number().int().min(1).max(HANDOFF_MAX_TIMEOUT_SECONDS).optional(),
    },
    async (args) => this.handlePreparePreview(args),
  )
  ```
  Handler gates in order:
  1. `isVisualFeedbackEnabled(sessionId)` — inherited from
     takeover Phase 0. Off → `disabled_by_user`.
  2. Per-session header toggle.
  3. `getDispatch(sessionId)` — no_client.
  4. Rate limit (shared bucket).
  5. Broker round-trip → format text result.
- [x] **`bridge/src/server.ts`** — Zod schema for
  `prepare_preview_result`. Route to
  `handoffBroker.resolveHandoff`. On WS close: drain both brokers
  (already drains screenshotBroker; add handoffBroker drain).

### Mobile

- [x] **`mobile/lib/types.ts`** — mirror new wire frames + the
  `HANDOFF_RESULT_STATUS` constant + timing constants.
- [x] **`mobile/components/takeover/previewDirectionMachine.ts`**
  (modify) — widen `Direction` and `Policy` unions; add `modal`
  state; add `open_preview_tapped`, `done_tapped`, `skip_tapped`,
  `timeout_fired` events; add `show_handoff_modal`,
  `morph_to_pill`, `reply_handoff`, `arm_handoff_timeout` effects.
  Extend `reduce` to handle them. Unit tests for every new row.
- [x] **`mobile/components/takeover/useTakeover.ts`** (modify) —
  interpret the new effects. For Phase 1, the new effects fire
  raw `Alert.alert` calls as placeholders for the
  modal/pill (replaced in Phase 2).
- [x] **`mobile/components/takeover/TakeoverController.tsx`**
  (modify) — also subscribe to `prepare_preview_request` WS
  frames and dispatch into the reducer.
- [x] **`mobile/components/takeover/toolLabels.ts`** (modify) —
  add the `prepare_preview` entry. Also extend the
  `alwaysAskBeforeCapture` lookup so the `<ApprovalSheet>`'s
  "Always allow" suppression applies to
  `mcp__rove__prepare_preview` in addition to
  `mcp__rove__take_screenshot`.
- [x] **`mobile/app/sessions/[agent]/[id]/index.tsx`** (modify) —
  add a `prepare_preview_request` case to the WS message switch
  that forwards to the controller's subscriber.

### Definition of done (Phase 1)

- [x] Agent can call `prepare_preview` in a Claude Code session;
      tool returns a typed text result.
- [x] First call this session shows the canUseTool permission
      sheet (with the basic fallback copy — friendly text comes
      in Phase 2).
- [x] Reducer unit tests cover the new transitions.
- [x] WS round-trip works end-to-end: agent → bridge tool →
      broker → WS frame → phone Alert → user taps something →
      reply → tool resolves.
- [x] Backgrounding the app mid-handoff drains via
      `cancelHandoffsForSession`; agent gets `cancelled`.
- [x] `pnpm exec tsc --noEmit` clean.

---

## Phase 2 — Modal + pill UX + grace window + smoke

Branch: `2026-05-25-preview-handoff-phase2-ux`

Goal: replace the placeholder Alerts with the considered
modal-then-pill UX; implement the cross-direction grace window;
smoke on a real device.

### Mobile

- [x] **`mobile/components/handoff/HandoffSheet.tsx`** (NEW).
  Bottom-sheet modal:
  - Title: "Claude needs your help"
  - Body: agent's `instructions` (already capped server-side
    at `HANDOFF_INSTRUCTIONS_MAX_LEN`).
  - "Open Preview" primary button.
  - "Skip" + "Cancel" secondary actions.
  - Skip action optionally expands a single-line input
    (capped at `HANDOFF_NOTE_MAX_LEN`) before sending the reply.
  - Safe-area + KeyboardAvoidingView.
- [x] **`mobile/components/handoff/HandoffPill.tsx`** (NEW).
  Top pill once user taps "Open Preview":
  - Subtle pulse on a leading icon.
  - Truncated instructions line.
  - `Done` + `Cancel` trailing buttons.
  - Uses same safe-area treatment as `<TakeoverIndicator>`.
- [x] **`useTakeover` / interpreter** — replace the Phase 1
  Alert placeholders with real sheet/pill mounting.
  Cross-fade animation 250ms (`HANDOFF_MODAL_FADE_MS`).
- [x] **Handoff-to-capture grace window.** When the reducer
  produces a `reply_handoff` effect with `status: 'ready'`, arm
  a `HANDOFF_TO_CAPTURE_GRACE_MS` timer. If a new
  `request_screenshot` arrives before it fires, instead of going
  through normal exit + re-engage, dispatch a
  `handoff_to_capture_bridge` synthetic event that takes the
  reducer directly to `engaging` with the new direction. Otherwise
  the timer fires and normal exit completes.
- [x] **Manual shutter coordination.** Pass a `disabled` prop into
  `<PreviewShutter>` from the controller; set true while the
  current state has `direction: 'user'` and `kind` ∈ {modal,
  engaging, active}. Tooltip: "Claude is asking you to set up
  the preview — finish that first."
- [x] **toolLabels.ts** — confirm the friendly copy for
  `prepare_preview` reads well in the approval sheet.

### Smoke pass

- [ ] On a real iPhone against a real auth-protected dev server:
  - [ ] Agent calls `prepare_preview('Please log in to /admin',
        '/admin')` → modal opens with the instructions visible.
  - [ ] First call: permission sheet shows the friendly copy;
        allow-always grants.
  - [ ] User taps "Open Preview" → modal cross-fades to pill,
        pager swaps to preview, WebView lands on /admin
        (redirects to /login).
  - [ ] User logs in inside the WebView, lands on /admin.
  - [ ] User taps "Done" → tool resolves with
        `ready: /admin`, mode exits, pager restores after the
        grace window.
- [ ] **Skip flow:** user taps "Skip" + types a note → tool
      resolves with `skipped: <note>`.
- [ ] **Cancel flow:** user taps "Cancel" → tool resolves with
      `cancelled`.
- [ ] **Timeout:** agent calls with `timeoutSeconds: 60`, user
      does nothing → broker fires timeout, tool resolves with
      `timeout`.
- [ ] **Grace window happy path:** agent calls `prepare_preview`
      then immediately calls `take_screenshot` after user taps
      Done. Controller skips the restore + re-engage; pill copy
      transitions "Preparing" → "Verifying" in place.
- [ ] **Grace window expiry:** agent calls `prepare_preview`,
      user taps Done, agent does NOT immediately call
      `take_screenshot`. Controller restores normally after the
      500ms window.
- [ ] **Manual shutter:** while handoff is `active`, the
      shutter button is visibly disabled.
- [ ] **Backgrounding the app mid-handoff** → broker drains with
      `cancelled` after timeout; UI cleans up on resume.
- [ ] **Per-session toggle off** → both tools short-circuit to
      `disabled_by_user`.
- [ ] **Global setting off** (`enableVisualFeedback === false`):
      `prepare_preview` tool returns `disabled_by_user`
      immediately; no modal ever appears.
- [ ] **`alwaysAskBeforeCapture === true`:** first
      `prepare_preview` call shows the approval sheet **without**
      the "Always allow" button; second call re-prompts.

### Definition of done (Phase 2)

- [x] `<HandoffSheet>` + `<HandoffPill>` ship and replace the
      placeholder Alerts.
- [x] Cross-fade animation 250ms; serialised with pager swap (not
      parallel).
- [ ] Grace window verified in smoke (both happy + expiry).
- [x] Manual shutter coordination verified.
- [x] Friendly approval-sheet copy verified.
- [ ] Smoke punch-list checked.
- [x] `pnpm exec tsc --noEmit` clean.

---

## Deferred follow-ups (not in scope)

- **Split per-tool kill switches.** Today the header toggle
  disables both tools. If users want finer control we'd split.
  Holding off until smoke shows it matters.
- **Visible chat-side handoff log.** A meta line in chat
  ("Claude asked you to: 'log in'. You: ready → /admin") would
  help going back through what happened in a session. Trivial
  once the wire frames land; held until smoke shows the raw flow
  works.
- **Tool-name-based usage telemetry** to detect skip-loops.
- **Configurable per-call grace window** if 500ms turns out to
  be wrong. Today it's a fixed constant.
- **Smarter handoff timeout default** if we get real usage data.
  Today's 5-minute default is an intuition.
