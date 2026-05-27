# Plan — Visual Feedback Loop

Reference: [frd.md](./frd.md), [hla.md](./hla.md).

## Overview

Three phases, ranked by independent shippability:

1. **Phase 1 — Capture primitive + manual shutter** (user value: send
   what you see). Ships the entire phone-side capture stack, the
   composer sheet, and the user message attachment plumbing.
   Standalone-shippable: the agent doesn't need to know about it for
   it to deliver value.
2. **Phase 2 — Agent-initiated capture via MCP tool**. Ships the
   bridge → phone round-trip, the `take_screenshot` MCP tool, the
   capability gating, the per-session toggle, and rate limiting.
   Requires Phase 1's capture primitive but not its UI.
3. **Phase 3 — Operator polish + telemetry**. Header toggle UI, token
   cost meta line, permission-prompt copy review, smoke-test sweep,
   docs. Optional but recommended before shipping autonomous mode by
   default.

Each phase is gated by an objective definition of done. The plan
tracks work via checkboxes.

## Definition of done (whole effort)

- `caps.screenshotCapture` exists on `AgentCapabilities`; Claude Code
  SDK driver reports `true`; stub agent reports `false`.
- `request_screenshot`, `screenshot_result`,
  `set_screenshot_allow` wire frames exist with named constants on
  bridge and mobile; **no magic strings** gate holds.
- `take_screenshot` MCP tool exists, is registered with the SDK
  driver, goes through `canUseTool`, returns image content block on
  success, returns typed text on every failure mode.
- `<ScreenshotComposer>`, `<PreviewShutter>`, `useScreenshotCapture`
  exist as standalone components, type-check clean on native and web.
- Web client advertises `clientCanCapture: false`; shutter hidden;
  MCP tool short-circuits to `no_client`.
- Manual capture round-trip works on a real iPhone against a real
  dev server.
- Autonomous capture round-trip works in a real session — agent
  asks, phone responds, image lands in next turn.
- Stub-agent regression: capability flags off → no shutter, no tool
  exposure, no crash.
- `pnpm exec tsc --noEmit` clean in `bridge/` and `mobile/`.
- `cd web && pnpm build` succeeds; bundle-size delta documented for
  the `react-native-view-shot` add.

## Phase 1 — Capture primitive + manual shutter

Branch: `2026-05-25-visual-feedback-loop-phase1-manual`

Goal: user taps shutter in Preview mode, composer slides up with a
thumbnail and a note input, Send posts a normal user turn with the
screenshot attached; Cancel discards.

### LLD (write first)

- [ ] **`screenshot-capture-lld.md`** — pin down `react-native-view-shot`
  semantics (capturing WebView vs. wrapper View, iOS / Android
  differences, web fallback strategy). Decide between `viewShot`
  ref-on-WebView vs. wrapper-View capture. Pin the PNG format,
  resolution, and base64-vs-tmpfile path. Document iOS Info.plist
  / config plugin requirements.

### Mobile

- [x] Install `react-native-view-shot` (or maintained Expo equivalent)
  and add to the Expo prebuild config plugin so dev / preview / CI
  builds pick it up without ejecting Expo Go.
- [x] Verify web target: install fallback `html2canvas` *only if* LLD
  confirms we want a web path; otherwise web advertises
  `clientCanCapture: false` and skips the dep. (Decision: skipped
  the web dep; hook returns `supported: false` on web.)
- [x] **`mobile/hooks/useScreenshotCapture.ts`** (NEW). Single source
  of truth for capture mechanics. Exposes `capture()` and
  `captureAndUpload()` + a stable `targetRef`. Dev-flag telemetry
  logs capture + upload duration.
