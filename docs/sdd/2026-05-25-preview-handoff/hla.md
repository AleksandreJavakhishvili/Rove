# High-Level Architecture — Preview Handoff (user-direction)

Reference: [frd.md](./frd.md), [plan.md](./plan.md),
[preview-takeover](../2026-05-25-preview-takeover/) (required
dependency), [visual-feedback-loop](../2026-05-25-visual-feedback-loop/).

## Context

This SDD adds user-direction to the preview surface: a new
`prepare_preview` MCP tool, two new WS frames, and an extension of
the takeover SDD's shared state machine. No parallel reducers, no
direction-supervisor framework, no auth heuristics.

## Gate inheritance

The takeover SDD ships a global `enableVisualFeedback` Settings
switch + the `set_visual_feedback_enabled` WS frame + the
per-session map on the bridge. This SDD adds **zero** new gates
at the global level — `prepare_preview`'s handler reads
`isVisualFeedbackEnabled(sessionId)` as its first check, same as
`take_screenshot`. Turning the switch off in Settings disables
both tools.

The handler-level gate order for `prepare_preview` matches
`take_screenshot`:

1. `isVisualFeedbackEnabled(sessionId)` (from takeover Phase 0)
2. Per-session header toggle
3. `getDispatch(sessionId)` exists (no_client)
4. Rate limit (shared bucket)
5. Broker round-trip

The `alwaysAskBeforeCapture` Settings sub-option (also from
takeover Phase 0) extends the `<ApprovalSheet>` lookup so the
"Always allow" button is hidden for `prepare_preview` too. The
approval-sheet code checks `qualifiedToolName ∈
{SCREENSHOT_MCP_TOOL_QUALIFIED, PREPARE_PREVIEW_MCP_TOOL_QUALIFIED}`.

## Architectural pillars

1. **Extend, don't duplicate.** The takeover SDD shipped
   `previewDirectionMachine.ts` with `direction: 'agent'` /
   `policy: 'debounce'`. We widen both unions and add the new
   states/events/effects to the same file. One reducer, two
   directions.
2. **Modal first, then pill.** Handoff is an *ask*, not a brief
   capture. The user needs to see the agent's instructions clearly
   before deciding to engage. Modal cross-fades to pill once they
   tap "Open Preview."
3. **No supervisor.** The SDK is sequential — `take_screenshot` and
   `prepare_preview` can't be in flight from the same agent at the
   same time. The only cross-mode collision is the manual shutter,
   handled by one disabled-state line.
4. **Reuse the path validator.** `validatePreviewPath` from the
   takeover SDD validates `suggestedPath` here. One helper, one
   set of rules.
5. **Handoff-to-capture bridge.** A small grace window lets the
   controller transition directly from handoff `exiting` to
   takeover `active` without the restore step — eliminates the
   "preparation just succeeded, now the screen flickers back and
   forth" UX.

## Reducer extension

The takeover SDD shipped:

```ts
type Direction = 'agent';
type Policy    = 'debounce';
```

This SDD widens to:

```ts
type Direction = 'agent' | 'user';
type Policy    = 'debounce' | 'explicit';
```

New states:

- `modal` — between `requesting` and `engaging`, only when
  `direction === 'user'`. The bottom-sheet modal is visible; user
  hasn't tapped "Open Preview" yet.

New events:

- `open_preview_tapped` — modal → engaging (user-direction).
- `done_tapped` — active → exiting, includes `finalUrl?`.
- `skip_tapped` — active → exiting, includes `note?`.
- `timeout_fired` — modal | engaging | active → exiting.
- `capture_complete` (already exists, behaves differently with
  `policy: 'explicit'`: no debounce, immediate exit).

New effects:

- `show_handoff_modal` — present the modal sheet.
- `morph_to_pill` — cross-fade modal away, pill becomes visible.
- `reply_handoff` — send `prepare_preview_result` over WS with the
  status + optional finalUrl/note.
- `arm_handoff_timeout` — set up the per-call timeout timer.

Updated transition table (additions only):

| Event                 | idle        | requesting  | modal       | engaging    | active                  | exiting |
|-----------------------|-------------|-------------|-------------|-------------|-------------------------|---------|
| prepare_preview req'd | requesting  | (queue)     | (queue)     | (queue)     | (queue)                 | (queue) |
| permission_granted    | —           | modal*      | —           | —           | —                       | —       |
| open_preview_tapped   | —           | —           | engaging    | —           | —                       | —       |
| done_tapped           | —           | —           | —           | —           | exiting+reply           | —       |
| skip_tapped           | —           | —           | exiting     | exiting     | exiting+reply           | —       |
| cancel_tapped         | —           | idle+reply  | exiting     | exiting     | exiting+reply           | —       |
| timeout_fired         | —           | idle+reply  | exiting+rep | exiting+rep | exiting+reply           | —       |
| capture_complete      | —           | —           | —           | —           | exiting (if 'explicit') | —       |

