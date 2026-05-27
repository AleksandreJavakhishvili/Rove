# High-Level Architecture — Preview Takeover Mode

Reference: [frd.md](./frd.md), [plan.md](./plan.md),
[visual-feedback-loop](../2026-05-25-visual-feedback-loop/),
[preview-handoff](../2026-05-25-preview-handoff/) (paired follow-on).

## Context

Follow-on to the visual-feedback-loop SDD's Phase 2. That phase shipped
the wire — bridge↔phone WS frames, the `take_screenshot` MCP tool, the
broker with timeout + rate limit, the per-session toggle. What's
missing is the mode the phone enters while the agent is capturing:
visible indicator, user interrupt, pager + pane locks, navigation
honoring the `path` argument, and auto-exit.

The user-direction inverse (`prepare_preview`) lives in its own SDD.
This effort designs the state machine + controller so the handoff
work can extend rather than duplicate.

## Gate ladder

Four layers of gating before a capture actually fires. Listed from
outermost (global / persisted) to innermost (in-flight):

1. **Global setting** — `enableVisualFeedback` boolean in the
   mobile settings store. Default `false` (opt-in). When off, no
   shutter renders, no MCP tool reaches the agent, no permission
   prompt fires.
2. **Driver capability** — `screenshotCapture: true` advertised by
   the driver. Not user-controllable.
3. **Per-tool permission** — `canUseTool` prompt on first call
   per session. Allow-always cached. The "Always ask" Settings
   sub-option suppresses the allow-always button.
4. **Per-session toggle** — chat-header item that disables the
   feature for one session without flipping the global setting.

Both the manual shutter and the agent-initiated tools check the
same global setting at their respective entry points. The handoff
SDD's `prepare_preview` tool plugs into the same ladder.

## Architectural pillars

1. **Mode is a discrete state machine.** Five states
   (`idle | requesting | engaging | active | exiting`) with explicit
   transitions and a debounce timer. Pure function so it's
   unit-testable without React.
2. **One reducer, designed for extension.** The state shape carries a
   `direction: 'agent'` field (always agent in this SDD) and a
   `policy: 'debounce'` field (always debounce here). The handoff SDD
   adds `'user'` and `'explicit'` variants without restructuring the
   transitions.
3. **Controller owns everything.** A single component mounted by the
   chat screen subscribes to `request_screenshot` frames, runs the
   state machine, drives the pager + workspace, performs capture,
   renders the indicator. Chat screen owns zero takeover logic.
4. **Reuse existing infrastructure.** Permission flow is
   `canUseTool` + `<ApprovalSheet>` (already shipped). Capture is
   `useScreenshotCapture` (already shipped). Pager + WorkspacePane
   already have imperative handles; we add small new methods rather
   than building parallel mechanisms.
5. **Visible by default.** Every takeover is signaled by the
   indicator pill. Silent capture is not allowed — that's a UX bug,
   not a feature.
6. **Auto-cleanup.** The debounce-exit timer means the agent can
   chain captures without the mode flickering and a single capture
   tidies itself up without the user lifting a finger.
7. **Path validation is shared.** A single helper rejects malformed
   / cross-origin / traversal paths. The handoff SDD's
   `suggestedPath` argument will reuse it.

## State machine

```
                                            (WS: request_screenshot)
                                                       │
                                                       ▼
                                              ┌──────────────┐
                                              │  requesting  │  ← canUseTool may prompt here
                                              └──────┬───────┘
                                                     │ allow
                                                     ▼
                                              ┌──────────────┐
                                              │   engaging   │  ← snapshot prior state
                                              └──────┬───────┘    swap pager + lock workspace
                                                     │            show indicator
                                                     ▼
                       ┌──────────────────────► ┌────────────┐
                       │ (another request)      │   active   │  ← navigate (if path)
                       │  resets debounce       └──────┬─────┘    settle + capture + upload
                       │                               │            send screenshot_result
                       │  (capture complete)           │            (with resolvedUrl)
                       └───────────────────────────────┤
                                                       │
                                              (debounce expires
                                               OR cancel tap
                                               OR WS close)
                                                       ▼
                                              ┌──────────────┐
                                              │   exiting    │  ← restore pager / mode / locks
                                              └──────┬───────┘    fade indicator
                                                     │
                                                     ▼
                                              ┌──────────────┐
                                              │     idle     │
                                              └──────────────┘
```

