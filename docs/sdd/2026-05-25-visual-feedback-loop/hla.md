# High-Level Architecture — Visual Feedback Loop

Reference: [frd.md](./frd.md), [plan.md](./plan.md).

## Context

This effort gives the agent and the user a shared visual surface: the
live preview rendered in the mobile WebView. The phone is already the
only thing rendering the dev server; this work adds two ways to lift
those pixels into the conversation — a user-initiated shutter button
("send what I see") and an MCP tool the agent can call to verify its
own work.

The work sits on top of:
- The capability-negotiation pattern from the SDK driver migration
  (`docs/sdd/2026-05-21-sdk-driver-migration/`).
- The mobile pager and the combined `WorkspacePane` introduced in the
  mobile file-visibility effort
  (`docs/sdd/2026-05-24-mobile-file-visibility/`). The shutter button
  lives inside Preview mode of that pane.
- The existing upload endpoint and attachment send path used by the
  chat composer's camera-roll picker.

No new transport, no new auth surface, no new agent.

## Architectural pillars

1. **Phone-side capture is the source of truth.** The user sees what
   the user sees. Headless browser on the bridge is explicitly *not*
   v1 — listed as deferred so we don't end up with two diverging
   render targets.
2. **One capture pipeline, two triggers.** Both the manual shutter
   and the agent-initiated MCP tool produce the same artifact (a PNG
   uploaded via the existing upload endpoint) and arrive in the
   conversation through the same image-attachment plumbing. The
   trigger differs; everything downstream is shared.
3. **Capabilities + permissions + per-session toggle.** Three gates
   in series: the driver must declare `screenshotCapture`, the
   client must declare `clientCanCapture`, *and* the user must allow
   the tool when it first fires. The chat header surfaces the
   per-session toggle so the user can flip it off mid-session.
4. **WS request/response, not fire-and-forget.** The bridge → phone
   round-trip uses a correlation id (`requestId`) so the bridge can
   resolve the in-flight MCP tool promise. Timeout discipline lives
   on the bridge side; the phone is free to ignore late frames.
5. **Errors are typed, not exceptional.** Every failure path
   resolves to a defined wire-frame shape, and the agent receives a
   text content block describing the failure. The agent decides what
   to do next; nothing hangs and nothing throws into the tool runner.

## Target topology

```
                ┌──────────────────────────────────────────┐
                │ mobile (Expo RN + react-native-web)      │
                │                                          │
                │ WorkspacePane (mode=preview)             │
                │  ├── <PreviewPane>                       │
                │  │    ├── WebView (existing)             │
                │  │    └── viewShot ref (NEW)             │
                │  └── shutter button (NEW, floating)      │
                │       └─tap→ <ScreenshotComposer>        │
                │              ├── thumbnail               │
                │              ├── note input              │
                │              ├── Send / Cancel           │
                │                                          │
                │ session WS (existing)                    │
                │  ├── recv: request_screenshot (NEW)      │
                │  └── send: screenshot_result (NEW)       │
                │                                          │
                │ session state (zustand)                  │
                │  └── allowVisualVerification: boolean    │
                └──────────┬───────────────────────────────┘
                           │  WS + HTTP upload
                           ▼
        ┌──────────────────────────────────────────────────┐
        │ bridge (Node / Hono)                             │
        │                                                  │
        │ session router                                   │
        │  ├── POST /upload (existing)                     │
        │  ├── WS frames                                   │
        │  │    ├── send: request_screenshot (NEW)         │
        │  │    └── recv: screenshot_result (NEW)          │
        │  │                                               │
        │  └── MCP tool registry                           │
        │       └── take_screenshot (NEW)                  │
        │            ├── allocate requestId                │
        │            ├── push request to client WS         │
        │            ├── register Promise (10s timeout)    │
        │            ├── on screenshot_result → fetch      │
        │            │   uploaded bytes, return image      │
        │            │   content block                     │
        │            └── on timeout / disabled / no client │
        │                → text content block w/ reason    │
        │                                                  │
        │ capabilities                                     │
        │  └── { screenshotCapture: boolean }              │
        │                                                  │
        │ rate limiter                                     │
        │  └── 6 captures / 60s / session                  │
        └──────────────────────────────────────────────────┘
                           │
                           ▼
              Claude Agent SDK (existing)
              └── canUseTool → permission flow
                  └── tool_result with image block lands
                      in the next assistant turn
```

## Wire model

### New WS frames (server → client)

```ts
| { type: 'request_screenshot'; requestId: string; path?: string;
    waitMs?: number }
```

`path` is interpreted by the client as a relative URL inside the
existing PreviewPane WebView origin. `waitMs` is an upper bound on
the post-navigation settle time; clamped server-side to [0, 2000].

### New WS frames (client → server)

```ts
| { type: 'screenshot_result'; requestId: string;
    ok: true; uploadId: string }
| { type: 'screenshot_result'; requestId: string;
    ok: false; reason: ScreenshotErrorReason }
```

`uploadId` is the existing upload-pipeline reference; bridge resolves
it the same way the chat send path does for camera-roll attachments.