`modal*` only when direction='user'; agent-direction skips straight
to `engaging` per the takeover SDD's existing flow.

### Handoff-to-capture grace window

A new transition: if state is `exiting` with
`direction: 'user'`, and a `request_screenshot` arrives within
`HANDOFF_TO_CAPTURE_GRACE_MS`, instead of completing the exit we
**re-enter `engaging` with `direction: 'agent'` / `policy: 'debounce'`
using the same snapshot** (skip restore + re-engage). The pill copy
swaps from "Preparing" to "Verifying"; pager + locks stay where they
are.

If the grace window expires without a follow-up screenshot, the
normal exit completes.

## Wire frames

```ts
// ServerToClient (new)
| {
    type: 'prepare_preview_request';
    requestId: string;
    instructions: string;
    suggestedPath?: string;
    timeoutSeconds?: number;
  }

// ClientToServer (new)
| {
    type: 'prepare_preview_result';
    requestId: string;
    status: 'ready' | 'skipped' | 'cancelled';
    finalUrl?: string;   // set when status='ready'
    note?: string;       // optional user-typed annotation
  }
```

Constants (added to `bridge/src/agents/types.ts`, mirrored in
`mobile/lib/types.ts`):

```ts
export type HandoffResultStatus = 'ready' | 'skipped' | 'cancelled';
export const HANDOFF_RESULT_STATUS = {
  ready: 'ready',
  skipped: 'skipped',
  cancelled: 'cancelled',
} as const satisfies Record<HandoffResultStatus, HandoffResultStatus>;

export const HANDOFF_RESULT_STATUSES = Object.values(
  HANDOFF_RESULT_STATUS,
) as readonly HandoffResultStatus[];

export const PREPARE_PREVIEW_MCP_TOOL_NAME = 'prepare_preview';
export const PREPARE_PREVIEW_MCP_TOOL_QUALIFIED =
  `mcp__${SCREENSHOT_MCP_SERVER_NAME}__${PREPARE_PREVIEW_MCP_TOOL_NAME}` as const;

export const HANDOFF_DEFAULT_TIMEOUT_SECONDS = 300;
export const HANDOFF_MAX_TIMEOUT_SECONDS = 1_800;
export const HANDOFF_INSTRUCTIONS_MAX_LEN = 280;
export const HANDOFF_NOTE_MAX_LEN = 200;
export const HANDOFF_TO_CAPTURE_GRACE_MS = 500;
export const HANDOFF_MODAL_FADE_MS = 250;
```

No magic strings or numbers.

## Bridge components

### Files (new)

- `bridge/src/handoffBroker.ts` — mirrors `screenshotBroker.ts`:
  - `pendingHandoffs: Map<requestId, { sessionId; resolve; timer }>`
  - `requestHandoff(sessionId, options, dispatch)` → `Promise<HandoffOutcome>`
  - `resolveHandoff(requestId, payload)`
  - `cancelHandoffsForSession(sessionId, reason)` for WS drop
  - Reuses the **same** `dispatchers` map keyed by sessionId from
    `screenshotBroker.ts` — we export a shared helper from
    screenshotBroker rather than duplicating the registry.

### Files modified

- `bridge/src/agents/types.ts` — add all constants above.
- `bridge/src/types.ts` — extend `ServerToClient` /
  `ClientToServer` with the new frames.
- `bridge/src/server.ts` — Zod schema for `prepare_preview_result`,
  route to `handoffBroker.resolveHandoff`. On WS close: drain both
  brokers' pending for that session with `cancelled`.
- `bridge/src/agents/claudeCodeSdk.ts` — second `sdkTool` on the
  `rove` MCP server:
  ```ts
  sdkTool(
    PREPARE_PREVIEW_MCP_TOOL_NAME,
    'Ask the user to prepare the preview...',
    {
      instructions: z.string().min(1).max(HANDOFF_INSTRUCTIONS_MAX_LEN),
      suggestedPath: z.string().optional(),
      timeoutSeconds: z.number().int().min(1).max(HANDOFF_MAX_TIMEOUT_SECONDS).optional(),
    },
    async (args) => this.handlePreparePreview(args),
  )
  ```
  Handler gates in order:
  1. Per-session toggle (shared with screenshot).
  2. Client attached (shared dispatcher registry).
  3. Rate limit (shared bucket — handoffs and screenshots count
     against the same per-session limit).
  4. Broker round-trip with the configured timeout.
  5. Format result as single text content block with status prefix.

