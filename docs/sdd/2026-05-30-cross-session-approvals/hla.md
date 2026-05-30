# Cross-Session Approvals — High-Level Architecture

## Summary

This is a **presentation-layer-only** feature on the mobile client. All cross-session permission data already flows into an app-level store; the work is to add an in-chat surface that reads "all pending requests *except the focused session's*" and lets the user resolve them. No bridge changes, no new events, no new store fields beyond a small persisted UI preference (badge position).

## What already exists (reused as-is)

```
        bridge  /events  (WS, bridge-wide)
                   │  permissions_snapshot / permission_added / permission_resolved
                   ▼
   usePendingPermissions  (mobile/lib/store.ts)        ← app-level, survives navigation
     • byKey: Record<"agent:sessionId", PendingPermissionSnapshot[]>
     • ensureStreaming(baseUrl, token)  (idempotent)
     • removeOne(agent, sessionId, toolUseId)   ← optimistic resolve
                   │
        ┌──────────┴───────────────────────────────┐
        ▼                                           ▼
  sessions list (app/index.tsx)            NEW: in-chat surface
   • totalPending / per-row chips           (this effort)
   • decide(p, decision)  → sendApproval
```

Relevant existing types/functions:

- `PendingPermissionSnapshot` (`mobile/lib/bridge.ts:537`): `{ agent, sessionId, toolUseId, tool, input, cwd, createdAt }`. Note it carries `cwd` and `createdAt` — enough to identify the repo and order requests.
- `sendApproval(cfg, agent, sessionId, toolUseId, decision)` (`mobile/lib/bridge.ts:612`) — the decision path the list already uses.
- `usePendingPermissions.byKey` / `removeOne` (`mobile/lib/store.ts:264`).
- `dangerLevel(tool, input)` and `summarize(tool, input)` in `ApprovalSheet.tsx`; `summarizeToolInput(tool, input)` in `app/index.tsx` — **duplicated** summary logic. See "Shared helpers" below.

## New components

```
ChatScreen (app/sessions/[agent]/[id]/index.tsx)
  │
  └── <CrossSessionApprovals currentAgent={agent} currentSessionId={id} />   ← single mount point
        │   subscribes: usePendingPermissions(byKey), useBadgePosition()
        │   derives: othersPending = flatten(byKey) where key !== `${agent}:${id}`
        │
        ├── <ApprovalWhisper request={latestArrival} onPress={openTray} />    (transient, top)
        ├── <ApprovalBadge count onPress={openTray} position draggable />     (persistent, edge)
        └── <ApprovalTray open requests={othersPending} onResolve onOpenSession />  (bottom sheet)
```

A **single controller component** `CrossSessionApprovals` owns the whisper → badge → tray state machine and is mounted once in the chat screen. It is the only new wiring point in `ChatScreen`.

### Component responsibilities

- **`CrossSessionApprovals` (controller).**
  - Selects `othersPending` from the store (memoized; excludes the focused session key).
  - Tracks "new arrivals" to drive the whisper: diff the incoming set against what's already been acknowledged, so re-renders don't re-whisper old requests.
  - Owns ephemeral UI state: `whisperRequest | null`, `trayOpen: boolean`. (Persistent badge position lives in the store — see below.)
  - Calls the shared `decide()` helper on resolve, which calls `sendApproval` + optimistic `removeOne`.

- **`ApprovalWhisper` (transient banner).** Pure presentational, top-anchored, auto-dismiss timer, haptic on mount, `onPress → openTray(requestId)`. No decision controls. De-dupes: at most one visible; new arrivals while one is showing just refresh the count, they don't queue banners.

- **`ApprovalBadge` (persistent, draggable).** Renders only when `count > 0`. Uses `react-native-gesture-handler` + `react-native-reanimated` (already used elsewhere in the app — verify in plan) for drag; on release, animates a snap to the nearer of the two edges and writes `{ side, y }` back to the persisted store. Tap vs. drag disambiguated by a movement threshold.

