# Functional Requirements — Preview Takeover Mode

Companion to `docs/sdd/2026-05-25-visual-feedback-loop/`. That SDD shipped
the `take_screenshot` MCP tool and the WS round-trip. This one defines
the **mode the phone enters** while the agent has temporarily
commandeered the live preview to verify its work — pager swap, lock,
indicator, navigation, auto-exit.

The inverse mode (agent asks the *user* to set up the preview state
via a `prepare_preview` MCP tool) lives in its own SDD:
`docs/sdd/2026-05-25-preview-handoff/`. The two efforts are paired but
ship serially; this one comes first.

## Problem

Phase 2 of the visual-feedback-loop SDD landed the wire — the agent can
call `take_screenshot` and the phone replies with pixels. Three honest
gaps remain on the phone:

- **The phone has no notion of "agent is currently capturing."** The
  capture happens silently mid-turn. The user has no signal that the
  agent just looked at their screen, no way to interrupt mid-burst,
  and no protection from the agent grabbing whatever happens to be on
  screen (chat tab, files tab, half-loaded route).
- **`captureRef` is unreliable when the WebView isn't visible.** iOS
  WKWebView suspends rendering when offscreen or `display:none`.
  Capturing a hidden WebView returns blank or stale pixels. The phone
  needs to *actually be on the preview* for the capture to be
  correct — and there's no logic today that ensures this.
- **Navigation (the `path` arg) is wired on the wire frame but ignored
  on the phone.** The wire model promises "agent says `/checkout`, phone
  navigates and captures." Reality: phone captures the current URL
  regardless. The agent has no way to verify a specific route without
  asking the user to navigate first.

Together: captures may be blank, the user can't see or intervene, and
the agent can't target specific routes.

## Goals

1. **Make agent capture a visible, interruptable mode** — not a silent
   background action.
2. **Guarantee the WebView is visible and settled before capture** so
   pixels are correct.
3. **Honor the `path` argument** — navigate, wait for the load to
   settle, then capture. Validate the argument so the agent can't
   accidentally request a cross-origin URL or a path-traversal.
4. **Auto-clean-up** — the mode exits on its own when the agent stops
   capturing, restoring the user's prior pager position and pane mode.
5. **Reuse the existing permission flow** — the first take_screenshot
   call this session goes through canUseTool / ApprovalSheet with
   tailored copy. No new modal.
6. **Proper decomposition** — a self-contained controller component, a
   pure state machine, a visible indicator. Chat screen owns zero
   takeover logic after the refactor.
7. **Cheap debug signal: `resolvedUrl`** — every `screenshot_result`
   carries the WebView's final URL so the agent (and the user reading
   the chat) can spot when navigation got redirected (e.g. to a login
   page). Not a typed `auth_required` reason — just a fact the agent
   can use.
8. **Global, opt-in setting.** A persisted app-level switch
   ("Enable visual feedback") in the Settings screen acts as the
   outermost gate before capability / canUseTool / per-session
   toggle. Ships **default OFF** so privacy-conscious users aren't
   surprised by the first capture request. First-run users see a
   one-line onboarding hint pointing them at the setting; nothing
   captures until they flip it on. The same setting covers the
   `prepare_preview` tool in the handoff SDD — single switch, two
   tools.

## Non-goals

- The inverse direction (`prepare_preview` MCP tool, user-driven
  setup) — separate SDD.
- Bridge-side headless capture — deferred to the visual-feedback-loop
  SDD's "future work" list.
- Auto-trigger ("verify after every edit") — deferred.
- Annotation tools, region selection, perceptual diffs — deferred.
- Bridge-side auth detection. The agent owns that judgment (or will,
  once the handoff SDD lands). `resolvedUrl` is the only post-hoc
  signal we ship.
- Cross-route batching ("capture every page in the SPA") — the agent
  can already chain calls; we don't need to bake batch semantics into
  the takeover protocol.

## Personas

- **Vibecoder watching the conversation.** Sees Claude make a change.
  Sees a brief "Verifying…" pill appear, the WebView swaps to the
  preview, capture lands in chat. Total disruption: ~1 second.