```ts
type ScreenshotErrorReason =
  | 'not_mounted'      // WebView not on a mounted PreviewPane
  | 'capture_failed'   // captureRef threw
  | 'upload_failed'    // upload pipeline rejected
  | 'cancelled'        // user navigated away mid-capture
  | 'unsupported';     // running on a platform that can't capture
```

Named constants in both `bridge/src/agents/types.ts` and
`mobile/lib/types.ts` mirror each other ("no magic strings").

### New MCP tool surface

```ts
take_screenshot({
  path?: string;        // default "" (current URL)
  waitMs?: number;      // default 300, clamped to [0, 2000]
}) → ContentBlock[]
```

Successful result: `[{ type: 'image', source: { type: 'base64',
data: <PNG>, media_type: 'image/png' } }]`.

Failure result: `[{ type: 'text', text: '<machine-readable reason>:
<human-readable details>' }]` so the agent can pattern-match on
known reasons (`timeout`, `disabled_by_user`, `rate_limited`,
`no_client`, `unsupported_client`).

### Capabilities (new fields on AgentCapabilities)

```ts
interface AgentCapabilities {
  // ...existing fields...
  /** Driver exposes the take_screenshot MCP tool to the agent. */
  screenshotCapture?: boolean;
}
```

Client-side counterpart lives in the WS hello / status payload so the
bridge knows whether to even register the in-flight promise:

```ts
interface ClientHello {
  // ...existing...
  clientCanCapture?: boolean;
}
```

If `clientCanCapture` is false, every `take_screenshot` call
short-circuits to `[{ type: 'text', text: 'no_client: phone
unavailable' }]` immediately — no WS frame sent, no timeout wait.

## Components

### Mobile

- **`components/PreviewPane.tsx`** (existing) gets a `viewShot` ref
  attached to the WebView (or its parent View — TBD per
  `view-shot` semantics; see LLD).
- **`components/ScreenshotComposer.tsx`** (NEW). Modal sheet with
  thumbnail, comment input, Send, Cancel. Reuses the existing
  `uploads.ts` pipeline. On Send: posts a normal user message with
  text + attachment, swaps pager to chat.
- **`components/PreviewShutter.tsx`** (NEW). Floating shutter button
  rendered only when:
  - `WorkspacePane.mode === 'preview'`,
  - `clientCanCapture` is true on this platform,
  - the agent driver advertises `acceptsImageInput` (existing
    capability inferred from the driver's modality flags — needs
    one-line addition if not already exposed).
- **`hooks/useScreenshotCapture.ts`** (NEW). Owns the capture
  primitive (`captureRef → base64 → upload`) and exposes it to both
  the shutter (manual flow) and the WS handler (agent flow).
- **`app/sessions/[agent]/[id]/index.tsx`** wires the new WS
  request-screenshot frame: when received, calls the hook, posts
  back `screenshot_result`. When the WebView isn't mounted (user is
  on the chat or files tab and the WebView was unmounted via
  display-toggle — actually it stays mounted in our current
  layout), returns `not_mounted`.

### Bridge

- **`bridge/src/agents/claudeCodeSdk.ts`** registers an MCP tool
  via the existing `canUseTool` machinery. Tool handler:
  - checks per-session toggle (in-memory map keyed by sessionId),
  - checks rate limiter,
  - checks `clientCanCapture` from the active socket's hello,
  - allocates a `requestId` and registers a Promise in a
    `pendingScreenshots: Map<requestId, { resolve, timer }>`,
  - sends `request_screenshot` to the client,
  - awaits with 10 s timeout,
  - resolves to image content block or text content block.
- **`bridge/src/server.ts`** WS handler routes
  `screenshot_result` frames to the pending-screenshots map. If
  the requestId is unknown (late frame), discard silently.
- **`bridge/src/server.ts`** exposes a small endpoint
  `POST /session/:agent/:id/screenshot-toggle` so the chat header
  can flip the per-session allow flag. Or — simpler — route it
  through the existing WS as a new client→server frame
  `set_screenshot_allow`. Pick one in LLD; the WS frame is
  preferred because there's no need to think about HTTP auth /
  the per-session pubsub.

### Header surface

A new menu item under the existing ellipsis menu:
- **Visual verification** with an `on/off` switch. Default `on`
  after first permission grant; explicit `off` when never granted.
  Tapping toggles and sends `set_screenshot_allow` over the WS.

## Permission flow

The MCP tool is wired through the same `canUseTool` callback the
existing tools use. First time `take_screenshot` fires in a session:

1. Bridge emits `permission_request` event (existing wire frame).
2. Mobile shows the existing approval sheet — same UI as `Bash`,
   `Edit`, etc.
3. User picks allow / allow-always / deny.
4. On allow: proceed to phone round-trip.
5. On deny: the tool result is `[{ type: 'text', text:
   'permission_denied: user declined' }]`. The agent's permission
   cache continues to apply per its existing rules.

The per-session toggle is a *second* gate, set independently of the
permission flow. Even after allow-always, a user can flip the toggle
off to disable autonomous captures for the rest of the session.

## Data flow

### Manual capture (M1)

