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
        │   subscribes: usePendingPermissions(byKey)
        │   derives: selectOthersPending(byKey, agent, id)  (excludes focused key)
        │   (ApprovalBadge subscribes to useHydratedBadgePosition() itself)
        │
        ├── <ApprovalWhisper request={latestArrival} onPress={openTray} />    (transient, top)
        ├── <ApprovalBadge count onPress={openTray} position draggable />     (persistent, edge)
        └── <ApprovalTray open requests={othersPending} onResolve onOpenSession />  (bottom sheet)
```

A **single controller component** `CrossSessionApprovals` owns the whisper → badge → tray state machine and is mounted once in the chat screen. It is the only new wiring point in `ChatScreen`.

### Component responsibilities

- **`CrossSessionApprovals` (controller).**
  - Selects `othersPending` via `selectOthersPending(byKey, agent, id)` (memoized with `useMemo` against `byKey`; excludes the focused session key). The selector lives in its own KV-free module `mobile/lib/pendingSelectors.ts` — **not** in `store.ts` — so it's unit-testable without pulling in the native KV/zustand deps; `store.ts` re-exports it for existing call sites.
  - Tracks "new arrivals" to drive the whisper: diff the incoming set against what's already been acknowledged, so re-renders don't re-whisper old requests.
  - Owns ephemeral UI state: `whisperRequest | null`, `trayOpen: boolean`. (Persistent badge position lives in the store — see below.)
  - Calls the shared `decide()` helper on resolve, which calls `sendApproval` + optimistic `removeOne`.

- **`ApprovalWhisper` (transient banner).** Pure presentational, top-anchored, auto-dismiss timer, haptic on mount, `onPress → openTray(requestId)`. No decision controls. De-dupes: at most one visible; new arrivals while one is showing just refresh the count, they don't queue banners.

- **`ApprovalBadge` (persistent, draggable).** Renders only when `count > 0`. Uses `react-native-gesture-handler` + `react-native-reanimated` (already used elsewhere in the app — verify in plan) for drag; on release, animates a snap to the nearer of the two edges and writes `{ side, y }` back to the persisted store. Tap vs. drag disambiguated by a movement threshold.

- **`ApprovalTray` (bottom sheet).** Overlays the chat without unmounting it (sibling overlay / `Modal transparent` anchored to bottom, consistent with `ApprovalSheet`'s pattern). Renders one row per pending request across all background sessions, flat-sorted by `createdAt`. Inline Allow/Always/Deny + swipe gestures + per-row "Open". Empty state when drained.
  - **`SwipeableRow` (as built).** Swipe handling lives in a `SwipeableRow` wrapper *inside* `ApprovalTray.tsx` (not a separate file): swipe right past 32% → Allow, left past 55% → Deny (deny deliberately harder), both disabled on high-risk rows and while busy. Each row is an `Animated.View` with `LinearTransition` + `FadeOut` so resolved rows animate out and the list reflows.

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

> **As built.** A standalone `useBadgePosition` zustand slice in `store.ts` (`{ hydrated, side, y, setPosition }`), persisted via `KV` under `rove:badge-position:v1` and hydrated through `useHydratedBadgePosition()`, mirroring `useHydratedPreviewPrefs`. The badge seeds its resting position in an effect once layout + hydration are ready (a stored `y` of 0 = never-dragged defaults to the bottom of the safe band) and fades in via a shared `appear` value.

### Shared helpers (de-duplication)

`summarize`/`summarizeToolInput`/`dangerLevel` exist in two places today. Extract them into one module (e.g. `mobile/lib/toolSummary.ts`) and have `ApprovalSheet`, the sessions list, and the new tray all import it. This keeps the risk heuristic and input summary identical across every approval surface — important because US-4 (no blind approvals) depends on the tray's risk cue matching what users already learned from `ApprovalSheet`. This is a small refactor bundled into the plan, not a separate effort.

Likewise the `decide()` logic (busy-set + `sendApproval` + optimistic `removeOne` + error Alert) is currently inline in `index.tsx`. Extract a `usePermissionDecision()` hook (or plain async helper) shared by the list and the tray so both resolve identically.

> **As built.** `summarizeToolInput` + `dangerLevel` → `mobile/lib/toolSummary.ts`; the decision flow → `usePermissionDecision()` in `mobile/lib/permissions.ts`. `ApprovalSheet` keeps its own *verbose* `summarize` (the multi-line args box) and now imports only the shared `dangerLevel`; the sessions list imports both shared helpers + the hook. `ownerLabel`/`repoLabel` (agent · repo from a cwd) live in `components/chat/crossSession/labels.ts`, shared by the tray and whisper.

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

- **R1 — Left-edge drag collides with the back-swipe gesture.** The chat pager has `gestureEnabled` on the left edge. *Mitigation (as built):* the badge owns its own `Gesture.Race(pan, tap)` detector with `activeOffsetX([-8, 8])`; because the touch starts on the badge, gesture-handler routes it to the badge's pan rather than the pager's back-swipe, which still works everywhere the badge isn't.
- **R2 — Tap vs. drag misfire.** A sloppy tap could fling the badge, or a drag could register as "open tray." *Mitigation:* movement threshold (e.g. >8px = drag) before the pan takes over; below threshold on release = tap.
- **R3 — Whisper storm.** Many sessions blocking at once could spam banners. *Mitigation:* single-banner invariant — new arrivals bump the badge count only; the whisper shows the most recent and resets its timer rather than stacking.
- **R4 — Stale `y` across device rotation / different screen.** *Mitigation:* clamp stored `y` into the live safe band at render time.
- **R5 — Race: request resolved elsewhere.** Same risk the list already handles. *Mitigation:* rely on the store's `permission_resolved` handling + optimistic `removeOne`; rows are keyed by `toolUseId` so a vanished request just drops.
- **R6 — Overlay covers the composer / takeover prompt.** The chat screen already renders other overlays (takeover prompt, model picker, `ApprovalSheet`). *Mitigation:* define z-order and keep-out zones in the LLD; the tray uses the same bottom-sheet pattern as `ApprovalSheet` so only one bottom sheet is up at a time (foreground approval takes precedence).

## Open questions (resolved)

- ~~Does the app already depend on `react-native-gesture-handler` / `react-native-reanimated`?~~ **Resolved:** both present (`~2.28.0` / `~4.1.1`), plus `expo-haptics` and `react-native-safe-area-context`. No new deps; the badge uses `Gesture.Race(pan, tap)` + reanimated springs, the whisper uses reanimated timing.
- ~~Tray grouping: flat vs. grouped by session?~~ **Resolved:** flat list, sorted oldest-first by `createdAt` (`selectOthersPending`).
- ~~Should the whisper be suppressible via a setting?~~ **Deferred:** out of scope for v1; tracked as a follow-on in the plan's "Out of scope" section.

## Still pending (on-device QA)

The behavioral checks in plan Phase 6 (multi-session whisper/badge, race with the sessions list, rotation `y`-clamp, and badge-position persistence across app restart) are code-complete but need a running app on a device/simulator to confirm. Static verification — `tsc`, `jest` (incl. the `selectOthersPending` suite), and `expo lint` — is green.
