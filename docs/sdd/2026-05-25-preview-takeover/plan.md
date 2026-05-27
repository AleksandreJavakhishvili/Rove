# Plan — Preview Takeover Mode

Reference: [frd.md](./frd.md), [hla.md](./hla.md),
[visual-feedback-loop](../2026-05-25-visual-feedback-loop/),
[preview-handoff](../2026-05-25-preview-handoff/) (paired follow-on).

## Status

**All three phases (0 / 1 / 2) implemented and `pnpm exec tsc
--noEmit` clean on both projects. Reducer unit tests pass (32/32).**
Remaining work is the real-device smoke pass which is intentionally
deferred to a separate session.

## Overview

Three phases, ranked by independent shippability:

0. **Phase 0 — Global setting + gate plumbing.** The persisted
   `enableVisualFeedback` switch + the "Always ask" sub-option,
   the Settings UI, the first-run onboarding hint, and the four
   gate sites (shutter, controller, approval sheet, bridge tool
   handler) all wired to honor the setting. Default OFF, opt-in.
1. **Phase 1 — State machine, controller, imperative handles, mode
   restoration.** The complete refactor + the auto-engage / auto-exit
   lifecycle. After this lands, the chat screen owns zero takeover
   logic and the mode is visible/interruptable.
2. **Phase 2 — Path navigation + validation, `resolvedUrl`,
   permission-prompt polish.** WebView navigation honoring the `path`
   argument with input validation, the `resolvedUrl` echo so the
   agent notices redirects, the friendly approval-sheet copy lookup,
   and the smoke pass on a real device.

Phase 0 is the privacy/consent foundation — it ships first because
both following phases depend on the gate being in place. Phase 1 is
the architectural correction; Phase 2 is the rounding-off.

## Definition of done (whole effort)

- `enableVisualFeedback` + `alwaysAskBeforeCapture` settings ship,
  persisted, default `false`.
- `/settings` screen renders the "Visual feedback" section.
- All four gate sites (shutter, controller, approval sheet, bridge
  tool handler) honor the global setting; turning it off cleanly
  removes the feature from the user's experience.
- First-run onboarding hint shown once per device.
- `previewDirectionMachine.ts` ships as a pure reducer with unit
  tests covering every transition + the debounce policy. State
  carries `direction: 'agent'` and `policy: 'debounce'` so the
  handoff SDD extends without restructuring.
- `<TakeoverController>` mounted in the chat screen subsumes today's
  inline `handleScreenshotRequest`. Chat screen line-count drops; no
  takeover state lives outside the controller.
- `<TakeoverIndicator>` ships with pulse + cancel; reads the in-flight
  `path` (or "current view" fallback).
- `ChatPreviewPagerHandle.setLocked`, `WorkspacePaneHandle.setMode`,
  `WorkspacePaneHandle.setLocked`, `PreviewFrameHandle.navigate`,
  `PreviewFrameHandle.currentUrl` all ship with imperative
  `useImperativeHandle` exports.
- WebView `path` argument honored — `injectJavaScript('location.assign…')`
  + `onLoadEnd` settle + cushion.
- `validatePreviewPath` helper exists, exercised on every path arg.
- `screenshot_result` carries optional `resolvedUrl`; SDK tool result
  includes a `resolved_url: …` text block.
- Approval-sheet copy lookup ships with
  `mcp__rove__take_screenshot` mapped to friendly text.
- Debounce-exit auto-cleanup verified.
- `pnpm exec tsc --noEmit` clean on both projects.
- All new constants follow the "no magic strings/numbers" rule
  established by the visual-feedback-loop SDD.

## Phase 0 — Global setting + gate plumbing

Branch: `2026-05-25-preview-takeover-phase0-settings`

Goal: persisted opt-in setting that gates the entire visual-feedback
surface, with the Settings UI and the gate plumbing in every call
site. Ships before any of the takeover or handoff functional work
so privacy posture is correct from the first user-visible drop.

### LLD (write first)

- [x] **`visual-feedback-settings-lld.md`** — pin down:
  - Storage shape in `useHydratedSettings` + SQLite migration if
    any.
  - Exact copy for the Settings section + the first-run hint.
  - Whether to default-off-with-onboarding vs default-off-quiet.
    Decision: default-off + one-time hint when user enters a chat
    session.
  - Whether the chat-header per-session toggle hides entirely
    when global is off, or shows with disabled state. Decision:
    hide entirely — nothing to override.