```
shutter tap
  → captureRef(webViewRef) → base64 PNG
  → composer sheet opens with thumbnail
  → user types note + Send
  → POST /upload (existing)            → uploadId
  → user_message frame (existing)
      { content, attachments:[uploadId] }
  → pager swaps to chat
  → bridge → driver → SDK forwards as multimodal user turn
```

### Agent capture (A1)

```
SDK assistant turn
  → canUseTool('take_screenshot', {...})
  → bridge tool handler:
      check toggle / rate / clientCanCapture
      allocate requestId, register Promise
  → WS send: request_screenshot
  → phone:
      captureRef(webViewRef) → base64
      POST /upload                       → uploadId
      WS send: screenshot_result
                 { requestId, ok:true, uploadId }
  → bridge resolves Promise with image content block
  → SDK returns image to assistant turn
  → Claude reads pixels in same turn
```

### Failure modes (timeline)

| When                                   | Result returned to SDK                        |
|----------------------------------------|------------------------------------------------|
| `clientCanCapture` is false            | `text: no_client`                              |
| Per-session toggle off                 | `text: disabled_by_user`                       |
| Permission denied                      | `text: permission_denied`                      |
| Rate limit exceeded                    | `text: rate_limited:retry_in_Ns`              |
| Phone WS dropped before reply          | `text: timeout` (after 10 s)                   |
| `screenshot_result ok:false`           | `text: <reason>` (mirror the phone's reason)   |

All of these are normal tool results — no exceptions thrown into the
agent loop.

## Backward compatibility

- Existing sessions on drivers that don't advertise
  `screenshotCapture` see no behavior change: the tool isn't
  registered, the agent can't call it, the manual shutter doesn't
  light up (assuming the driver also doesn't advertise
  `acceptsImageInput`).
- Existing chat composer attachment flow (camera roll, document
  picker) is unchanged.
- Existing pager / workspace layout is unchanged; the shutter is an
  overlay inside `WorkspacePane.mode === 'preview'`, not a route.

## Deferred work

1. **Bridge-side headless capture.** When the phone is unavailable
   or the user wants screenshots of routes they haven't navigated to,
   the bridge could spawn Playwright. Out of scope for v1 to avoid
   shipping a 300 MB Chromium dependency before we know it's earning
   its keep. Listed here so the wire model leaves room for it (the
   tool args already accept `path`; the implementation just needs a
   different executor).
2. **Auto-trigger after file change.** A "verify after edit" mode
   that debounces `file_changed` for web files and synthesizes a
   `take_screenshot` call. Trivial once the manual + MCP flows work;
   adds a header toggle and a debounce timer. Held for v2 once token
   cost behavior is observed.
3. **Perceptual diff to skip identical shots.** A pHash on captured
   PNGs that suppresses uploads when nothing visible changed. Saves
   tokens on the autonomous loop; not needed for pull-mode.
4. **Annotation tools.** Arrows / circles / highlight overlays on the
   thumbnail in the composer sheet before send. v1 ships text comment
   only.
5. **Region selection.** Crop to a tapped element instead of full
   page. Listed because frontend bugs often have a clear "this box"
   target; not a launch blocker.

## Risks and mitigations

- **WebView capture returns blank.** Known iOS quirk if the WebView
  hasn't drawn yet. Mitigation: a one-time warmup render at session
  start (PreviewPane already mounts on session entry); fall back to
  retry-once before returning `capture_failed`.
- **Token bonfire on autonomous loops.** The agent in pull-mode is
  on its own to decide cadence. Rate limit (F10) is the hard floor;
  per-session toggle (F7) is the user's escape hatch. Future
  perceptual-diff feature is the more elegant fix.
- **Permission fatigue.** The user already approves Bash, Edit, etc.
  Adding `take_screenshot` to the queue is one more prompt. Allow-
  always works the same way it does for other tools and is the
  right answer for most users.
- **Privacy of preview contents.** The captured image is whatever the
  WebView is showing — that may include local-only dev data, account
  context, etc. Mitigation: a one-line warning the first time the
  permission flow fires, and per-session toggle as the kill switch.
  The image lives only on the bridge filesystem; no third-party.
- **Web target.** `react-native-view-shot` has limited web support.
  Web client should advertise `clientCanCapture: false` and the
  shutter is hidden. Future work: HTML2Canvas fallback if there's
  user demand from the web client.

## Definition of done (architecture-level)

- The wire model above is implemented exactly: `request_screenshot`,
  `screenshot_result`, `set_screenshot_allow` all exist with their
  named constants in both `bridge/src/agents/types.ts` and
  `mobile/lib/types.ts`.
- `take_screenshot` is a registered MCP tool that goes through
  `canUseTool`, surfaces a permission prompt on first call, returns
  typed text results on every failure path, and never throws into
  the SDK loop.
- Manual shutter + composer is wired and posts a normal multimodal
  user turn — observable as a chat bubble with an image attachment
  identical to a camera-roll attached photo.
- Capability gating is real on both sides (driver flag +
  client-capable flag + per-session toggle), and the stub-agent
  regression hides the tool and the shutter without crashing.
- Rate limiter exists with a configurable cap; bursts return a
  typed text result rather than blocking.
