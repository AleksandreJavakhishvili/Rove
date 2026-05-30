# Cross-Session Approvals — FRD

## Problem

A user often runs several agent sessions at once — one in the foreground chat they're focused on, others working in the background. When a background session hits a permission gate (e.g. `Bash`, `Edit`, `WebFetch`), that session **stalls until the user answers**. Today the only place to answer a background session's request is the sessions list (`mobile/app/index.tsx`), which means backing out of the chat you're focused on.

So the loop is: notice (somehow) that another session is blocked → leave the current chat → lose scroll position and any half-typed draft → find the right row → approve → navigate back. That's "jumping around," and it's friction enough that background sessions sit blocked while the user is heads-down elsewhere.

The cross-session state needed to fix this **already exists** in memory while the user is inside a chat — `usePendingPermissions` (`mobile/lib/store.ts`) is an app-level store on a bridge-wide `/events` stream that stays connected across navigation. What's missing is a surface *inside the focused chat* that lets the user act on other sessions' requests without leaving.

## Goals

1. **Awareness without interruption.** When a background session raises a permission request, the focused chat surfaces it ambiently — a brief whisper banner — without a modal that hijacks the screen or steals the user's draft/scroll.
2. **Act in place.** The user can Allow / Always / Deny a background session's request from within the focused chat. The current chat never unmounts; scroll position and composer draft are preserved.
3. **Never approve blind.** Every actionable row clearly identifies which session, repo (cwd), and tool it belongs to, plus a summary of the input and a risk cue, so the user cannot approve a destructive command thinking it belongs to a different session.
4. **Batch-friendly triage.** When several sessions are waiting, the user sees a single count and can resolve them one after another from one surface, with fast gestures.
5. **Out of the way when idle.** The persistent affordance (the badge) only exists while background requests are pending, is movable, snaps to a screen edge, and remembers where the user put it.
6. **Foreground stays foreground.** The focused session's *own* permission requests keep using the existing full-screen `ApprovalSheet`. The new surface is exclusively for *other* sessions, so there is never ambiguity about which session a tap acts on.

## Non-goals

- **Bridge changes.** This is a mobile presentation-layer effort. It consumes the existing `usePendingPermissions` store, the existing `/events` permission stream, and the existing `sendApproval` decision path. No new bridge endpoints or events.
- **Replacing the sessions-list approval chips.** The list (`index.tsx`) keeps its inline approval chips as the at-a-glance overview. This feature adds the *in-chat* surface; the two share logic but the list is unchanged behaviorally.
- **Replacing the foreground `ApprovalSheet`.** The current session's own requests are out of scope — they already have a primary surface.
- **Out-of-app push for cross-session requests.** Firing a `PushNotification` when a background session blocks while the app is closed is a natural follow-on but is a separate effort (overlaps with `2026-05-28-notification-actions`).
- **Web client parity.** Scope is the mobile (React Native) chat screen. The web client can adopt the same store-backed pattern later.
- **Android-specific gesture tuning.** The drag/snap interaction should work on both platforms via the shared gesture stack, but platform-specific polish is not gated on this effort.

## Personas

- **The juggler.** Runs 2–4 sessions across repos. Wants the others to make progress while focused on one, and resents having to leave the active chat to unblock them.
- **The cautious operator.** Will approve from anywhere *only if* they can see exactly what they're approving and for which repo. A surface that hides the command is worse than navigating manually.

## User stories

### US-1: Awareness while focused
> As a user focused in session A's chat, when background session B raises a permission request, I want a brief, non-blocking heads-up so I know B is now waiting — without losing my place in A.

Acceptance:
- A thin whisper banner slides in (not a modal), showing `agent · repo` and the tool name (e.g. `codex · myrepo wants Bash`).
- The banner does not block interaction with the chat behind it and does not capture the composer.
- A subtle haptic accompanies arrival.
- If ignored, the banner auto-dismisses after a short interval (~4s) and the request collapses into the persistent badge.
- The banner is **informational only** — it never exposes Allow/Deny inline (that would risk approving blind). Tapping it opens the tray with that request's row expanded.
- Only the foreground session is excluded; requests from *every* other session can produce a whisper. Rapid arrivals do not stack multiple banners — only the badge count climbs.

### US-2: The persistent badge
> As a user, I want a small, unobtrusive indicator showing how many background sessions are waiting, that I can move out of the way and that stays where I put it.

Acceptance:
- A floating badge shows `● N waiting` (or just the count) whenever ≥1 background session has pending requests.
- The badge is **only present while N ≥ 1**; it animates in on the first pending request and animates away when the last one resolves.
- The badge is **draggable**. On release it **snaps to the nearest left or right screen edge** at the vertical position where it was dropped (never floats mid-width).
- The badge's position (`{ side, y }`) **persists** across the badge disappearing and reappearing, and across app restarts.
- A tap (as opposed to a drag past a small threshold) opens the tray.
- The badge defaults to the **right** edge on first use.
- The badge stays clear of the header and the composer (its vertical position is clamped to the message-list area).

### US-3: Resolving from the tray
> As a user, I want to open one surface that lists every waiting background session with enough detail to decide safely, and resolve each without leaving my current chat.

Acceptance:
- Tapping the badge (or a whisper) opens a bottom-sheet **tray** that overlays the chat; the chat does **not** unmount (scroll + draft preserved on dismiss).
- Each row shows: `agent · repo (cwd)`, tool name, a one-line input summary, and a **risk cue** (color) for destructive operations (e.g. `rm -rf`, `git push --force`, `sudo`).
- Each row has inline **Allow**, **Always**, **Deny** actions.
- Each row offers an **Open** escape hatch that navigates to that session's chat for full context (this is the deliberate exception to "don't navigate" — the user chose it).
- Swipe-right on a row = Allow; swipe-left = Deny (Always remains a tapped button). Gestures are confirmable/forgiving enough to avoid accidental destructive denies.
- Resolving a request removes its row optimistically; the bridge echo confirms. The badge count decrements immediately.
- When the last request is resolved, the tray either shows an empty state and can be dismissed, or auto-dismisses; the badge disappears.
- If a request is resolved elsewhere (race: user approved via the sessions list on another device, or it timed out), the row disappears on the next stream frame without an error.

### US-4: Safety — no blind approvals
> As a cautious operator, I want it to be impossible to approve a background session's tool without seeing which session/repo and what command it is.

Acceptance:
- No Allow/Always/Deny control exists anywhere that does not also display the owning `agent · repo` and an input summary in the same view (the whisper, which has no actions, is exempt).
- High-risk operations are visually flagged in the tray row (consistent with the existing `dangerLevel` heuristic used by `ApprovalSheet`).
- The foreground session's own requests never appear in this surface — they route to `ApprovalSheet` — so a tap in the tray can only ever act on a background session.

## Success criteria

- A user focused in one chat can unblock a different session in **one or two taps** without navigating away, and return to find their scroll and draft intact.
- Zero new bridge endpoints/events.
- No regression to the sessions-list approval chips or the foreground `ApprovalSheet`.
- The badge never appears when there are no background requests, and never overlaps the composer or header.