### Mobile

- [x] **`mobile/lib/store.ts`** — extend `useHydratedSettings`
  with:
  ```ts
  enableVisualFeedback: boolean;          // default false
  alwaysAskBeforeCapture: boolean;        // default false
  visualFeedbackOnboardingShown: boolean; // default false
  setEnableVisualFeedback(b: boolean): Promise<void>;
  setAlwaysAskBeforeCapture(b: boolean): Promise<void>;
  markVisualFeedbackOnboardingShown(): Promise<void>;
  ```
  All three persist via the same SQLite mechanism the existing
  settings use.
- [x] **`mobile/app/settings.tsx`** — add "Visual feedback"
  section:
  - Master Switch row: "Enable visual feedback" with subtitle
    ("Let Claude verify changes by capturing your live preview.
    You'll still be asked before each new tool the first time.").
  - Conditional sub-row (visible when master is on): "Always ask
    before each capture" switch.
- [x] **`mobile/components/PreviewShutter.tsx`** — read
  `enableVisualFeedback`; return `null` when false.
- [x] **`mobile/components/takeover/TakeoverController.tsx`**
  (lands in Phase 1; this Phase ships the gate in the inline
  `handleScreenshotRequest` it eventually replaces) — drop
  incoming `request_screenshot` frames immediately when the
  setting is off (log + return).
- [x] **`mobile/components/chat/ApprovalSheet.tsx`** — when the
  tool name is one of the visual-feedback tools AND
  `alwaysAskBeforeCapture` is true, hide the "Always allow"
  button.
- [x] **First-run hint.** In `mobile/app/sessions/[agent]/[id]/index.tsx`,
  on mount, if `enableVisualFeedback === false &&
  visualFeedbackOnboardingShown === false`, push a one-time meta
  line into the chat ("💡 Visual feedback is off — enable in
  Settings if you want Claude to verify changes by capturing your
  preview.") and call `markVisualFeedbackOnboardingShown()`.
- [x] **`mobile/app/sessions/[agent]/[id]/index.tsx`** — on WS
  attach, send `set_visual_feedback_enabled { enabled: <current
  setting> }` so the bridge knows the current state. On settings
  change, send the frame again.
- [x] **Header menu** — hide the "Visual verification" toggle
  entirely when `enableVisualFeedback === false`.

### Bridge

- [x] **`bridge/src/types.ts`** — add
  `set_visual_feedback_enabled` to `ClientToServer` with `enabled:
  boolean` field.
- [x] **`bridge/src/screenshotBroker.ts`** — add per-session map:
  ```ts
  const visualFeedbackEnabled = new Map<string, boolean>();
  export function setVisualFeedbackEnabled(sessionId: string, b: boolean): void;
  export function isVisualFeedbackEnabled(sessionId: string): boolean;
  ```
  Default `false` when no entry exists (matches mobile default).
- [x] **`bridge/src/server.ts`** — Zod schema for the new frame;
  route to `setVisualFeedbackEnabled(id, parsed.enabled)`.
- [x] **`bridge/src/agents/claudeCodeSdk.ts`** — `handleTakeScreenshot`
  reads `isVisualFeedbackEnabled(this.sessionId)` as the **first**
  gate (before per-session toggle, before no_client, before rate
  limit). On false, return `disabled_by_user` immediately.

### Definition of done (Phase 0)

- [x] Settings screen shows the new section, persists changes.
- [x] Defaults verified: fresh install → all three booleans
      `false`; manual shutter hidden; tools short-circuit.
- [x] First-run hint shows exactly once.
- [x] Toggling the global setting on/off updates the bridge via
      `set_visual_feedback_enabled` and reflects immediately in
      the manual shutter visibility + agent tool behaviour
      without a session restart.
- [x] `alwaysAskBeforeCapture` on → "Always allow" button hidden
      on the approval sheet for the visual-feedback tools only.
- [x] `pnpm exec tsc --noEmit` clean on both projects.

---

## Phase 1 — State machine, controller, imperative handles

Branch: `2026-05-25-preview-takeover-phase1-controller`

Goal: takeover is a discrete, visible, interruptable mode. Chat screen
delegates the entire flow to a controller component.

### LLD (write first)

- [x] **`takeover-machine-lld.md`** — pin down:
  - Transition table (drafted in HLA).
  - Debounce policy (3s default, configurable).
  - Effect-descriptor shape.
  - State / event / effect TypeScript union shapes — specifically
    the `direction` and `policy` fields that the handoff SDD will
    later expand.
  - Timing cushion constant (~50ms after `onLoadEnd`).
  - Indicator fade duration (250ms).

### Mobile

#### State machine + hook

- [x] **`mobile/components/takeover/previewDirectionMachine.ts`** (NEW). Pure
  function:
  ```ts
  export type Direction = 'agent';   // 'user' added by handoff SDD
  export type Policy    = 'debounce';// 'explicit' added by handoff SDD

  type PreviewDirectionState =
    | { kind: 'idle' }
    | { kind: 'requesting'; direction: Direction; requestId: string; path?: string }
    | { kind: 'engaging';   direction: Direction; policy: Policy; requestId: string; path?: string; snapshot: PriorState }
    | { kind: 'active';     direction: Direction; policy: Policy; requestId: string; path?: string; snapshot: PriorState }
    | { kind: 'exiting';    direction: Direction; snapshot: PriorState };

  type PreviewDirectionEvent =
    | { kind: 'request'; direction: Direction; requestId: string; path?: string; waitMs?: number }
    | { kind: 'permission_granted' }
    | { kind: 'permission_denied' }
    | { kind: 'engaged' }
    | { kind: 'capture_complete' }
    | { kind: 'debounce_expired' }
    | { kind: 'cancel_tapped' }
    | { kind: 'ws_closed' }
    | { kind: 'exit_complete' };

  type PreviewDirectionEffect =
    | { kind: 'engage' }
    | { kind: 'capture'; requestId: string; path?: string; waitMs?: number }
    | { kind: 'cancel_in_flight'; requestId: string }
    | { kind: 'arm_debounce' }
    | { kind: 'restore' }
    | { kind: 'reply_denied'; requestId: string };

  export function reduce(
    state: PreviewDirectionState,
    event: PreviewDirectionEvent,
  ): { state: PreviewDirectionState; effects: PreviewDirectionEffect[] };
  ```
  Unit-tested for every transition in the table.

- [x] **`mobile/components/takeover/useTakeover.ts`** (NEW). React
  hook owning:
  - Local React state mirroring the machine state.
  - Refs to the pager / workspace / preview-frame handles.
  - The debounce timer + a cancel function.
  - Effect interpreter — translates effects into ref calls.
  - `dispatch(event)` exported so the controller can fire events
    from WS frames + UI taps.

#### Imperative handles

- [x] **`mobile/components/chat/ChatPreviewPager.tsx`** — extend
  handle with `setLocked(locked: boolean)`. While locked, the
  gesture detector's `.enabled(...)` clause is false; segment
  toggling continues to be the workspace's concern.
- [x] **`mobile/components/WorkspacePane.tsx`** — wrap in
  `forwardRef` + `useImperativeHandle`. Expose `setMode` and
  `setLocked`. Lock disables segment-toggle taps + dims the
  segment chrome.
- [x] **`mobile/components/chat/PreviewFrame.tsx`** — wrap in
  `forwardRef` + `useImperativeHandle`. Expose:
  - `navigate(url)` — injects `location.assign(JSON.stringify(url))`
    and resolves on the next `onLoadEnd` or after a timeout
    (`SCREENSHOT_WAIT_MS_CAP + cushion`). Document why
    `injectJavaScript` is used vs. updating the `source` prop —
    `source` reloads from scratch; `location.assign` is an in-page
    nav that the dev server's HMR + SPA-router will handle.
  - `currentUrl()` — returns the last URL reported by
    `onNavigationStateChange`. Best-effort; may lag SPA nav by a
    tick.

#### Controller + indicator

- [x] **`mobile/components/takeover/TakeoverController.tsx`** (NEW).
  Receives:
  - `pagerRef: RefObject<ChatPreviewPagerHandle>`
  - `workspaceRef: RefObject<WorkspacePaneHandle>`
  - `previewRef: RefObject<PreviewFrameHandle>`
  - `sendFrame: (msg: ClientToServer) => void`
  - `subscribeRequestScreenshot: (cb: (req: ...) => void) => () => void`
  - The session's `useScreenshotCapture` hook return value.

  Subscribes on mount, dispatches into `useTakeover`. Renders the
  `<TakeoverIndicator>` when state.kind ∈ {engaging, active,
  exiting}.

- [x] **`mobile/components/takeover/TakeoverIndicator.tsx`** (NEW).
  Floating top pill:
  - Pulse-fade animation on the leading dot.
  - Label: `"Verifying"` (state=engaging|active) | `"Done"`
    (state=exiting).
  - Optional sub-label: the in-flight path or "current view."
  - Cancel button on the trailing edge that calls a prop callback.
  - Uses safe-area inset top so it doesn't collide with the
    navigation header.

#### Chat-screen refactor

- [x] **`mobile/app/sessions/[agent]/[id]/index.tsx`** — delete
  inline `handleScreenshotRequest`. Add refs for `pagerRef`,
  `workspaceRef`, `previewRef`. Mount `<TakeoverController>`,
  pass refs + send function + capture hook + a request-subscriber
  callback. The WS message switch's `request_screenshot` case
  becomes a one-liner that forwards to the subscriber.

#### Constants

- [x] **`mobile/components/takeover/constants.ts`** (NEW). Named
  constants for the durations + cushions. No magic numbers in
  reducer or interpreter:
  ```ts
  export const TAKEOVER_DEBOUNCE_MS = 3_000;
  export const INDICATOR_FADE_MS = 250;
  export const PAGER_SWAP_SETTLE_MS = 240;          // matches pager animation
  export const WEBVIEW_LOAD_CUSHION_MS = 50;
  ```

### Definition of done (Phase 1)

- [x] Reducer unit tests cover every row of the transition table +
      the debounce policy. State carries `direction` and `policy`
      fields (always agent/debounce in this phase).
- [x] `<TakeoverController>` mounted in the chat screen.
- [x] Chat screen `handleScreenshotRequest` deleted.
- [x] Indicator appears + Cancel works.
- [x] Pager + workspace lock during takeover; unlock on exit.
- [x] Mode + pager index restore on debounce-expire / cancel.
- [x] `pnpm exec tsc --noEmit` clean.
- [ ] **Smoke (deferred to real-device pass at end of Phase 2).**

### Rollback plan (Phase 1)

If the refactor turns out to add more complexity than it removes
(measured by line count + cognitive overhead on the chat-screen file),
the rollback is straightforward: revert the chat-screen edits,
delete the `mobile/components/takeover/` directory, drop the
imperative-handle extensions. The wire model is unchanged so nothing
on the bridge needs touching.

---

## Phase 2 — Path navigation + validation + `resolvedUrl` + polish

Branch: `2026-05-25-preview-takeover-phase2-nav`

Goal: actually honor the `path` argument with validation; echo the
WebView's final URL back to the agent; refine the approval-sheet
copy; run the smoke pass.

### Mobile

- [x] **`mobile/components/takeover/pathValidator.ts`** (NEW).
  Pure function:
  ```ts
  export type PathValidation =
    | { ok: true; path: string }
    | { ok: false; reason: string };

  export function validatePreviewPath(input: string | undefined): PathValidation;
  ```
  Rules per HLA. Unit-tested.
- [x] **`mobile/components/takeover/toolLabels.ts`** (NEW). Lookup
  table mapping the qualified MCP tool name
  (`SCREENSHOT_MCP_TOOL_QUALIFIED`) → `{ label, summary(input) }`.
  Imported by the existing approval sheet; falls back to the
  current rendering for any unmapped tool.
- [x] **`mobile/components/chat/ApprovalSheet.tsx`** (or the
  pending-permission card on the sessions list) — consult
  `toolLabels.ts`. Confirm both surfaces render the friendly copy.
- [x] **`PreviewFrame.navigate` plumbed:** while in
  `state.kind === 'engaging' | 'active'`, the interpreter sees a
  `{ kind: 'capture', path, ... }` effect — runs
  `validatePreviewPath` first; on `ok:false` replies
  `capture_failed` with the validator's reason as `note` and
  dispatches `capture_complete`. On `ok:true` runs `navigate(path)`
  resolved against the dev-server origin, then captureAndUpload.
- [x] Settle policy: after `navigate(path)` resolves, wait
  `WEBVIEW_LOAD_CUSHION_MS` + a single `requestAnimationFrame`
  before captureRef to dodge the "WebView hasn't finished painting"
  blank-capture iOS quirk.
- [x] **`resolvedUrl` echo.** After captureRef, the interpreter
  reads `previewRef.currentUrl()` and includes it as `resolvedUrl`
  on the `screenshot_result` frame.

### Bridge

- [x] **`bridge/src/types.ts`** — extend `screenshot_result` Zod
  schema + `ClientToServer` interface with optional
  `resolvedUrl?: string`. No new enum.
- [x] **`bridge/src/screenshotBroker.ts`** — broker's success outcome
  carries through `resolvedUrl` (extend `ScreenshotOutcome`
  `ok: true` variant).
- [x] **`bridge/src/agents/claudeCodeSdk.ts`** — `handleTakeScreenshot`
  on the success path returns two content blocks:
  1. Image block with the PNG.
  2. Text block reading `resolved_url: <url>` (or
     `resolved_url: (unknown)` when omitted).
  The text block uses a shared constant for the prefix (no magic
  string) so the agent prompt / system message can describe it
  consistently.

### Smoke pass

- [ ] On a real iPhone against a real dev server:
  - [ ] User on Chat tab; agent calls `take_screenshot` → indicator
        appears, pager swaps to Preview, capture lands in next
        turn, pager swaps back after 3s.
  - [ ] Agent passes `path: '/about'` → WebView navigates, capture
        is of /about, `resolved_url: /about` in tool result.
  - [ ] Agent passes `path: 'https://evil.com'` → tool result is
        `capture_failed: absolute URL not allowed`.
  - [ ] Agent passes `path: '/admin'` on a route that redirects to
        `/login` → capture is of /login; `resolved_url: /login` is
        present so the agent can notice.
  - [ ] Agent chains two calls 1s apart → mode stays active across
        both, exits 3s after the second.
  - [ ] User taps Cancel mid-flight → `cancelled` tool result;
        mode exits immediately.
  - [ ] User backgrounds app → broker drains pending with
        `cancelled`; app resumes cleanly into idle.
  - [ ] Allow-always grant persists across captures within a
        session; deny stays deny.
- [ ] **Web build smoke:** confirm `useScreenshotCapture.supported
      === false`, no `<TakeoverController>` activity, MCP tool
      replies `no_client`.

### Definition of done (Phase 2)

- [x] Approval sheet shows friendly "view your live preview" copy
      for the take_screenshot tool.
- [ ] `path` argument honored — verified by smoke test.
- [x] `validatePreviewPath` rejects malformed/cross-origin/traversal
      inputs — verified by unit tests + one smoke test.
- [x] `resolvedUrl` populated on success; `resolved_url: …` text
      block visible to the agent.
- [x] Settle cushion in place; no blank captures in normal flow.
- [ ] Smoke punch-list checked.
- [x] Web build clean.
- [x] `pnpm exec tsc --noEmit` clean.

---

## Coordination with the handoff SDD

The handoff SDD (`docs/sdd/2026-05-25-preview-handoff/`) is the
inverse direction — agent asks user to set up state. Two
coordination points worth noting here so they don't get lost:

1. **Reducer shape.** `previewDirectionMachine.ts` ships with
   `direction: 'agent'` and `policy: 'debounce'` baked into the
   types — the handoff SDD extends those unions to add `'user'`
   and `'explicit'`. Phase 1's reducer tests should pin the union
   shape so handoff knows the contract.
2. **Manual shutter coordination.** Today the manual shutter button
   is enabled whenever the user is on the Preview tab. Once the
   handoff SDD lands, the shutter must be disabled while a
   user-direction handoff is `active` (otherwise a manual capture
   races the agent's request). Tracking this dependency in the
   handoff plan; no work in this SDD.

We are **not** building a "direction supervisor" — the SDK is
sequential, the manual shutter is a separate user-driven path, and
the handoff `active` state is the only context where a guard is
needed. One disable-button check in that SDD covers it.

---

## Deferred follow-ups (not in scope)

- **Lock WebView touches during takeover.** Currently the user can
  scroll the WebView during `active`; each touch extends the
  debounce. A stricter lock (pointer-events: none on the WebView)
  would prevent any user-induced page state changes mid-burst.
  Holding off until smoke shows whether this is a real problem.
- **Visible navigation history during takeover.** Show the path
  the agent visits in chat as a meta line ("Claude visited
  /checkout"). Cheap once the controller exists.
- **Bridge-side capture fallback** (when the phone is unavailable
  but the agent needs verification anyway). Inherits the deferred
  status from the visual-feedback-loop SDD.
- **Region capture.** Tap an element in preview, capture only its
  bounding box. Useful for "this specific component looks wrong"
  flows.