No supervisor, no `direction_busy` reason, no concurrency
framework. The SDK calls tools sequentially.

## Mobile components

### Files (new)

```
mobile/components/handoff/
  HandoffSheet.tsx           ← bottom-sheet modal
  HandoffPill.tsx            ← top pill once "Open Preview" tapped
```

### Files modified

- `mobile/components/takeover/previewDirectionMachine.ts` —
  widened unions, new states/events/effects per "Reducer extension"
  above.
- `mobile/components/takeover/useTakeover.ts` — interprets the new
  effects (show_handoff_modal, morph_to_pill, reply_handoff,
  arm_handoff_timeout). May get renamed to `usePreviewDirection`
  for accuracy.
- `mobile/components/takeover/TakeoverController.tsx` — extended to
  subscribe to `prepare_preview_request` frames too. Renders
  `<HandoffSheet>` or `<HandoffPill>` depending on state. May get
  renamed to `<PreviewDirectionController>`.
- `mobile/components/takeover/TakeoverIndicator.tsx` — copy varies
  by direction; we either generalise this component or have
  `<HandoffPill>` as a sibling. **Decision (LLD):** keep them
  separate. The takeover pill's affordances are
  `Cancel`; the handoff pill's are `Done` + `Cancel`. Different
  enough to justify a sibling.
- `mobile/components/takeover/toolLabels.ts` — add the
  `prepare_preview` entry alongside `take_screenshot`.
- `mobile/components/WorkspacePane.tsx` — the manual shutter button
  reads a new prop `disabled` (or consults a context); set true
  while handoff is `active`.
- `mobile/app/sessions/[agent]/[id]/index.tsx` — wire
  `prepare_preview_request` WS messages into the controller (same
  pattern as `request_screenshot`).
- `mobile/lib/types.ts` — mirror the new wire frames + constants.

## Lifecycle: agent asks user to log in then captures

```
t=0      WS prepare_preview_request { instructions: "Please log in to /admin", suggestedPath: "/admin" }
t=0      requesting → permission grant cached → modal
t=20ms   HandoffSheet visible
t=2.4s   user taps "Open Preview"
         modal → engaging
         pager swap to preview
         workspaceHandle.setMode('preview')
         locks pushed (incl. manual shutter)
         previewHandle.navigate('/admin')
         HandoffSheet cross-fades out, HandoffPill cross-fades in (250ms)
         engaging → active
t=2.7s   page loads → SPA redirects to /login (cookie absent)
t=14.0s  user finishes typing credentials, taps "Log in" inside the WebView
t=15.2s  WebView lands back on /admin
t=15.6s  user taps "Done" on the pill
t=15.6s  read previewHandle.currentUrl() → '/admin'
         send prepare_preview_result { status: 'ready', finalUrl: '/admin' }
         done_tapped → exiting (direction: 'user')
         arm handoff-to-capture grace timer (500ms)

t=15.8s  agent reads "ready: /admin" → calls take_screenshot('/admin')
t=15.8s  WS request_screenshot arrives during grace window
         controller transitions exiting → engaging WITHOUT restore
         direction swaps user → agent, policy explicit → debounce
         pill copy swaps "Preparing" → "Verifying"
         captureAndUpload runs against the user-prepared state
t=16.0s  capture done; debounce(3s) armed
t=19.0s  debounce expires → exiting → idle (full restore now)
```

## Lifecycle: skip with a note

```
t=0      WS prepare_preview_request → modal
t=8s     user taps "Skip" — pill optionally expands a note input
t=20s    user types "not going to log in for this", taps confirm
t=20s    skip_tapped → exiting+reply
         send { status: 'skipped', note: 'not going to log in for this' }
t=20.25s controller restores prior state → idle
```

## Lifecycle: timeout

```
t=0      WS prepare_preview_request { timeoutSeconds: 60 }
t=0      modal visible; timeout timer armed at 60s
t=60s    timeout_fired → exiting
         send { status: 'cancelled' } from phone? NO — phone doesn't
         know about timeout; the broker-side timeout fires at 10s
         past `timeoutSeconds` (network slack) and resolves the tool
         with `timeout` text. If the phone replies after, broker
         silently drops the late frame.
```

