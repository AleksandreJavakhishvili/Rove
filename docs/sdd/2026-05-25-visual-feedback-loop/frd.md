# Functional Requirements — Visual Feedback Loop

## Problem

Vibecoding from the phone is a feedback-driven workflow: agent edits a
file, dev server hot-reloads, user looks at the live preview, user
reacts. Today the reaction half is broken:

- The user **sees** the preview on the phone, but Claude does not.
  When the agent makes a frontend change, Claude has no way to verify
  that the rendered output matches what was intended. The user has to
  describe what they see in words ("the header is off-center", "the
  modal still has the old color") — slow, lossy, and pushes the user
  into the role of a high-bandwidth screen reader for the agent.
- The user can attach a still photo from the camera roll today, but
  there is no first-class path to send **what the WebView is currently
  showing** as a screenshot. The user has to take an OS-level
  screenshot, leave the app, crop, come back, attach.
- There is no way for the agent to **request** visual confirmation on
  its own. Any closed-loop iteration ("change the color → check the
  color → adjust") requires the user to ferry pixels between the
  preview and the chat by hand.
- Because the verification step is manual, the agent over-asks: it
  will assert "the change should look like X" without ever knowing
  whether it does, then wait for the user to confirm. The user becomes
  the bottleneck even when the answer is sitting on their own screen.

The whole point of a phone-based agent is that the laptop is the
*agent's* surface, not the user's. Anything that pushes verification
work onto the user is friction the project should remove.

## Goals

1. **One-tap manual capture from the live preview.** While viewing the
   preview, the user taps a shutter, types an optional note, and sends
   the rendered WebView contents to Claude as a chat message with an
   image attachment.
2. **Agent-initiated capture via an MCP tool.** Claude can call
   `take_screenshot` as a tool. The bridge brokers a round-trip to the
   phone's WebView, captures, and returns the PNG to Claude as an
   image content block in the tool result. No user action required.
3. **Visual feedback is closed-loop, not transcribed.** When the agent
   verifies its work via screenshot, the verification is grounded in
   the same pixels the user is looking at — not a paraphrase.
4. **Capture must be cheap and well-behaved.** Token spend is
   bounded; the user can rate-limit or disable autonomous captures
   per session; an unavailable phone is a graceful "no result"
   rather than a hang.
5. **Capability-gated.** A driver that doesn't expose
   `take_screenshot` (or a session running on a transport that can't
   reach the phone) cleanly hides the agent-side tool and the
   manual-capture button stays as a no-op fallback.
6. **Reuses existing primitives.** The attachment upload pipeline,
   the chat send path, the WebSocket frame conventions, and the MCP
   permission model are all reused. No new transport, no new auth
   surface.

## Non-goals

- Recording video from the preview. Stills only for v1.
- Capturing arbitrary URLs from a headless browser on the bridge.
  v1 is **phone-side only**; the WebView the user can see is the only
  surface that can be captured. A bridge-side Playwright fallback is
  out of scope (sketched in HLA "deferred work" for future).
- Cross-WebView diffing (perceptual hash to skip "nothing changed"
  shots). Listed as a possible v2 cost-reduction once telemetry shows
  it's needed.
- Annotation tools on the captured image (arrows, highlights). The
  user attaches a comment; that's the v1 annotation channel.
- Auto-trigger after every edit. v1 ships pull-mode (Claude asks,
  user-button asks) only. Auto-after-edit lives behind a deferred
  follow-up phase.

## Personas

- **Vibecoder on the couch.** Phone in hand, dev server running on
  the laptop, iterating on a frontend. Wants to flick to the preview,
  see something off, send "fix the alignment of this card" with the
  screenshot attached — without leaving the app.
- **Patient debugger.** Asks Claude to fix a layout bug. Wants Claude
  to verify on its own and only come back when the fix is visually
  confirmed. Token cost is acceptable for fewer round-trips.
- **Cautious operator.** Doesn't want the agent silently sending
  pixels into context every turn. Wants the tool gated behind explicit
  approval and a per-session disable.

## User stories

### Manual capture (M)

- **M1.** As a vibecoder viewing the live preview, when I tap the
  shutter button, the WebView contents are captured and a composer
  sheet slides up with a thumbnail and a text input. I can add a
  comment and tap Send to post a user message with the screenshot
  attached.
- **M2.** As a vibecoder, when I tap Cancel on the composer, the
  capture is discarded and I stay on the preview with no message
  sent.
- **M3.** As a vibecoder, when I send the screenshot, the pager
  swaps to the chat so I see Claude's response come in. The
  WebView's loaded URL and scroll position are preserved.
- **M4.** As a vibecoder on a session whose agent doesn't expose
  visual-input tool support (image-blind), the shutter button is
  hidden — sending a screenshot would be a no-op for that agent.

### Agent-initiated capture (A)

- **A1.** As an agent in the middle of a turn, I call
  `take_screenshot({ path?, waitMs? })` and receive an image content
  block in the tool result. I can reason against the pixels in the
  same turn.
- **A2.** As an agent, if the phone is not foregrounded / WebView is
  unmounted / capture times out, the tool result is a text block with
  a clear "screenshot unavailable: <reason>" rather than a hang or a
  stack trace. I can decide whether to retry, fall back to asking the
  user, or proceed without visual confirmation.
- **A3.** As an agent in a session where the user has disabled
  autonomous capture, calling `take_screenshot` returns a "disabled
  by user" text result — same shape as A2.

### Operator controls (O)

- **O1.** As a user, I can disable autonomous screenshots for a
  session from the chat header menu. The MCP tool keeps existing for
  the agent but always returns "disabled by user" until I re-enable.
- **O2.** As a user, I see a small indicator in the chat header when
  autonomous capture is enabled, so I don't accidentally rack up
  image tokens.
- **O3.** As a user, the first time an agent calls `take_screenshot`
  in a session, it goes through the normal permission flow ("Allow
  this tool?") — the agent does not get pixels of my screen without
  my consent.

## Functional requirements

- **F1. Phone-side capture.** Captures only the WebView contents in
  the preview pane, not the surrounding mobile chrome (status bar,
  segmented header, shutter button). Returns a PNG.
- **F2. Upload reuse.** Captured PNGs flow through the existing
  upload endpoint and become attachments on a normal user message —
  no new file-transfer mechanism.
- **F3. Composer sheet.** The manual flow shows a sheet with
  thumbnail, optional comment input, Send, and Cancel. Send dispatches
  a single chat turn with text (if provided) and the screenshot
  attached.
- **F4. MCP tool.** The bridge exposes `take_screenshot` as a tool
  callable by the Claude Code SDK driver. Args: optional `path`
  (relative URL inside the dev server origin), optional `waitMs`
  (max 2000 ms). Result: image content block on success, text content
  block describing the failure on error.
- **F5. WS round-trip.** Bridge sends `request_screenshot` to the
  phone; phone replies with `screenshot_result` carrying an upload
  reference. Bridge resolves the in-flight MCP tool promise with the
  uploaded bytes. Timeout 10 s.
- **F6. Permission gating.** First MCP call goes through the existing
  permission prompt path; allow / allow-always / deny apply.
- **F7. Per-session toggle.** A header menu item "Allow visual
  verification" controls whether the bridge brokers MCP captures or
  short-circuits them with the disabled-by-user response. State is
  per (agent, sessionId), defaults on after first allow.
- **F8. Capability gating.** Three new capabilities:
  `screenshotCapture` (driver advertises the MCP tool is available),
  `clientCanCapture` (client tells the bridge it can serve screenshot
  requests). The shutter button is shown when `clientCanCapture` and
  the agent accepts image inputs (existing `acceptsImageInput`
  inferred from the driver's modality flags).
- **F9. No silent failures.** Every error path on either side
  surfaces a meta line in the chat ("Screenshot failed: <reason>")
  for the manual flow, or a text content block in the tool result
  for the agent flow. No spinning indicators that never resolve.
- **F10. Rate limiting.** No more than 6 MCP captures per minute per
  session; bursts beyond cap return "rate limit exceeded — retry in
  Ns" as a text block. Configurable.

## Non-functional requirements

- **N1. Latency.** Manual capture → composer visible: < 400 ms on
  iPhone. MCP round-trip (bridge → phone → bridge with upload):
  median < 1.5 s, p95 < 3 s.
- **N2. Bundle.** The native dependency added for capture
  (`react-native-view-shot`) does not require ejecting Expo Go in
  development; CI dev build picks it up via the prebuild config
  plugin. Web target falls back gracefully (no shutter, no
  agent-side tool exposed).
- **N3. Battery.** No background polling. The phone only does work
  when (a) the user taps shutter or (b) the agent triggers a capture
  and the WebView is mounted.
- **N4. Token cost transparency.** The image's approximate input-
  token cost is shown in the meta line when a capture lands in chat
  (manual or autonomous). User can see what each screenshot "costs."
- **N5. Privacy.** Captures contain whatever is on the user's
  preview. They are uploaded via the existing authenticated upload
  endpoint and live on the bridge's filesystem with the same
  lifecycle as other attachments. No third-party services involved.

## Definition of done

- Both flows (manual M1–M4, agent A1–A3) work end-to-end on a real
  device against a real dev server.
- `take_screenshot` is gated by capability + permission + per-session
  toggle; the stub agent regression test (capability flags off) hides
  the shutter button and does not expose the tool to the agent.
- An unreachable phone, an unmounted WebView, and a rate-limited burst
  all produce typed error results, not hangs.
- Type-check clean on bridge and mobile; web build succeeds with the
  shutter hidden.
- The "no magic strings" gate continues to hold: new wire frames have
  named constants matching the existing pattern.