**Transition table** (input → from-state → to-state):

| Event                              | idle       | requesting | engaging | active     | exiting |
|------------------------------------|------------|------------|----------|------------|---------|
| request_screenshot received        | requesting | (queue)    | (queue)  | active*    | active* |
| permission_granted                 | —          | engaging   | —        | —          | —       |
| permission_denied                  | —          | idle       | —        | —          | —       |
| engaged                            | —          | —          | active   | —          | —       |
| capture_complete                   | —          | —          | —        | active(deb)| —       |
| debounce_expired                   | —          | —          | —        | exiting    | —       |
| cancel_tapped                      | —          | —          | exiting  | exiting    | —       |
| ws_closed                          | —          | idle       | idle     | idle       | idle    |
| exit_complete                      | —          | —          | —        | —          | idle    |

`active*` = if a new request arrives mid-takeover (because of the
debounce window), we stay in `active` and reset the debounce timer.

## Components

### Files (new)

```
mobile/components/takeover/
  previewDirectionMachine.ts ← pure state-machine reducer (+ debounce policy)
                                — named for the *direction* not the *takeover*
                                  so the handoff SDD extends it directly
  useTakeover.ts             ← React hook: wraps the machine + side-effects
                                (timers, ref handles, WS replies)
  TakeoverController.tsx     ← orchestrator component the chat screen mounts
  TakeoverIndicator.tsx      ← floating pill: state label, path, Cancel button
  toolLabels.ts              ← lookup table: qualified MCP tool name →
                                friendly label + prompt body (used by ApprovalSheet)
  pathValidator.ts           ← shared `validatePreviewPath(input): string | null`
```

### Files modified

- `mobile/lib/store.ts` — add `enableVisualFeedback: boolean` (default `false`) and `alwaysAskBeforeCapture: boolean` (default `false`) to the existing `useHydratedSettings` slice; both persist via SQLite the same way the existing settings do.
- `mobile/app/settings.tsx` — add a new "Visual feedback" section with the master switch + the "Always ask" sub-switch + a short explanation paragraph.
- `mobile/components/chat/ChatPreviewPager.tsx` — add `setLocked(boolean)` to imperative handle so the controller can disable swipes.
- `mobile/components/WorkspacePane.tsx` — add `setMode('files' | 'preview')` and `setLocked(boolean)` to imperative handle so the controller can force preview + disable the segment toggle.
- `mobile/components/chat/PreviewFrame.tsx` — expose the `WebView` ref upward so the takeover controller can `injectJavaScript` for navigation, listen for `onLoadEnd`, and read `currentUrl` for the `resolvedUrl` echo.
- `mobile/components/chat/ApprovalSheet.tsx` (or wherever the approval UI labels tool names) — consult `toolLabels.ts` for friendly display.
- `mobile/app/sessions/[agent]/[id]/index.tsx` — delete inline `handleScreenshotRequest`, mount `<TakeoverController>` with the same handles the chat screen already has (pager ref, workspace ref, send function, capture hook).
- `bridge/src/agents/claudeCodeSdk.ts` — the `take_screenshot` tool handler now appends a second text content block after the image with `resolved_url: <url>` if the phone supplied one. The handler also reads a new in-memory per-session flag `clientVisualFeedbackEnabled` (echoed up from the phone via the existing capability/hello plumbing); short-circuits to `disabled_by_user` if false.
- `bridge/src/agents/types.ts` — `screenshot_result` wire frame gains optional `resolvedUrl?: string`. New `set_visual_feedback_enabled` client→server frame so the phone can update the bridge's view of the setting at runtime (when the user flips it in settings without reopening the session).