- **Cautious operator.** Wants to know *every* time the agent has
  looked at the screen. The pill provides that signal. Per-session
  toggle (already shipped) lets them disable autonomous capture
  entirely.
- **Impatient debugger.** Wants the agent to verify without asking.
  Allow-always on the first prompt and the pill becomes background
  noise — fine, the burst is brief.

## User stories

### Entering takeover (T1)

- **T1a.** As an agent, I call `take_screenshot` for the first time
  this session and the user gets the existing permission prompt with
  visual-verification-specific copy ("Claude wants to view your live
  preview to verify a change. Allow once / Always allow / Deny").
- **T1b.** As a user, when I tap "Allow once" or "Always allow," the
  phone enters takeover mode: pager swaps to Preview, pane mode locks
  to Preview, a top pill appears reading "Verifying — `/checkout`"
  with a Cancel button.
- **T1c.** As a user, when I tap "Deny," the agent's tool result is
  `permission_denied`; phone does not enter takeover; no UI changes.

### During takeover (T2)

- **T2a.** As an agent, I provide a `path` argument; the phone
  navigates the WebView to that path before capturing. Invalid paths
  (cross-origin, traversal segments, malformed) are rejected with
  `screenshot_result { ok: false, reason: 'capture_failed', note:
  'invalid path' }`.
- **T2b.** As an agent, I omit `path`; the phone captures the
  currently-loaded URL.
- **T2c.** As an agent, I chain a second `take_screenshot` within the
  takeover debounce window; the phone stays in takeover mode (no
  re-engage flicker) and captures the next frame.
- **T2d.** As a user during takeover, the pager swipe is disabled, the
  Files/Preview segment toggle is disabled, and the burger sidebar is
  disabled — the agent owns the screen for the duration of the burst.
- **T2e.** As a user during takeover, I can scroll inside the
  WebView, but every touch interaction extends the debounce window so
  the agent doesn't capture mid-scroll.
- **T2f.** As an agent receiving the `screenshot_result`, I see the
  `resolvedUrl` the WebView ended up on — useful for noticing when
  `/admin` silently became `/login`.

### Interrupting (T3)

- **T3a.** As a user, when I tap Cancel on the pill, any in-flight
  capture resolves with `screenshot_result { ok: false, reason:
  'cancelled' }`; phone exits takeover; user lands back where they
  started.
- **T3b.** As a user, if I background the app mid-takeover, the
  in-flight capture resolves with `cancelled` and the mode tears down
  on its own when the app resumes.
- **T3c.** As an agent receiving a `cancelled` text result, I decide
  whether to retry, fall back to asking the user, or proceed without
  visual confirmation — the SDK loop never hangs.

### Exiting (T4)

- **T4a.** As a takeover mode that's seen no capture activity for
  {DEBOUNCE} seconds, I exit on my own — pill fades out, pager
  restores to prior index, pane mode restores to prior value.
- **T4b.** As a user, after takeover exits, my pre-takeover scroll
  position in the chat list is preserved (we never moved the
  underlying chat).
- **T4c.** As a session being disconnected mid-takeover, the
  controller drops to idle, the pill disappears, and any pending
  `request_screenshot` waiting for a reply resolves with `cancelled`
  on the bridge.

## Functional requirements

- **F1.** Takeover mode is a discrete state machine, not a boolean
  on the chat screen. States: `idle` | `requesting` | `engaging` |
  `active` | `exiting`. The state machine is designed so the handoff
  SDD can later add a `direction: 'agent' | 'user'` field + a
  `policy: 'debounce' | 'explicit'` field without restructuring —
  this SDD ships only the agent / debounce flavor.
- **F2.** Permission flow is reused: first call goes through
  `canUseTool` and the existing `<ApprovalSheet>`. The tool's display
  label and prompt body are looked up by the qualified MCP tool name
  (`mcp__rove__take_screenshot`) — no new modal infrastructure.
- **F3.** On entering `engaging`, the controller:
  1. Snapshots the current pager index + WorkspacePane mode.
  2. Drives the pager to Preview via the existing
     `ChatPreviewPagerHandle.setIndex(1)`.
  3. Drives the WorkspacePane to Preview via a new imperative method
     `setMode('preview')`.
  4. Pushes a "preview lock" — pager swipes + segment toggle +
     burger nav all disabled while the lock is active.
  5. Shows the `<TakeoverIndicator>` at the top of the screen.
- **F4.** On entering `active`, the controller:
  1. If `path` provided and valid: injects `location.assign(<url>)`
     via the WebView ref and awaits `onLoadEnd` (or a max-wait of
     `SCREENSHOT_WAIT_MS_CAP` = 2s, whichever comes first).
  2. If `path` provided but invalid: skip navigation; reply with
     `ok: false, reason: 'capture_failed', note: 'invalid path'`;
     transition to `exiting`.
  3. Else: awaits the configured `waitMs` (clamped 0–2000, default
     `SCREENSHOT_DEFAULT_WAIT_MS = 300ms`).
  4. Calls `captureRef` via the existing `useScreenshotCapture`.
  5. Reads the WebView's `currentUrl` after capture (best-effort).
  6. Uploads via the existing upload pipeline.
  7. Sends `screenshot_result { ok: true, uploadId: upload.path,
     resolvedUrl?: currentUrl }`.
- **F5.** On capture completion, the controller resets a debounce
  timer (default 3s). If another `request_screenshot` arrives before
  it fires, controller stays in `active`. If it expires, controller
  transitions to `exiting`.
- **F6.** On `exiting`, the controller:
  1. Restores the pager index it snapshotted.
  2. Restores the WorkspacePane mode it snapshotted.
  3. Pops the preview lock — gestures re-enabled.
  4. Fades out the `<TakeoverIndicator>` over ~250ms.
  5. Lands in `idle`.
- **F7.** Cancel button on the indicator transitions to `exiting`
  immediately, sending `screenshot_result { ok: false, reason:
  'cancelled' }` for any in-flight request first.
- **F8.** WS disconnect / app-background while in `active` →
  controller drops to `idle` without restoring (there's nothing to
  restore to since the screen is gone) and any pending bridge-side
  request resolves with the existing `cancelled` drain.
- **F9.** Per-session "Disable visual verification" toggle remains
  the session-wide kill switch (already shipped). When off, the
  bridge short-circuits to `disabled_by_user` before any takeover
  request even reaches the phone.
- **F10. Path validation.** The phone validates `path` before
  navigating. Accepts: a string starting with a single `/` followed
  by a non-`/` character, optionally followed by additional path
  segments, an optional `?query` and `#fragment`. Rejects: empty,
  absolute URLs (http/https/scheme), `//double-slash` (which is
  origin-relative), `..` traversal segments. Centralised in a
  single helper so the agent-handoff SDD can reuse the same rule.
- **F11. `resolvedUrl` echo.** Every successful `screenshot_result`
  carries the WebView's final URL (best-effort; the WebView ref
  exposes `currentUrl`). Bridge-side, the SDK tool's image content
  block is followed by a brief text content block with
  `resolved_url: <url>` so the agent has structured access to it
  without parsing the screenshot.
