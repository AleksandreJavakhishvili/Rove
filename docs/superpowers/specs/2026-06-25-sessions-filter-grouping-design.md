# Sessions Filter & Grouping Design

**Date:** 2026-06-25  
**Features:** Session Filters (Feature 1) · View Toggle (Feature 2)  
**Worktrees:** `feat/session-filters`, `feat/session-view-toggle`

---

## Overview

Two independent enhancements to the Sessions sidebar in the Rove mobile app:

1. **Session Filters** — a persistent filter system that hides unwanted sessions from the list, configurable via a bottom sheet, with support for multiple simultaneous filters across several dimensions.
2. **View Toggle** — a header icon that switches the list between three presentation modes: flat (default), grouped by repo alphabetically, and grouped by repo sorted by most recent activity.

Both features compose: filters run first to produce the visible set, then view mode determines how that set is rendered. Both persist their state to AsyncStorage.

---

## Architecture

### New files

```
mobile/
  hooks/
    useSessionFilters.ts    — filter state, AsyncStorage persistence, apply() function
    useViewMode.ts          — view mode state + AsyncStorage persistence
  components/
    SessionFilterSheet.tsx  — bottom sheet UI for configuring filters
    SessionsGroupedList.tsx — SectionList renderer for grouped views (modes 2 & 3)
```

`SessionsSidebar.tsx` is modified to wire in both hooks and conditionally render `FlatList` (view 1) or `SessionsGroupedList` (views 2 & 3).

### Worktree strategy

| Branch | Worktree path | Primary files |
|---|---|---|
| `feat/session-filters` | `../Rove-filters` | `useSessionFilters.ts`, `SessionFilterSheet.tsx`, `SessionsSidebar.tsx` (filter wiring) |
| `feat/session-view-toggle` | `../Rove-view-toggle` | `useViewMode.ts`, `SessionsGroupedList.tsx`, `SessionsSidebar.tsx` (toggle wiring) |

Both branches diverge from `main`. Merge order: **filters first**, then view toggle — the second merge conflict in `SessionsSidebar.tsx` is straightforward since the two features touch different parts of the file (header buttons and list renderer respectively).

---

## Feature 1: Session Filters

### Data model

```ts
type FilterSpec =
  | { kind: 'status';  value: 'live-bridge' | 'live-desktop' | 'idle' }
  | { kind: 'repo';    value: string }   // exact match on session.projectName
  | { kind: 'machine'; value: string }   // exact match on session.bridgeId
  | { kind: 'age';     value: number }   // hide sessions older than N days
  | { kind: 'agent';   value: AgentKind }
  | { kind: 'name';    value: string }   // case-insensitive substring on (label ?? projectName)
  | { kind: 'preset';  value: 'observers' | 'subagents' }
```

### Filter logic

A session is **hidden** if it matches *any* active `FilterSpec`. Multiple specs are evaluated independently — a session must pass all of them to remain visible. This is effectively: show session if `!filters.some(f => matches(session, f))`.

**Preset pattern matching** (for `kind: 'preset'`):
- `'observers'` — title matches `/\bobserver\b/i`
- `'subagents'` — title matches `/\b(subagent|sub-agent|sub agent|\(sub\))\b/i`

Title is `session.label ?? session.projectName`.

### Persistence

Key: `@rove/session-filters`  
Storage: AsyncStorage (JSON array of `FilterSpec`)  
Loaded on mount in `useSessionFilters`, written on every change.

### `useSessionFilters` hook API

```ts
interface UseSessionFiltersReturn {
  filters: FilterSpec[];
  addFilter(spec: FilterSpec): void;
  removeFilter(index: number): void;
  clearFilters(): void;
  applyFilters(sessions: TaggedSession[]): TaggedSession[];
}
```

### Header indicator

The filter icon in the sidebar header uses:
- `funnel-outline` (Ionicons) when no filters are active
- `funnel` (filled) + a small numeric badge when ≥1 filter is active

Badge shows the count of active `FilterSpec` entries.

### Filter Sheet UI

Bottom sheet modal. Sections rendered in order:

| Section | Control |
|---|---|
| **Presets** | Two toggle rows: "Hide observer sessions", "Hide subagents" |
| **Status** | Three toggle rows: Hide idle / Hide live (bridge) / Hide live (desktop) |
| **Age** | Segmented selector: Any · 7d · 14d · 30d · 90d (hides sessions older than selection) |
| **Name contains** | Text input — hides sessions whose displayed title contains the string (case-insensitive) |
| **Repo / Project** | Scrollable checklist of all distinct `projectName` values in current sessions |
| **Machine** | Checklist of current bridges — shown only when >1 machine is present |
| **Agent type** | Checklist of agent kinds present in current sessions |

Footer: **"Clear all"** link (left) + **"Done"** button (right, closes sheet).

Filters apply **live** as toggles change — no separate Apply step. The list behind the sheet updates in real time through the scrim.

---

## Feature 2: View Toggle

### Data model

```ts
type ViewMode = 'flat' | 'grouped-alpha' | 'grouped-recency'
```

### Persistence

Key: `@rove/session-view-mode`  
Storage: AsyncStorage  
Default: `'flat'`

### `useViewMode` hook API

```ts
interface UseViewModeReturn {
  viewMode: ViewMode;
  setViewMode(mode: ViewMode): void;
}
```

### Header control

A layout icon button in the header (left of the existing expand icon) using `Ionicons`:
- `list-outline` — flat mode active
- `albums-outline` — either grouped mode active

Tapping opens an action sheet (iOS `ActionSheetIOS` / custom bottom menu on Android) with three labeled rows:

```
✓  Flat list            (chronological, default)
   Group by repo        (repos A → Z, sessions by recency)
   Recent repos first   (repos by latest activity, sessions by recency)
```

The active mode has a checkmark. Tapping a row applies the mode and dismisses.

### `SessionsGroupedList` component

Used for `grouped-alpha` and `grouped-recency`. Renders a React Native `SectionList`.

**Section building** (from the filtered session list):
1. Group sessions by `projectName`
2. For each group, compute `maxLastModified = Math.max(...sessions.map(s => s.lastModified))`
3. Sort sections:
   - `grouped-alpha`: alphabetically by `projectName` (case-insensitive)
   - `grouped-recency`: by `maxLastModified` descending (most recently active repo first)
4. Sort sessions within each section by `lastModified` descending

**Section header** renders:
- Repo name (`text.secondary`, semibold)
- Session count (`text.muted`, right-aligned)
- Background: `surface.raised`
- Bottom border: `border.subtle`

**Session rows** are identical to the existing flat-list rows — same JSX, same styles, no duplication. Extract the row render function from `SessionsSidebar` into a shared `SessionRow` component during this work.

---

## Composition

The data flow through the sidebar on each render:

```
byBridge (aggregator)
  → scoped by machine chip (existing)
  → applyFilters()           ← Feature 1
  → buildSections() or sort  ← Feature 2
  → FlatList / SectionList
```

---

## Error handling & edge cases

- **No sessions after filtering**: show the existing "No sessions." empty state (same copy).
- **Async storage failure**: log error, start with empty filters / default view mode — never crash.
- **Unknown projectName**: treat as a valid group name; blank `projectName` rendered as "Unknown".
- **Filter sheet with 0 sessions visible**: sheet stays openable so you can remove filters.

---

## Out of scope

- Saving named filter presets
- Per-filter negation (e.g. "show *only* idle" rather than "hide idle")
- Sorting within the flat view (always recency-sorted, same as today)
- Any changes to the bridge/aggregator layer