## Data flow

```
WS frame: request_screenshot { requestId, path?, waitMs? }
                       │
                       ▼
              TakeoverController
                  (subscribe)
                       │
                       ▼
                useTakeover.dispatch({ type: 'request', payload })
                       │
                       ▼
       previewDirectionMachine returns next state + side-effect descriptor
                       │
                       ▼
          useTakeover runs the side-effects:
              • snapshotPriorState()
              • pagerHandle.setIndex(1)
              • workspaceHandle.setMode('preview')
              • workspaceHandle.setLocked(true)
              • pagerHandle.setLocked(true)
              • setIndicatorVisible(true)
              • if (path) validatePreviewPath(path)
                  • valid → webViewHandle.navigate(path) → await onLoadEnd
                  • invalid → reply { ok:false, reason:'capture_failed', note }
                              dispatch capture_complete (skip to exit on debounce)
              • else await sleep(waitMs ?? DEFAULT_WAIT_MS)
              • const { upload, currentUrl } = await captureHook.captureAndUpload()
              • sendRef.current({ type: 'screenshot_result', ok:true,
                                  uploadId: upload.path, resolvedUrl: currentUrl })
              • dispatch({ type: 'capture_complete' })
              • startDebounceTimer()
                       │
                       ▼
              (next request? reset debounce) | (timer fires? dispatch 'debounce_expired')
                       │
                       ▼
              useTakeover runs the exit side-effects:
              • pagerHandle.setIndex(snapshot.priorPagerIndex)
              • workspaceHandle.setMode(snapshot.priorWorkspaceMode)
              • workspaceHandle.setLocked(false)
              • pagerHandle.setLocked(false)
              • setIndicatorVisible(false)  // fade animation
```

## Path validation

The validator is a single pure function:

```ts
// mobile/components/takeover/pathValidator.ts
export function validatePreviewPath(input: string | undefined): {
  ok: true; path: string
} | {
  ok: false; reason: string
} {
  if (input === undefined || input === '') return { ok: true, path: '' };
  // Reject absolute URLs (scheme present).
  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) {
    return { ok: false, reason: 'absolute URL not allowed' };
  }
  // Reject protocol-relative (`//`) — that resolves cross-origin.
  if (input.startsWith('//')) {
    return { ok: false, reason: 'protocol-relative path not allowed' };
  }
  // Must start with single `/`.
  if (!input.startsWith('/')) {
    return { ok: false, reason: 'path must start with /' };
  }
  // Reject traversal segments.
  const pathPart = input.split(/[?#]/)[0]!;
  if (pathPart.split('/').some((seg) => seg === '..')) {
    return { ok: false, reason: 'path traversal not allowed' };
  }
  return { ok: true, path: input };
}
```

The handoff SDD's `suggestedPath` argument runs through the same
validator. Bridge does not duplicate the check — phone is the source
of truth since it owns the WebView.

## `resolvedUrl` integration

After a successful captureRef:

1. The phone reads `webViewRef.current?.injectJavaScript('window.ReactNativeWebView.postMessage(window.location.href)')` *(if the existing PreviewFrame already exposes a postMessage channel — falls back to a no-op if not)*, OR simply caches the last URL that `onNavigationStateChange` reported. We pick whichever is simpler — most likely the latter, since react-native-webview exposes `onNavigationStateChange` with a `url` field already.
2. The phone includes the captured URL as `resolvedUrl` in the `screenshot_result`.
3. The bridge's `take_screenshot` MCP tool handler, on success, returns:
   ```ts
   {
     content: [
       { type: 'image', data: <base64>, mimeType: 'image/png' },
       { type: 'text', text: `resolved_url: ${resolvedUrl ?? '(unknown)'}` },
     ],
   }
   ```
4. The agent reads both blocks. If `resolved_url` doesn't match the
   requested `path`, the model can infer redirect (auth, 404, etc.)
   without us shipping a typed reason for every possible cause.

If the phone can't determine the URL (older WebView, race condition), the field is omitted server-side and the text block reads `resolved_url: (unknown)` — agent still has a clear signal.

## Imperative handles (extensions)

```ts
// ChatPreviewPager
export interface ChatPreviewPagerHandle {
  setIndex(i: number): void;        // already shipped
  setLocked(locked: boolean): void; // NEW
}

// WorkspacePane (new — currently not ref-exposed)
export interface WorkspacePaneHandle {
  setMode(mode: 'files' | 'preview'): void;
  setLocked(locked: boolean): void;
}

// PreviewFrame (new — currently the WebView ref is local)
export interface PreviewFrameHandle {
  navigate(targetUrl: string): Promise<void>;  // injectJavaScript + await load
  reload(): void;
  currentUrl(): string | undefined;            // best-effort, from onNavigationStateChange
}
```

While a pager is `locked`, the gesture detector rejects all pan input. While a workspace is `locked`, segment-toggle taps are no-ops. The controller pushes both locks together on engage and pops them together on exit.

## Wire model

Two additions to the visual-feedback-loop SDD's frames:

1. `screenshot_result` `ok: true` variant gains optional
   `resolvedUrl?: string`.
2. New client→server frame:
   ```ts
   | { type: 'set_visual_feedback_enabled'; enabled: boolean }
   ```
   Sent by the phone on WS attach (initial state) and whenever the
   user flips the setting. Bridge stores per-session
   (`screenshotBroker.setVisualFeedbackEnabled(sessionId, bool)`);
   tool handlers read it at gate time. Default `false` if no frame
   has arrived (matches the mobile default).

No new tool args.

## Lifecycles

### Single capture (happy path)

```
t=0      WS receives request_screenshot
t=0      requesting → engaging (allow-always cached)
t=20ms   pager swap done, workspace forced to preview
t=30ms   indicator pill visible
t=30ms   active enters; navigate('/checkout')
t=350ms  WebView onLoadEnd fires
t=380ms  captureRef returns base64
t=520ms  upload complete; send screenshot_result with resolvedUrl
t=520ms  dispatch capture_complete; start 3s debounce
t=3520ms debounce expires → exiting
t=3770ms indicator faded; pager restored; locks lifted → idle
```

### Chained captures (agent verifies multiple routes)

```
t=0      WS request /checkout → engage → active
t=520ms  capture done, debounce(3s) armed
t=900ms  WS request /account → debounce reset; navigate; capture
t=1500ms capture done, debounce(3s) armed
t=4500ms debounce expires → exit
```

### User cancels mid-flight

```
t=0      WS request → engage → active → navigate
t=200ms  user taps Cancel on indicator
t=200ms  send screenshot_result { ok:false, reason:'cancelled' }
t=200ms  cancel_tapped → exiting → idle (within ~250ms fade)
```

### Invalid path

```
t=0      WS request_screenshot { path: '//evil.com' }
t=0      requesting → engaging → active
t=10ms   validatePreviewPath rejects → send { ok:false, reason:'capture_failed',
                                              note:'protocol-relative path not allowed' }
t=10ms   dispatch capture_complete (treated as a finished attempt)
t=3010ms debounce expires → exit
```

(We still engage the mode briefly even on invalid path so the user sees what just happened.)

### WS disconnects mid-flight

```
t=0      WS request → engage → active
t=200ms  WS close detected
t=200ms  ws_closed → idle (no restore — screen is teardown)
         (bridge side: cancelPendingForSession drains the pending
          request with `cancelled` — already shipped)
```

## Risks + mitigations

- **iOS WKWebView returns blank if it's still painting on `onLoadEnd`.**
  Mitigation: a small extra `requestAnimationFrame` + ~50ms cushion
  after onLoadEnd before captureRef. Documented in the controller.
- **User interrupts WebView mid-navigation (taps a link before we
  capture).** Mitigation: extend debounce on every touch so the next
  capture happens after the user settles. Pager + segment toggle
  locked; WebView itself stays touchable so the user can scroll if
  they want to help the agent see something.
- **Pager `setIndex` animation (~220ms) racing the navigation.**
  Mitigation: in the controller, await an animation-complete callback
  (or a fixed guaranteed-larger wait) before firing the navigation.
- **Multiple sessions open simultaneously.** Only one chat screen
  mounts the controller at a time. No cross-session contention.
- **Allow-always granted but user changes mind mid-burst.** Cancel
  on the indicator exits the current burst. Subsequent captures will
  still try (canUseTool is cached) — the per-session toggle in the
  header menu is the path to a stronger disable. Document the
  difference: Cancel = "stop this burst"; Disable in header = "stop
  all autonomous captures."
- **State machine drift between the pure reducer and the imperative
  side-effects.** Mitigation: every transition produces an effect
  descriptor (e.g. `{ type: 'engage' }`, `{ type: 'restore' }`) that
  `useTakeover` interprets — the reducer doesn't call refs directly.

## Limitations (not risks — known and accepted)

- **Agent can capture a redirected page without noticing.** The
  `resolvedUrl` echo gives the model the signal but doesn't enforce
  it; if the agent doesn't read both content blocks, it describes
  whatever the screenshot shows. The handoff SDD's `prepare_preview`
  is the real fix for "this route needs auth" cases.
- **Path validator is conservative.** Some valid relative paths
  (e.g. `..`-using paths that resolve cleanly) are rejected. We
  prefer false-negative over false-positive given the security
  posture.
- **`onNavigationStateChange.url` lag.** The WebView's URL field can
  trail by a tick on iOS during fast SPA navigations. If
  `resolvedUrl` is wrong by a route, the agent might mis-read; we
  document that the field is best-effort.

## Definition of done (architecture-level)

- Mobile `useHydratedSettings` exposes `enableVisualFeedback` and `alwaysAskBeforeCapture`, both persisted, both default `false`.
- `/settings` screen renders the new section with master + sub-switch + explainer copy.
- All four gate sites honor the global setting:
  1. `<PreviewShutter>` returns `null` when off.
  2. `<TakeoverController>` ignores `request_screenshot` frames when off (drops them with a debug log; bridge will short-circuit anyway).
  3. `<ApprovalSheet>` consults `alwaysAskBeforeCapture` for the visual-feedback tools and hides the "Always allow" button when on.
  4. Bridge tool handlers short-circuit to `disabled_by_user` based on the per-session `clientVisualFeedbackEnabled` flag (kept in sync via the new `set_visual_feedback_enabled` WS frame).
- First-run hint shown once per device (tracked via a separate `visualFeedbackOnboardingShown` boolean in the settings store).
- `previewDirectionMachine.ts` exposes a `reduce(state, event) → { state, effects[] }` function. State + events are typed unions. Effects are typed descriptors. State carries `direction: 'agent'` and `policy: 'debounce'` fields, designed so the handoff SDD adds `'user'`/`'explicit'` without restructuring.
- `useTakeover` translates effects into ref calls + timer scheduling. No business logic lives outside the reducer.
- `<TakeoverController>` mounts once per chat screen. Receives pager handle, workspace handle, preview-frame handle, send function, capture hook. Subscribes to WS `request_screenshot` frames via a prop callback the chat screen passes in.
- `<TakeoverIndicator>` is a presentation component — receives `{ visible, label, path?, onCancel }`. No state of its own.
- `ChatPreviewPagerHandle.setLocked` + `WorkspacePaneHandle.setMode/setLocked` + `PreviewFrameHandle.navigate/currentUrl` all ship.
- `validatePreviewPath` helper exists; every `path` arg runs through it; invalid paths skip navigation and reply `capture_failed`.
- `resolvedUrl?: string` on `screenshot_result`; bridge tool result includes a `resolved_url: …` text block alongside the image.
- Permission-prompt copy lookup ships with `mcp__rove__take_screenshot` mapped to friendly text. Falls back gracefully for unknown tools.
- Chat screen `handleScreenshotRequest` deleted; replaced by `<TakeoverController>` mount.