- **F12. Global enable setting.** A persisted boolean
  `enableVisualFeedback` lives in the mobile settings store
  (`useHydratedSettings`). Default `false`. Surfaced in the
  Settings screen as a labelled switch with a short explanation.
  When `false`:
  - The manual shutter button is hidden in every session.
  - The chat-header "Visual verification" toggle is hidden (it
    has nothing to override).
  - The agent's `take_screenshot` and `prepare_preview` tool
    calls short-circuit immediately to a typed `disabled_by_user`
    text result — no permission prompt, no WS frame, no phone
    activity.
  - First-run users see a one-line meta hint in their first
    session (`Visual feedback is off — enable in Settings if you
    want Claude to verify changes by capturing your preview.`)
    shown once per device.
- **F13. Always-ask sub-option.** Inside the same Settings screen,
  a secondary switch ("Always ask before each capture") suppresses
  the "Always allow" button on the `<ApprovalSheet>` for the
  visual-verification tools. Default `false` (allow-always
  available). Independent of `enableVisualFeedback` — only
  meaningful when the feature is enabled.

## Non-functional requirements

- **N1.** Pager + pane restore must not lose chat-list scroll
  position. (Chat list lives on a different page; this should be
  free with the existing architecture, but is worth pinning.)
- **N2.** WebView interactions during `active` (the user scrolling /
  pinching the preview to help the agent see something) must extend
  the debounce timer, not exit the mode.