(The phone has its own UI-side timeout for the modal — same value
as the broker's, with the phone resolving locally if it fires
first. The broker's later-by-network-slack drop is the safety net.)

## Bridge tool result format

Successful handoff:

```ts
{
  content: [{
    type: 'text',
    text: `ready: ${finalUrl ?? '(unknown url)'}`,
  }],
}
```

Skipped:

```ts
{
  content: [{
    type: 'text',
    text: note ? `skipped: ${note}` : 'skipped',
  }],
}
```

Cancelled / timeout:

```ts
{ content: [{ type: 'text', text: 'cancelled' | 'timeout' }] }
```

Same convention as `take_screenshot`'s failure-mode text results.

## Manual-shutter coordination

The only cross-mode guard in the entire effort. Implementation:

- The `PreviewShutter` component reads a `disabled` prop (or a
  `useHandoffActive()` context hook).
- The controller exposes the current state.
- While `state.kind ∈ {modal, engaging, active}` AND
  `direction === 'user'`, the shutter is disabled with a tooltip.

That's it. No supervisor, no broker-side gate, no shared lock.

## Permission integration

The `<ApprovalSheet>` copy lookup gets a second entry alongside the
one the takeover SDD adds:

```ts
[PREPARE_PREVIEW_MCP_TOOL_QUALIFIED]: {
  label: 'Ask you to prepare the preview',
  summary: (input) => {
    const instr = typeof (input as { instructions?: unknown }).instructions === 'string'
      ? (input as { instructions: string }).instructions
      : 'set up the preview';
    return `Claude wants to ask you to: "${instr}"`;
  },
},
```

Allow-always grants apply per-tool (qualified names hash separately).

## Risks + mitigations

- **The grace window is the only mode transition that skips the
  restore step.** If it fires when it shouldn't (e.g. a stale
  capture request from a previous turn arrives 400ms after a
  handoff), we'd skip restore wrongly. Mitigation: the grace
  window is keyed on the controller having *just* sent a
  `ready` reply, not on any timer overlap. Window starts on the
  `done_tapped` transition; any earlier captures are queued
  through normal flow.
- **Modal-then-pill cross-fade may overlap with pager animation.**
  Mitigation: the modal fades out first (100ms), pager swap runs
  (220ms), pill fades in (100ms). Serialised, not parallel.
- **Handoff timeout default of 5 min is a guess.** Documented as
  such. Revisit when we see real usage.
- **User-typed note can be too long.** Capped at
  `HANDOFF_NOTE_MAX_LEN` (200 chars) client-side; bridge also
  enforces in the Zod schema.

## Limitations (known and accepted)

- **Agent might over- or under-use the tool.** No mitigation in
  scope. Sharpen the tool description if usage patterns are bad.
- **Toggle disables both tools together.** Documented as an
  asymmetry against allow-always-per-tool. Future split if needed.
- **Skip-loop.** Agent keeps asking, user keeps skipping. Rate
  limiter caps the burst rate; otherwise the model has to adapt.

## Definition of done (architecture-level)

- `previewDirectionMachine.ts` reducer extended with `direction:
  'user'`, `policy: 'explicit'`, and the new events / states /
  effects. Reducer unit tests cover the new transitions, the
  modal-state, and the handoff-to-capture grace window.
- `handoffBroker.ts` ships in `bridge/src/`. Reuses the
  screenshotBroker's dispatcher registry (no duplicate map).
- `prepare_preview` MCP tool registered on the same in-process
  server as `take_screenshot`. Single-purpose: returns one of four
  typed text results.
- Wire frames + constants exist on bridge + mobile (single source
  of truth via shared `HANDOFF_RESULT_STATUS`).
- `<HandoffSheet>` + `<HandoffPill>` ship as sibling presentation
  components.
- `<TakeoverController>` (or `<PreviewDirectionController>`)
  subscribes to both `request_screenshot` and
  `prepare_preview_request` frames. Renders the right
  sheet/pill/indicator based on direction.
- Manual shutter button disabled while handoff active. No
  direction-supervisor framework.
- Approval-sheet copy lookup covers
  `mcp__rove__prepare_preview`. The
  `alwaysAskBeforeCapture` Settings sub-option applies to both
  tools — "Always allow" button suppressed for either when on.
- `prepare_preview` handler reads
  `isVisualFeedbackEnabled(sessionId)` as its first gate; off →
  `disabled_by_user` text. No new settings, no new wire frame —
  inherited from the takeover SDD's Phase 0.
