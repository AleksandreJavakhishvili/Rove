# Cross-Session Approvals — Implementation Plan

Tracks the work for the in-chat cross-session approval surface. See [`frd.md`](./frd.md) and [`hla.md`](./hla.md).

**Branch:** `2026-05-30-cross-session-approvals`

## Dependency check (resolved)

Verified present in `mobile/package.json`:

- `react-native-gesture-handler` `~2.28.0` — pan gesture for the draggable badge.
- `react-native-reanimated` `~4.1.1` — snap animation + whisper slide/auto-dismiss.
- `expo-haptics` `~15.0.8` — arrival haptic.
- `react-native-safe-area-context` `~5.6.0` — safe-band clamp for badge `y`.

Persistence uses the existing `KV.setItemAsync` / `KV.getItemAsync` abstraction in `mobile/lib/store.ts` (same pattern as `PREVIEW_PREFS_KEY`). **No new dependencies required.**

---

## Phase 0 — Shared helpers refactor (no behavior change)

Pull duplicated logic into shared modules so every approval surface (list, foreground sheet, new tray) stays identical. Pure refactor; the list and `ApprovalSheet` must behave exactly as before.

- [x] Create `mobile/lib/toolSummary.ts` exporting `summarizeToolInput(tool, input)` and `dangerLevel(tool, input)` (move from `app/index.tsx:125` and `ApprovalSheet.tsx`).
- [x] Repoint `ApprovalSheet.tsx` and `app/index.tsx` at the shared module; delete the local copies.
- [x] Extract the decision flow (`busy` set + `sendApproval` + optimistic `removeOne` + error `Alert`) from `app/index.tsx` into a shared `usePermissionDecision()` hook (or `lib/permissions.ts` helper). Repoint the sessions list at it.
- [x] Typecheck + existing tests green.

**Definition of done:** No diff in sessions-list or `ApprovalSheet` behavior; `summarizeToolInput`/`dangerLevel`/decide logic each have a single definition.

## Phase 1 — Store: badge position persistence + `others` selector

- [x] Add a `useBadgePosition` slice (or extend prefs) to `mobile/lib/store.ts`: `{ side: 'left' | 'right' (default 'right'), y: number, setPosition(side, y) }`, persisted via `KV` under a new `BADGE_POSITION_KEY`, hydrated on load like the other prefs slices.
- [x] Add a memoized selector/helper `selectOthersPending(byKey, currentAgent, currentSessionId)` that flattens `byKey` excluding the focused session's key (`${agent}:${sessionId}`), sorted by `createdAt` ascending.
- [x] Unit test the selector: excludes focused session, includes all others, stable sort, empty when only the focused session is pending.

**Definition of done:** Selector covered by tests; badge position survives an app reload (manually verified).

## Phase 2 — Controller + tray (functional, no badge polish yet)