- **N3.** Indicator pill must use a non-blocking layout (overlay,
  not flexbox sibling) so showing/hiding it doesn't reflow the
  Preview pane.
- **N4.** State machine must be a pure function exported from
  `previewDirectionMachine.ts` so it's unit-testable without a
  render context. The name `previewDirection*` is deliberate — the
  handoff SDD will extend this same file rather than introducing a
  parallel reducer.
- **N5.** Total roundtrip target: `engage → navigate → capture →
  reply` ≤ 1500ms p50, ≤ 3000ms p95, for a hot WebView.
- **N6.** Path validator must be the same function used by the
  handoff SDD's `suggestedPath` argument once that ships. Shared
  helper to avoid drift.

## Limitations (worth documenting, not fixing)

- **Agent might call `take_screenshot` on a route that requires
  auth, capture the login page, and confidently describe it.** The
  `resolvedUrl` echo gives the agent the signal but doesn't enforce
  it. The handoff SDD (`prepare_preview` tool) is the real fix.
- **WebView mid-scroll captures.** The debounce extension on touch
  is a soft mitigation; a determined user can still scroll right
  before the debounce window fires. Not worth a hard lock.
- **`waitMs` is a guess.** It's a fixed pre-capture delay, not a
  navigation-aware settle. We do prefer `onLoadEnd` when a `path`
  is provided, but the SPA-route case (no full reload) falls back
  to `waitMs`.

## Definition of done

- `enableVisualFeedback` setting ships in `useHydratedSettings`
  with default `false`. Settings screen exposes both that switch
  and the "Always ask" sub-option.
- All four gates (manual shutter, `take_screenshot` handler,
  `prepare_preview` handler [handoff SDD], chat-header toggle)
  honor the setting and short-circuit cleanly when it's off.
- First-run hint shown once per device when the user enters a
  chat session with the setting still at its default `false`.
- Takeover state machine ships as a pure function with unit tests
  covering every transition + the debounce policy. Lives in
  `previewDirectionMachine.ts` with a `direction` field always set
  to `'agent'` in this SDD's shipped code.
- `<TakeoverController>` mounted by the chat screen replaces today's
  inline `handleScreenshotRequest` — chat screen owns zero takeover
  logic after the refactor.
- `<TakeoverIndicator>` renders with pulse animation + Cancel; pill
  shows the in-flight `path` (or "current view" if omitted).
- WebView `path` argument is honored: validated, `injectJavaScript(
  'location.assign…')`, `onLoadEnd` settle, cushion.
- Path validator helper exists and is exercised on every path arg.
- `resolvedUrl` is in every successful `screenshot_result`, surfaced
  to the agent as a text block alongside the image.
- Pager + WorkspacePane locks ship as imperative methods on their
  handles and are exercised by the controller.
- Permission-prompt copy lookup for `mcp__rove__take_screenshot`
  reads as the user-friendly "view your live preview" copy.
- Debounce-exit auto-cleanup verified by a quick scripted test (two
  back-to-back captures stay in mode; one capture exits after
  debounce).
- `pnpm exec tsc --noEmit` clean on both projects.
- **Smoke (deferred to a real device run):** capture works while
  user is on Chat tab (mode auto-swaps to Preview); navigation via
  `path` lands on the right route before capture; Cancel
  interrupts in flight; debounce-exit restores prior tab;
  `resolvedUrl` matches when a route doesn't redirect, differs
  when it does.
