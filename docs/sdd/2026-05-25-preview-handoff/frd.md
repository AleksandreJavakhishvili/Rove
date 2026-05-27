# Functional Requirements — Preview Handoff (user-direction)

Inverse-direction follow-on to
[`preview-takeover`](../2026-05-25-preview-takeover/). The takeover
SDD ships **agent-direction** — agent briefly commandeers the preview
to verify its work. This one ships **user-direction** — agent asks the
user to set up preview state (log in, navigate, prep data) and waits
for the user to signal "ready."

## Dependency

This effort assumes the takeover SDD has landed (all phases —
including Phase 0's global settings gate). Specifically:

- `enableVisualFeedback` setting exists in `useHydratedSettings`
  and is plumbed through the bridge via the
  `set_visual_feedback_enabled` WS frame. `prepare_preview` plugs
  into the **same** gate — no second setting.
- `alwaysAskBeforeCapture` Settings sub-option suppresses the
  "Always allow" button for `prepare_preview` too.
- `previewDirectionMachine.ts` exists with `direction: 'agent'` /
  `policy: 'debounce'` as the shipped variants. This SDD extends
  those unions to add `'user'` / `'explicit'`.
- `<TakeoverController>` exists in
  `mobile/components/takeover/`. This SDD renames it (or wraps it
  with a thin supervisor) so it can host either direction. No
  parallel reducer.
- `validatePreviewPath` exists. This SDD reuses it for the
  `suggestedPath` argument — no second validator.
- The bridge `screenshotBroker.ts` / dispatcher registry exists.
  This SDD adds a parallel `handoffBroker.ts` that reuses the
  same dispatcher map keyed by sessionId.

If the takeover SDD hasn't landed, this work is blocked.

## Problem

Once `take_screenshot` works (visual-feedback-loop) and the takeover
mode makes captures reliable (preview-takeover), one practical gap
remains: **the agent often needs the preview to be in a particular
state before capturing can be useful.**

Concrete examples:

- **Routes behind auth.** Agent wants to verify `/admin`; cold
  session, no login, server redirects to `/login`, capture is
  useless. Even with the takeover SDD's `resolvedUrl` echo, the
  agent has burned a tool call to produce nothing.
- **Stateful flows.** Verifying the cart layout needs items in the
  cart. Verifying onboarding step 4 needs the user past steps 1–3.
- **Environment quirks.** Toggles, feature flags, dark mode, role
  switching — anything the user controls through the running app
  is invisible to the agent.

The agent has the context to anticipate these (it built the app, it
reads middleware, it sees CLAUDE.md). We let the model decide *when*
to hand off, via an explicit MCP tool call, instead of heuristically
detecting "this is a login page" after-the-fact.

## Goals

1. **`prepare_preview` MCP tool** — agent calls it with
   `instructions` (and optional `suggestedPath`), user gets an
   explicit ask, agent gets back a typed `ready` / `skipped` /
   `cancelled` / `timeout` result.
2. **Visible, considered UX** — a modal sheet first (this is an
   ask, not a brief capture), shrinking to a top pill once the
   user has opened the preview, so they can interact with the
   WebView while seeing the in-flight request.
3. **Single state machine, extended** — reuse the takeover
   reducer with new `direction: 'user'` + `policy: 'explicit'`
   variants. No second reducer.
4. **Permission flow reused** — first `prepare_preview` call this
   session goes through canUseTool / ApprovalSheet with tailored
   copy. Allow-always per tool — independent from the
   `take_screenshot` grant.
5. **Manual-shutter coordination** — while a handoff is `active`,
   the manual shutter button is disabled. That's the only
   cross-mode guard needed; the SDK is sequential, so two agent
   tools cannot fire concurrently.
6. **Clean lifecycle composition** — when the agent calls
   `take_screenshot` immediately after `prepare_preview` resolves
   `ready`, the controller can hand off directly between modes
   without restoring + re-engaging the pager (avoids visible
   flicker between handoff exit and takeover entry).

## Non-goals

- A separate "direction supervisor" component or framework. The
  shared reducer + a single disable-line on the manual shutter is
  enough.
- Auto-trigger ("the agent automatically calls prepare_preview
  when it sees an auth-protected route in source"). The agent
  decides.
- Two independent parallel state machines. Same reducer.
- Bridge-side auth detection. Out of scope.
- Recording user actions during handoff for replay. Way out of
  scope.

## Personas

- **Vibecoder hitting an auth wall.** Agent makes a change to the
  admin dashboard. Knows it'll need login. Calls `prepare_preview
  ('Please log in to admin')`. User sees a modal, opens preview,
  logs in, taps Done. Agent verifies.
- **Setup-heavy debugger.** Agent wants to verify the empty-cart
  state vs the full-cart state. Asks user to clear the cart, then
  captures, then asks user to fill the cart, then captures.

## User stories

### Asking for handoff (H1)

- **H1a.** As an agent that knows the next verification needs
  prepared state (auth, cart, wizard, feature flag), I call
  `prepare_preview({ instructions, suggestedPath? })`. The user
  sees an explicit ask before any capture happens.
- **H1b.** As an agent, the first call this session goes through
  the standard `canUseTool` permission prompt with friendly copy
  ("Claude wants to ask you to set up the preview"). Allow-always
  applies for the rest of the session — independent from
  take_screenshot's grant.
- **H1c.** As an agent, my call returns a typed text result —
  `ready: <finalUrl>` / `skipped: <optional note>` / `cancelled` /
  `timeout` — so I can pattern-match without parsing prose.

### During handoff (H2)

- **H2a.** As a user, when the agent calls `prepare_preview` I see
  a bottom-sheet modal with the agent's instructions, a primary
  "Open Preview" button (which swaps to preview mode and
  optionally navigates to `suggestedPath`), and "Done" / "Skip"
  actions.
- **H2b.** As a user, after tapping "Open Preview" the modal
  cross-fades to a top pill ("Preparing — *<instructions snippet>*")
  with "Done" / "Cancel" so I can interact with the WebView while
  seeing the in-flight ask. The pill stays visible until I signal
  completion or the timeout fires.
- **H2c.** As a user, the pager swipe + segment toggle + burger
  sidebar + manual shutter are locked during handoff the same way
  they are during agent-direction takeover. The only navigation I
  can do is *inside* the WebView.
- **H2d.** As a user, when I tap "Done" the phone reads the
  WebView's current URL (via the takeover SDD's
  `PreviewFrameHandle.currentUrl()`) and sends
  `prepare_preview_result { status: 'ready', finalUrl }` back to
  the bridge.
- **H2e.** As a user, when I tap "Skip" I can optionally type a
  one-line note ("I'm not going to log in for this") which the
  agent receives in the tool result.
- **H2f.** As a user, when I tap "Cancel" — or the handoff times
  out — the agent gets `cancelled` / `timeout` respectively.

### Lifecycle composition (H3)

- **H3a.** As an agent, after `prepare_preview` resolves `ready`
  I can immediately call `take_screenshot`; the capture sees the
  state the user just prepared.
- **H3b.** As the controller, when a `request_screenshot` arrives
  within `HANDOFF_TO_CAPTURE_GRACE_MS` (~500ms) of a
  `prepare_preview` resolving `ready`, I stay engaged — the pill
  morphs from "Preparing" to "Verifying" without the pager
  restore + re-engage cycle. The takeover SDD ships with the
  agent-only single-shot lifecycle; this SDD adds the cross-mode
  bridge.
- **H3c.** As an agent that explicitly does *not* want to capture
  immediately after a handoff (e.g. it's going to do some code
  edits first), the grace window expires, the controller restores
  normally, the next `take_screenshot` re-engages from idle.

## Functional requirements

- **F1. `prepare_preview` MCP tool.** Registered on the same
  in-process MCP server as `take_screenshot`. Args:
  - `instructions: string` — required, max length enforced
    server-side.
  - `suggestedPath?: string` — optional dev-server-relative path,
    validated by the shared `validatePreviewPath`.
  - `timeoutSeconds?: number` — clamped to a sane range (default
    300, cap 1800).
  Result: a text content block whose first token is a stable
  machine-readable status — `ready`, `skipped`, `cancelled`, or
  `timeout` — followed by optional human details.
- **F2. New wire frames:**
  - `ServerToClient`: `{ type: 'prepare_preview_request';
    requestId; instructions; suggestedPath?; timeoutSeconds? }`
  - `ClientToServer`: `{ type: 'prepare_preview_result';
    requestId; status: 'ready' | 'skipped' | 'cancelled';
    finalUrl?; note? }`
  - `timeout` is bridge-side only — phone never sends it; the
    broker timeout produces the tool's `timeout` text result.
- **F3. Reducer extension.** The shared `previewDirectionMachine`
  unions widen:
  ```ts
  Direction = 'agent' | 'user';
  Policy    = 'debounce' | 'explicit';
  ```
  New events: `done_tapped`, `skip_tapped` (with optional note),
  `cancel_tapped` (already exists from takeover), `open_preview_tapped`,
  `timeout_fired`. New states: `modal` (between requesting and
  engaging when direction='user'). New effects: `reply_handoff`,
  `show_modal`, `morph_to_pill`.
- **F4. Modal-then-pill UX.** Initial modal sheet shows the agent's
  instructions and three buttons (Open Preview / Skip / Cancel).
  Tapping "Open Preview" cross-fades the modal into the top pill.
  Animation: 250ms cross-fade; no morph-shape complexity.
- **F5. Permission flow.** First `prepare_preview` call this session
  goes through `canUseTool` with the friendly copy from the same
  lookup table that handles `take_screenshot`. The permission grant
  is per-tool — allow-always for `take_screenshot` does NOT
  auto-allow `prepare_preview`, and vice-versa.
- **F6. Manual-shutter coordination.** While a handoff is `active`,
  the manual shutter button in WorkspacePane is disabled (dimmed
  with a tooltip explaining "agent is asking for setup"). This is
  the ONLY cross-mode coordination shipped. We do NOT build a
  direction-supervisor — manual capture is a user-driven UI path,
  not a tool call.
- **F7. Per-session toggle parity.** The same header-menu kill
  switch ("Disable visual verification") disables both tools. If
  the user doesn't want the agent driving the preview at all,
  both shut off together. (Future: split into two toggles if the
  asymmetry matters in practice.)
- **F8. Drop auth heuristics.** The bridge does not inspect the
  WebView's resolved URL for auth intent. The agent's choice of
  `take_screenshot` vs `prepare_preview` is the only signal.
- **F8a. Global setting honored.** `prepare_preview` tool handler
  short-circuits to `disabled_by_user` text result whenever the
  takeover SDD's `enableVisualFeedback` setting is off for the
  session. Same gate, same wire frame
  (`set_visual_feedback_enabled`) — no second toggle.
- **F9. Handoff-to-capture bridge.** When the agent fires
  `take_screenshot` within `HANDOFF_TO_CAPTURE_GRACE_MS` of a
  `prepare_preview` resolving `ready`, the controller transitions
  directly from `exiting` (handoff) to `active` (takeover) without
  the restore step. Otherwise normal lifecycle.
- **F10. Skip-note input.** The "Skip" path optionally collects a
  one-line note (max length capped). The note is included on the
  result as `note?: string` and surfaces in the tool's text result
  as `skipped: <note>`.

## Non-functional requirements

- **N1. Handoff timeout default: 300 seconds (5 minutes).** Picked
  from intuition without data — revisit once we have real usage.
  Configurable per-call via `timeoutSeconds`, capped at 1800 (30
  min) so a stuck request can't pin the broker forever.
- **N2.** Modal sheet must use the same safe-area + KeyboardAvoidingView
  treatment as the existing `ScreenshotComposer` so the keyboard
  doesn't cover "Done" when the user types a skip note.
- **N3.** Reducer continues to be a pure function with unit tests
  covering both directions + both policies. New transitions land
  in the same file.
- **N4. Cross-fade animation 250ms.** Pinned. No morph-shape
  variants.
- **N5. Grace window default: 500ms.** Picked from intuition;
  revisit once observed.

## Limitations (worth documenting, not fixing)

- **Agent might not call `prepare_preview` when it should.** The
  tool description is the model's only nudge. If the agent forgets,
  it'll capture a login page and confidently describe it. The
  takeover SDD's `resolvedUrl` echo gives the model a chance to
  notice and self-correct on the next call. Don't bake heuristic
  detection into the bridge.
- **Manual shutter disabled during handoff feels heavy-handed if
  the handoff is long.** Mitigation: the user can tap Cancel on
  the pill to free everything. Documented.
- **Skip-loop.** If the user Skips every prepare_preview the agent
  asks, the agent has to adapt. We rely on the model's
  pragmatism + the rate limiter as a safety net (the limiter
  doesn't distinguish between handoff and screenshot calls — same
  bucket).

## Definition of done

- `prepare_preview` MCP tool registered on the same in-process MCP
  server, gated via `canUseTool` independently from
  `take_screenshot`.
- `prepare_preview_request` + `prepare_preview_result` wire frames
  ship on both bridge and mobile with shared enum constants
  (`HANDOFF_RESULT_STATUS`).
- `previewDirectionMachine` reducer extended with new directions,
  policies, events, states, effects. Reducer unit tests cover the
  new transitions + the cross-direction grace window.
- `<HandoffSheet>` + `<HandoffPill>` ship.
- `<TakeoverController>` (or renamed `<PreviewDirectionController>`)
  hosts both directions through the same reducer.
- Permission-prompt copy lookup covers `mcp__rove__prepare_preview`
  with friendly text.
- Manual-shutter button disabled while handoff `active`.
- Smoke punch-list checked on a real device:
  - Auth flow (modal → preview → user logs in → Done → ready).
  - Skip + note flow.
  - Cancel flow.
  - Timeout flow.
  - Handoff-to-capture grace window: agent calls take_screenshot
    immediately after ready, controller skips the restore.
- `pnpm exec tsc --noEmit` clean on both projects.
- All new constants follow the "no magic strings/numbers" rule
  established by the visual-feedback-loop SDD.