- **`ApprovalTray` (bottom sheet).** Overlays the chat without unmounting it (sibling overlay / `Modal transparent` anchored to bottom, consistent with `ApprovalSheet`'s pattern). Renders one row per pending request across all background sessions, grouped or sorted by `createdAt`. Inline Allow/Always/Deny + swipe gestures + per-row "Open". Empty state when drained.

### Badge position persistence

Add a tiny slice to the store (or extend an existing prefs slice) persisted to the same storage layer the app already uses for prefs (e.g. the `selectedPort`/`customLabels` prefs in `store.ts`):

```ts
interface BadgePositionState {
  side: 'left' | 'right';   // default 'right'
  y: number;                // clamped to message-list bounds at render time
  setPosition(side, y): Promise<void>;
}
```

`y` is stored as the drop position; the renderer clamps it into the safe band (below header, above composer) each mount, so a stored `y` from a taller screen degrades gracefully.

### Shared helpers (de-duplication)

`summarize`/`summarizeToolInput`/`dangerLevel` exist in two places today. Extract them into one module (e.g. `mobile/lib/toolSummary.ts`) and have `ApprovalSheet`, the sessions list, and the new tray all import it. This keeps the risk heuristic and input summary identical across every approval surface — important because US-4 (no blind approvals) depends on the tray's risk cue matching what users already learned from `ApprovalSheet`. This is a small refactor bundled into the plan, not a separate effort.

Likewise the `decide()` logic (busy-set + `sendApproval` + optimistic `removeOne` + error Alert) is currently inline in `index.tsx`. Extract a `usePermissionDecision()` hook (or plain async helper) shared by the list and the tray so both resolve identically.

## State machine (per controller)

```
                othersPending gains a request not seen before
                                   │
                                   ▼
   ┌──────────┐   ~4s timer   ┌────────┐   tap badge/whisper   ┌──────────┐
   │ WHISPER  │ ────────────▶ │ PARKED │ ───────────────────▶  │  TRAY    │
   │ (banner) │   or new      │ (badge)│ ◀───────────────────  │ (sheet)  │
   └──────────┘   arrival     └────────┘   dismiss / drained   └──────────┘
        │  tap → TRAY              │
        └─────────────────────────┘
   PARKED persists while count>0; disappears at count==0 (also closes/empties TRAY).
```

- The whisper is best-effort and stateless beyond its timer; the **badge count is the source of truth**.
- `count === 0` is the single condition that tears down badge + tray.

## Key design decisions & rationale

- **Why a separate surface from `ApprovalSheet` instead of reusing it for all sessions** — the foreground session's request is a focused, full-screen decision; a background request must be glanceable and non-blocking. More importantly, keeping them separate guarantees a tray tap can only act on a *non-focused* session, removing any "which session am I approving?" ambiguity (US-4, US-6).
- **Why whisper has no inline actions** — approving from a one-line banner invites blind approvals. The banner's only job is awareness; every actionable control lives in the tray where `agent · repo · input · risk` are all visible.
- **Why edge-snapping (not free-floating)** — a 2D free bubble covers content and reads as a bug; edge-snapping keeps it tidy while still movable for handedness and to uncover obscured content. Vertical free / horizontal snap is the AssistiveTouch convention users already understand.
- **Why position persists in the store, not component state** — the badge is transient (unmounts at `count==0`); component state would reset its position every time it reappeared, which feels broken. Persisting `{side, y}` makes it "stay where I put it."
- **Why no bridge work** — the store already aggregates every session's requests and stays connected during navigation (that was the whole point of lifting it to app level, per the comment at `store.ts:230`). This effort is purely about consuming data already in memory.

## Risks & mitigations

- **R1 — Left-edge drag collides with the back-swipe gesture.** The chat pager has `gestureEnabled` on the left edge. *Mitigation:* the badge consumes its own pan gesture (gesture-handler native handler with priority), so dragging the badge never triggers back-nav; the edge-swipe still works everywhere the badge isn't.
- **R2 — Tap vs. drag misfire.** A sloppy tap could fling the badge, or a drag could register as "open tray." *Mitigation:* movement threshold (e.g. >8px = drag) before the pan takes over; below threshold on release = tap.
- **R3 — Whisper storm.** Many sessions blocking at once could spam banners. *Mitigation:* single-banner invariant — new arrivals bump the badge count only; the whisper shows the most recent and resets its timer rather than stacking.
- **R4 — Stale `y` across device rotation / different screen.** *Mitigation:* clamp stored `y` into the live safe band at render time.
- **R5 — Race: request resolved elsewhere.** Same risk the list already handles. *Mitigation:* rely on the store's `permission_resolved` handling + optimistic `removeOne`; rows are keyed by `toolUseId` so a vanished request just drops.
- **R6 — Overlay covers the composer / takeover prompt.** The chat screen already renders other overlays (takeover prompt, model picker, `ApprovalSheet`). *Mitigation:* define z-order and keep-out zones in the LLD; the tray uses the same bottom-sheet pattern as `ApprovalSheet` so only one bottom sheet is up at a time (foreground approval takes precedence).

## Open questions (resolve in LLD / plan)

- Does the app already depend on `react-native-gesture-handler` / `react-native-reanimated`, or do we add them? (Determines drag implementation; verify in plan Phase 0.)
- Tray grouping: flat list sorted by `createdAt`, or grouped by session? Lean flat + sorted for simplicity unless one session dominates.
- Should the whisper be suppressible via a setting ("don't interrupt me; just badge")? Out of scope for v1 unless trivial; note as a follow-on.