- [x] Create `mobile/components/chat/crossSession/CrossSessionApprovals.tsx` controller: subscribes to `usePendingPermissions(byKey)` via the selector, owns `whisperRequest` and `trayOpen` state, exposes `openTray(requestId?)`.
- [x] Track "new arrivals" (a ref of acknowledged `toolUseId`s) so re-renders don't re-trigger the whisper for already-seen requests.
- [x] Create `ApprovalTray.tsx`: bottom-sheet overlay (mirror `ApprovalSheet`'s `Modal transparent` + bottom anchor) that does **not** unmount the chat. One row per request: `agent · repo(cwd)`, tool, `summarizeToolInput` line, `dangerLevel` color cue, inline Allow / Always / Deny, and an "Open" link (`router.push('/sessions/<agent>/<id>')`).
- [x] Wire Allow/Always/Deny to the shared `usePermissionDecision()` hook (optimistic remove + bridge echo).
- [x] Empty state; auto-dismiss / closeable when drained.
- [x] Mount `<CrossSessionApprovals currentAgent currentSessionId />` once in `app/sessions/[agent]/[id]/index.tsx`. Confirm z-order: foreground `ApprovalSheet` takes precedence over the tray.
- [ ] Manual (needs device): with a temporary always-visible trigger, open the tray, resolve a real background request, confirm the agent unblocks and the chat's scroll/draft are untouched.

**Definition of done:** From inside session A, a pending request in session B can be resolved via the tray without leaving A; chat state preserved; row identifies session/repo/tool/risk.

## Phase 3 — Persistent badge (draggable, edge-snapping)

- [x] Create `ApprovalBadge.tsx`: renders only when `count > 0`; shows count; animates in/out (reanimated).
- [x] Pan gesture (gesture-handler) with an >8px movement threshold to disambiguate tap (→ `openTray`) from drag.
- [x] On release, snap to nearer edge; write `{ side, y }` via `setPosition`. Animate the snap (reanimated spring).
- [x] Clamp `y` into the safe band (below header / status bar, above composer) at render time using safe-area insets + measured layout.
- [x] **R1 mitigation:** ensure the badge's pan handler claims the gesture so a left-edge drag never triggers the pager back-swipe; verify the back-swipe still works elsewhere.
- [x] Default position right edge on first run. (Persistence across reappear/app-restart is code-complete via the store; on-device confirmation pending.)

**Definition of done:** Badge appears only with pending background requests, is draggable, snaps to an edge, remembers position, never blocks the back-swipe, and opens the tray on tap.

## Phase 4 — Whisper banner

- [x] Create `ApprovalWhisper.tsx`: top-anchored thin banner, slide-in (reanimated), `expo-haptics` light impact on mount, shows `agent · repo wants <tool>`, no action controls.
- [x] Auto-dismiss after ~4s; tap → `openTray(requestId)` with that row expanded/scrolled-to.
- [x] Single-banner invariant: a new arrival while one is showing resets the timer / swaps content rather than stacking; the badge count is the source of truth.
- [x] Does not capture touches on the chat/composer behind it (pointer-events scoped to the banner).

**Definition of done:** A background request produces one non-blocking whisper that parks into the badge; multiple rapid arrivals never stack banners.

## Phase 5 — Tray swipe gestures + polish

- [x] Swipe-right on a tray row = Allow; swipe-left = Deny (Always stays a tapped button). Forgiving thresholds; no accidental destructive deny (e.g. require fuller swipe for deny, or a brief confirm on high-`dangerLevel` rows).
- [x] Animate row removal on resolve; smooth count decrement; badge teardown when last resolves.
- [x] Accessibility: actions reachable without gestures (buttons remain); badge has an a11y label with the count.

**Definition of done:** Triage of multiple stacked requests is fast via swipe, with no accidental destructive action, and fully operable without gestures.

## Phase 6 — Verification & docs

Static verification done across every phase: `tsc --noEmit` clean, `jest` 67/67
(incl. 5 new selector tests), `expo lint` clean for all new files. The
behavioral checks below need a running app on a device/simulator and are left
for on-device QA before merge.

- [ ] Manual multi-session test (needs device): 3 background sessions blocking simultaneously → one whisper, badge `3`, resolve all from tray, badge disappears, all three agents unblock.
- [ ] Race test (needs device): resolve a request from the sessions list (or second device) while its row is in the tray → row drops cleanly, no error.
- [x] Regression (code-level): sessions-list chips and foreground `ApprovalSheet` are behavior-preserving — only repointed at shared helpers; typecheck + tests + lint green.
- [ ] Rotation/different-screen test (needs device): stored `y` clamps into the safe band.
- [x] Update `docs/ARCHITECTURE.md` to note the new in-chat approval surface.
- [x] Tick remaining boxes; open PR referencing this SDD directory.

---

## Out of scope (tracked elsewhere / follow-on)

- Out-of-app push when a background session blocks while the app is closed — overlaps `2026-05-28-notification-actions`; separate effort.
- A setting to suppress the whisper ("badge only, never interrupt") — note as follow-on if requested.
- Web-client parity — same store-backed pattern can be adopted later.

## Definition of done (overall)

- A user focused in one chat can unblock another session in one or two taps without navigating away, returning to intact scroll + draft.
- No new bridge endpoints/events; only a persisted badge-position UI pref added to the store.
- No regression to the sessions-list chips or foreground `ApprovalSheet`.
- Badge present only when background requests exist; never overlaps composer/header; never blocks the back-swipe.