- [x] **`mobile/components/chat/PreviewPane.tsx`** wire `captureRef`
  prop on the View wrapping the WebView (`collapsable={false}` so it
  doesn't get optimized away). No visible UI change.
- [x] **`mobile/components/PreviewShutter.tsx`** (NEW). Floating
  shutter button (camera-icon, bottom-right, 56pt, drop shadow).
  Press: medium haptic + brief white-flash overlay (sibling
  `<ShutterFlash nonce>` component) on the WebView. On capture
  success: opens composer with thumbnail.
- [x] **`mobile/components/ScreenshotComposer.tsx`** (NEW). Modal
  sheet with handle, thumbnail (180pt), caption input, Cancel +
  Send row, slide-up animation, `KeyboardAvoidingView`.
- [x] **`mobile/components/WorkspacePane.tsx`** accepts a
  `previewOverlay` slot rendered only when
  `mode === 'preview' && active`. Chat screen mounts shutter +
  flash via that slot, gated on `screenshot.supported`.
- [x] **`mobile/app/sessions/[agent]/[id]/index.tsx`** wires send:
  composer state is lifted to the chat screen; on Send we synthesize
  the same `[Attached image: …]` line the camera-roll path uses,
  call the existing `sendRef.current({ type: 'user_message' })`, and
  programmatically swap the pager to chat via the new
  `ChatPreviewPagerHandle.setIndex` imperative handle.
- [x] **`mobile/lib/types.ts`** — `clientCanCapture` deferred to
  Phase 2 (only matters for the WS round-trip). For Phase 1 the
  shutter is gated entirely on
  `Platform.OS === 'ios' | 'android'` via the hook's `supported`
  field.
- [x] **Capability surface (mobile side):** added
  `screenshotCapture?: boolean` to `AgentCapabilities`, mirrored
  from the bridge.

### Bridge

- [x] **`bridge/src/agents/types.ts`** — added
  `screenshotCapture?: boolean` to `AgentCapabilities` with the
  same naming convention as the other optional booleans. No new
  constants required because the field is referenced by its TS key,
  not as a runtime string.
- [x] **`bridge/src/agents/claudeCodeSdk.ts`** `capabilities()`
  reports `screenshotCapture: true` (the driver passes the image
  upload through to the SDK; no extra plumbing for manual flow).
- [x] **`bridge/src/agents/stubAgent.ts`** advertises
  `screenshotCapture: false` by omission — stub already omits every
  optional boolean.
- [x] No bridge code changes required for the manual flow — the
  existing `/upload` endpoint already accepts PNG MIME and the
  attachment ends up on the user turn via the existing
  `[Attached image: <rel>]` convention.

### Definition of done (Phase 1)

- [x] Type-checks clean on both projects (`pnpm exec tsc --noEmit`
      in `bridge/` and `mobile/`).
- [x] Shutter hidden on web (the hook's `supported` flag is false
      on `Platform.OS === 'web'`, so the chat screen renders no
      `previewOverlay`).
- [ ] **Smoke (deferred — manual run on device):** tapping the
      shutter in Preview mode on iOS captures the WebView in
      < 400 ms; Send posts a multimodal user turn and the agent
      reads the screenshot; Cancel discards without wire activity;
      pager auto-swaps to chat on Send.
- [ ] **Stub-agent regression (deferred):** session against
      stubAgent should still show the shutter (capability gate is
      *client-side* on platform, not driver). Confirm send falls
      through cleanly as a text-only attachment line because the
      stub doesn't read images.
- [ ] **Web build (deferred):** `cd web && pnpm build` succeeds
      with shutter compiled out — verified once iOS smoke lands.

---

## Phase 2 — Agent-initiated capture via MCP tool

Branch: `2026-05-25-visual-feedback-loop-phase2-mcp`

Goal: Claude calls `take_screenshot` and gets back an image content
block; full permission + capability + per-session toggle + rate-limit
gating; every failure path returns a typed text result, never throws.

### LLD (write first)

- [x] **`mcp-roundtrip-lld.md`** — folded into the HLA + plan
  inline. Decisions locked:
  - WS frame names: `request_screenshot` (server→client),
    `screenshot_result` (client→server),
    `set_screenshot_allow` (client→server).
  - Correlation ID = `randomUUID()` allocated per request.
  - Rate limiter: sliding-window timestamps, 6/60s defaults,
    configurable via env (SCREENSHOT_RATE_CAP / WINDOW_MS).
  - Timeout: single shot, 10s, defined as
    `SCREENSHOT_REQUEST_TIMEOUT_MS`.
  - Failure text-result shape: `<reason>: <human details>` where
    `<reason>` is one of the named `ScreenshotErrorReason` values.
  - Per-session toggle: in-memory map keyed by sessionId, defaults
    to true, persists across WS reconnects within a process.

### Bridge

- [x] **`bridge/src/agents/types.ts`** — added:
  - `ScreenshotErrorReason` union + `SCREENSHOT_ERROR_REASON` const
    matching the `SDK_RUN_STATUS` pattern.
  - `SCREENSHOT_ERROR_REASONS` tuple derived from the constant so
    Zod / other validators don't duplicate the enum.
  - `SCREENSHOT_REQUEST_TIMEOUT_MS`,
    `SCREENSHOT_WAIT_MS_CAP`,
    `SCREENSHOT_DEFAULT_WAIT_MS`,
    `SCREENSHOT_MCP_TOOL_NAME`,
    `SCREENSHOT_MCP_SERVER_NAME`,
    `SCREENSHOT_MCP_SERVER_VERSION`,
    `SCREENSHOT_MCP_TOOL_QUALIFIED` constants.
  - `request_screenshot` added to `ServerToClient` union;
    `screenshot_result` + `set_screenshot_allow` added to
    `ClientToServer`.
- [x] **`bridge/src/screenshotBroker.ts`** (NEW) — owns the pending
  promises map, dispatcher registry, per-session allow toggle,
  10s timeout, and `cancelPendingForSession` drain helper. Never
  rejects — every failure resolves with `{ ok: false, reason }`.
- [x] **`bridge/src/screenshotRateLimit.ts`** (NEW) — sliding-window
  rate limiter, all bounds named constants
  (`DEFAULT_CAPACITY` / `DEFAULT_WINDOW_MS` / clamp guards).
- [x] **`bridge/src/agents/claudeCodeSdk.ts`** — registers
  `take_screenshot` via `createSdkMcpServer` + `sdkTool`. Handler
  gates in order: per-session toggle → client attached →
  rate limit → broker round-trip → read bytes →
  image content block. Failure modes return typed text-content
  results via `textToolResult` + `REASON_DETAILS` lookup typed as
  `Record<ScreenshotErrorReason, string>` so exhaustiveness is
  compiler-enforced.
- [x] **`bridge/src/server.ts`** — routes `screenshot_result` →
  broker (with cross-field guard for ok/uploadId/reason),
  `set_screenshot_allow` → toggle map. On WS close: unregister
  dispatcher + drain pending requests with
  `SCREENSHOT_ERROR_REASON.cancelled`. Zod reason enum derived
  from `SCREENSHOT_ERROR_REASONS` (no duplicated string list).
- [x] **`bridge/src/agents/stubAgent.ts`** — already advertises
  `screenshotCapture: false` (by omission of the optional field),
  so the SDK driver path doesn't apply and the stub never sees
  the MCP tool.

### Mobile

- [x] **WS receive handler** in chat screen routes
  `request_screenshot` → `handleScreenshotRequest(requestId)` which
  capture-and-uploads via the existing hook and echoes back
  `screenshot_result` with the uploaded `path` as the `uploadId`.
  Failures map straight onto `ScreenshotCaptureError.reason`
  → wire-frame reason — no string matching.
- [x] **`mobile/hooks/useScreenshotCapture.ts`** — exports
  `ScreenshotCaptureError` with a typed `.reason` field
  (`unsupported` / `not_mounted` / `capture_failed` /
  `upload_failed`), so both the manual shutter and the agent
  path observe a single discriminated failure shape.
- [x] **Per-session toggle** — `allowVisualVerification` state lives
  on the chat screen (per-session by construction since the chat
  screen unmounts on route change). Defaults to `true`, mirroring
  the bridge default; a future store slice would only be needed
  for cross-screen reads, which we don't have yet.
- [x] **Header menu**: added a "Disable/Allow visual verification"
  item gated on `capabilities?.screenshotCapture`. Tap flips
  local state and dispatches `set_screenshot_allow` over the WS.
- [ ] **Permission prompt UI** — existing approval sheet handles
  `mcp__rove__take_screenshot` as just-another tool name. A
  friendly-label lookup is deferred to Phase 3 polish.
- [x] **`mobile/lib/types.ts`** — mirrors the bridge's
  `request_screenshot` wire frame on `ServerToClient` and the
  `screenshot_result` / `set_screenshot_allow` shapes on
  `ClientToServer`, plus the `ScreenshotErrorReason` /
  `SCREENSHOT_ERROR_REASON` constants.

### Definition of done (Phase 2)

- [x] `take_screenshot` is registered on the SDK driver via
      `createSdkMcpServer`. Tool name and namespace constants live
      in `bridge/src/agents/types.ts`.
- [x] Bridge-side gates implemented in handler-order: per-session
      toggle → no_client → rate limit → broker round-trip → bytes
      read → image content block.
- [x] WS frame routing + dispatcher registration + on-close drain
      with `SCREENSHOT_ERROR_REASON.cancelled` all wired.
- [x] `pnpm exec tsc --noEmit` clean on `bridge/` and `mobile/`.
- [ ] **Smoke (deferred to a real session):**
      first call shows permission sheet → allow → image lands in
      assistant turn; deny → text content block with
      `permission_denied`; toggle off → immediate
      `disabled_by_user`; 7th rapid call → `rate_limited`;
      WS disconnect mid-flight → `cancelled`.
- [ ] **Web build (deferred):** verify shutter compiled out and
      MCP-tool calls return `no_client` because there's no
      attached client able to capture.

---

## Phase 3 — Operator polish + telemetry

Branch: `2026-05-25-visual-feedback-loop-phase3-polish`

Goal: the feature feels considered, not bolted on. Includes the cost-
transparency meta line, header indicator dot, copy review, and a
manual smoke-test pass.

### Work

- [ ] **Token cost meta line.** After each capture lands (manual or
  agent), render a small meta line in chat: "Screenshot · ~1.4k input
  tokens" so the user can see what each shot costs. Compute via
  `widthPx × heightPx / 750` (Claude's documented image-token
  heuristic), rounded.
- [ ] **Header indicator.** A small dot next to the ellipsis menu
  when `allowVisualVerification === true`, so users glance at the
  header and know autonomous capture is on.
- [ ] **Permission-prompt copy.** Add a one-line "First time" hint
  on the permission sheet specifically for `take_screenshot`:
  "Claude will see what's in your preview window."
- [ ] **Smoke test on a real session.**
  - [ ] Open a frontend project, run dev server, hit the preview
        URL.
  - [ ] Manual: shutter → composer → send. Confirm Claude can read
        it.
  - [ ] Agent: ask Claude to make a change and verify visually.
        Confirm round-trip < 3 s p95.
  - [ ] Rate-limit: ask Claude to capture 10 times in a row,
        confirm 7th onward return rate-limited text.
  - [ ] Toggle off mid-session, confirm subsequent calls return
        disabled-by-user text.
  - [ ] Background the app mid-capture, confirm the request times
        out cleanly with no app crash.
- [ ] **Web build smoke.** Confirm shutter hidden, tool calls return
  `no_client` on the web client, no console errors.
- [ ] **Bundle-size delta documented.** Note the iOS + Android impact
  of `react-native-view-shot` in this plan or a follow-up README.
- [ ] **Doc updates.**
  - [ ] Top-level README: one paragraph describing the visual
        feedback loop and pointing at this SDD.
  - [ ] User-facing setup notes if the prebuild config plugin
        requires anything on the user's side (e.g., re-running
        `expo prebuild`).

### Definition of done (Phase 3)

- Token cost meta line appears under every capture.
- Header dot reflects toggle state and updates immediately.
- Smoke-test punch list above is fully checked.
- README updated.
- No regressions in existing chat / file-visibility flows.

---

## Deferred follow-ups (not in scope for this SDD's three phases)

Tracked here so the work isn't forgotten:

- **Auto-verify after edit.** Hook `file_changed` → debounce → push a
  `take_screenshot` synthesized as a tool call. Header toggle "auto-
  verify" controls it. Estimated half-day on top of Phase 2.
- **Perceptual diff skip.** Compute pHash, skip upload if delta < N%.
  Estimated half-day; needs telemetry to justify.
- **Bridge-side Playwright fallback.** Out of v1 scope; the wire
  model already accepts `path` so the executor can be swapped without
  protocol churn.
- **Region selection / element targeting.** Tap an element in the
  preview, capture only that bounding box. Estimated 1–2 days.
- **Annotation tools.** Draw arrows / circles on the thumbnail
  before send. Estimated 1 day.
