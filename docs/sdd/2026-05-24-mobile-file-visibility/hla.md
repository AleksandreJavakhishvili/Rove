# High-Level Architecture — Mobile File Visibility

Reference: [frd.md](./frd.md), [plan.md](./plan.md).

## Context

This effort extends the existing bridge ↔ mobile contract to give the
phone first-class visibility into the agent's working directory: file
tree, file content (highlighted), per-file diffs (session + git
working-tree), file search, and `@`-mentions in the chat input. It
also adds two existing-but-now-richer surfaces: inline diffs on tool
cards, and a per-turn / since-last-seen diff.

It does **not** introduce a new agent, a new transport, or any new
auth surfaces. Every new endpoint reuses the existing bearer-token /
Tailscale-identity-header chain and the existing per-session route
prefix.

The work sits on top of the SDK driver migration (see
`docs/sdd/2026-05-21-sdk-driver-migration/`) — specifically on the
capability-negotiation pattern. Every new feature is gated on a
capability that the current Claude Code SDK driver reports `true` for
and that a future Codex/Aider driver may report `false` for without
breaking anything.

## Architectural pillars

1. **Capabilities first.** Three new boolean capabilities
   (`projectBrowser`, `projectSearch`, `gitStatus`) added to
   `AgentCapabilities`. The bridge rejects requests when the capability
   is missing; the mobile hides the UI when the capability is missing.
2. **HTTP for read-only data, WS for live state.** The new file-tree,
   search, git-status, and per-file-diff endpoints are plain HTTP GET —
   no new wire frames on the WebSocket. The live `file_changed` event
   (already wired) continues to invalidate stale state on the mobile
   side.
3. **One inline-diff component, used everywhere.** The Edit / Write /
   MultiEdit tool cards and the per-file diff route all render through
   the same `<InlineDiff>` component. Same data model, same styling,
   no drift.
4. **The Files tab is a third page in the existing pager**, not a new
   route. The chat container's "I have N visible pages" model stays;
   only the page count changes.
5. **Web-first for surfaces the user touches a lot.** The `@`-picker,
   file viewer, and search must feel right with mouse + keyboard, not
   just touch. Where a primitive needs a `.web.tsx` shim it's called
   out below.

## Target topology

```
                 ┌──────────────────────────────────────┐
                 │ mobile (Expo RN + react-native-web)  │
                 │                                      │
                 │ ChatPreviewPager → Chat|Files|Preview│
                 │                                      │
                 │ chat input                           │
                 │  └── <MentionPicker> (overlay)       │
                 │                                      │
                 │ chat list (existing)                 │
                 │  ├── tool cards                      │
                 │  │   └── <InlineDiff>  ← NEW shared  │
                 │  └── "📂 N changed" pane → per-file  │
                 │                                      │
                 │ Files tab                            │
                 │  ├── search bar  → /search           │
                 │  ├── git status section → /git/status│
                 │  ├── session changes (live)          │
                 │  └── project tree → /tree            │
                 │                                      │
                 │ /diff route — extended:              │
                 │   no path → cumulative (today)       │
                 │   ?path=  → single file              │
                 │   ?since= → range                    │
                 │                                      │
                 │ /file route — extended:              │
                 │   syntax-highlighted by extension    │
                 │   ?line=N scroll-to + highlight      │
                 └──────────┬───────────────────────────┘
                            │ HTTP + WS
                            ▼
       ┌──────────────────────────────────────────────────┐
       │ bridge (Hono + node-ws)                          │
       │                                                  │
       │ Existing routes (unchanged shape):               │
       │   /sessions/:a/:id/history                       │
       │   /sessions/:a/:id/file?path=  (existing)        │
       │   /sessions/:a/:id/diff        (extended)        │
       │   /sessions/:a/:id/fork, /interrupt, ...         │
       │   WS /sessions/:a/:id/stream                     │
       │                                                  │
       │ NEW routes (this SDD):                           │
       │   /sessions/:a/:id/tree?path=&depth=             │
       │   /sessions/:a/:id/search?q=&limit=&regex=       │
       │   /sessions/:a/:id/git/status                    │
       │   /sessions/:a/:id/git/diff?path=&staged=        │
       │                                                  │
       │ Capability gates:                                │
       │   projectBrowser → /tree                         │
       │   projectSearch  → /search                       │
       │   gitStatus      → /git/status, /git/diff        │
       │                                                  │
       │ agents/                                          │
       │  └── claudeCodeSdk.ts                            │
       │      └── capabilities() now also reports         │
       │          projectBrowser/projectSearch/gitStatus  │
       │          (cwd-scoped, all true)                  │
       │                                                  │
       │ NEW helpers (new files):                         │
       │  ├── git.ts (extended) — runGitStatus,           │
       │  │                       runGitDiffFile          │
       │  ├── fileTree.ts — listDirectory(cwd, path,      │
       │  │                  depth, opts) honoring        │
       │  │                  .gitignore + skip list       │
       │  └── search.ts — ripgrep / grep fallback         │
       └──────────────────────────────────────────────────┘
```

Nothing existing is replaced; everything is additive. The two
endpoints that *change* shape (`/diff` and `/file`) do so in a
backward-compatible way (new optional query params).

## Components

### Bridge — capability fields (`bridge/src/agents/types.ts`)

```ts
interface AgentCapabilities {
  // existing fields…
  permissionPrompts: boolean;
  permissionModes: readonly PermissionMode[] | null;
  modelSelection: { current: string; available: readonly string[] } | null;
  fileCheckpointing: boolean;
  sessionForking: boolean;
  interrupt: boolean;
  nativeFileChanges?: boolean;

  // NEW (this SDD):
  /** /tree endpoint supported. */
  projectBrowser?: boolean;
  /** /search endpoint supported. */
  projectSearch?: boolean;
  /** /git/status and /git/diff endpoints supported. */
  gitStatus?: boolean;
}
```

All three default to `false` for any driver that doesn't override
(important: existing capability serialization is conservative — missing
= absent, not present).

The Claude Code SDK driver reports `projectBrowser: true,
projectSearch: true, gitStatus: true` (gated on `cwd` existing on
disk; if it doesn't, drop to `false` per-cap rather than failing the
whole capability payload).

### Bridge — `fileTree.ts` (new)

```ts
interface TreeEntry {
  name: string;          // basename
  path: string;          // relative to cwd, posix slashes
  kind: 'file' | 'dir' | 'symlink';
  size?: number;
  modifiedMs?: number;
  gitIgnored?: boolean;
  hidden?: boolean;      // leading-dot, surfaced for client toggle
}

interface ListDirectoryOpts {
  path?: string;         // relative to cwd, default ''
  depth?: number;        // default 1
  includeHidden?: boolean;
  includeIgnored?: boolean;
}

async function listDirectory(
  cwd: string,
  opts: ListDirectoryOpts,
): Promise<{ root: string; entries: TreeEntry[] }>;
```

Implementation notes:

- `path` is resolved against `cwd` using the same scoping logic as
  `readScopedFile` — reject any `..` escape, reject symlinks that
  resolve outside cwd.
- Skip list is a hardcoded set (`node_modules`, `.git`, `dist`,
  `build`, `.next`, `.expo`, `.venv`, `__pycache__`, `.cache`).
  Items in the skip list are excluded from the result regardless of
  `includeIgnored`.
- `.gitignore` honored by shelling out to `git check-ignore --stdin`
  in batches (one fork per directory, not one per file). If the cwd
  isn't a git repo, all entries get `gitIgnored: false`.
- `depth=N` flattens — every entry up to N levels deep is returned as
  a flat list with full relative paths. Cap at `depth=4` to bound the
  response size.

### Bridge — `git.ts` extensions

The existing `bridge/src/git.ts` has `getHeadSha`; extend with:

```ts
interface GitStatusEntry {
  path: string;
  renamedFrom?: string;
  indexStatus: GitFileStatus;     // 'unmodified' | 'modified' | 'added' | ...
  worktreeStatus: GitFileStatus;
  isUntracked: boolean;
  isIgnored: boolean;
}

interface GitStatusResult {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
  isRepo: boolean;
}

async function runGitStatus(cwd: string): Promise<GitStatusResult>;

interface GitDiffFileOpts {
  path: string;
  staged: boolean;
}

async function runGitDiffFile(cwd: string, opts: GitDiffFileOpts): Promise<DiffFile>;
```

Implementation:

- `runGitStatus` shells out to `git status --porcelain=v2 --branch -z`
  and parses the documented v2 format. NUL-terminated for safe path
  handling. Returns `{ isRepo: false }` (with sensible empty fields)
  when `cwd` isn't a git working tree.
- `runGitDiffFile` shells out to `git diff [--cached] -- <path>` and
  reuses the existing diff-parsing helper (already used by
  `/sessions/:a/:id/diff`). Returns a single `DiffFile`.

We do **not** parse diff output ourselves — we reuse whatever the
existing `git.ts` cumulative-diff path already does. (The current
`/diff` endpoint already calls into a diff-parsing routine; extract it
to a function if needed.)

### Bridge — `search.ts` (new)

```ts
interface SearchHit {
  path: string;
  line: number;
  column: number;
  preview: string;
  matchStart: number;
  matchEnd: number;
}

interface SearchOpts {
  query: string;
  limit: number;          // 1–500, default 100
  regex?: boolean;
}

async function search(cwd: string, opts: SearchOpts): Promise<SearchHit[]>;
```

- Detects `rg` on `PATH` at module-load time; falls back to
  `grep -RHn` (POSIX) otherwise. Fallback logged once on boot so the
  operator notices.
- ripgrep flags: `--json --max-count=<limit> --max-filesize=2M`. Skip
  list and gitignore are ripgrep's defaults.
- `regex=false` adds `--fixed-strings`. `regex=true` uses default
  (PCRE-lite) regex syntax.
- The grep fallback loses regex flag fidelity (becomes POSIX BRE) and
  the `--max-filesize` guard; this is fine — the fallback is for
  bare-metal environments that don't have rg, not the recommended path.

### Bridge — server route additions (`bridge/src/server.ts`)

```ts
// Per-file tree
app.get('/sessions/:agent/:id/tree', async (c) => {
  const session = await runtime.getOrCreate(agent, id);
  if (!session.capabilities().projectBrowser) return c.json({ error: 'unsupported' }, 404);
  const { path, depth, includeHidden, includeIgnored } = parseTreeQuery(c.req);
  return c.json(await listDirectory(session.cwd, { path, depth, includeHidden, includeIgnored }));
});

// Search
app.get('/sessions/:agent/:id/search', async (c) => {
  const session = await runtime.getOrCreate(agent, id);
  if (!session.capabilities().projectSearch) return c.json({ error: 'unsupported' }, 404);
  const { q, limit, regex } = parseSearchQuery(c.req);
  return c.json({ hits: await search(session.cwd, { query: q, limit, regex }) });
});

// Git status
app.get('/sessions/:agent/:id/git/status', async (c) => {
  const session = await runtime.getOrCreate(agent, id);
  if (!session.capabilities().gitStatus) return c.json({ error: 'unsupported' }, 404);
  return c.json(await runGitStatus(session.cwd));
});

// Git per-file diff
app.get('/sessions/:agent/:id/git/diff', async (c) => {
  const session = await runtime.getOrCreate(agent, id);
  if (!session.capabilities().gitStatus) return c.json({ error: 'unsupported' }, 404);
  const { path, staged } = parseGitDiffQuery(c.req);
  return c.json(await runGitDiffFile(session.cwd, { path, staged }));
});

// Existing /diff — adds optional `path=` and `since=`
app.get('/sessions/:agent/:id/diff', async (c) => {
  // ... existing path …
  // NEW: if path query present, filter result to that single file.
  // NEW: if since query present, filter result to files modified after.
});
```

All capability checks happen at the route boundary; the helpers
themselves don't know about capabilities. A misbehaving / outdated
client that calls `/tree` against a session whose driver doesn't
support it gets a clean 404 with a typed error body.

### Bridge — wire-frame constants

New constants in `bridge/src/agents/types.ts`, mirrored in
`mobile/lib/types.ts`. Examples:

```ts
export type GitFileStatus =
  | 'unmodified' | 'modified' | 'added' | 'deleted'
  | 'renamed'    | 'copied'   | 'untracked' | 'ignored';
export const GIT_FILE_STATUS = {
  unmodified: 'unmodified',
  modified:   'modified',
  added:      'added',
  deleted:    'deleted',
  renamed:    'renamed',
  copied:     'copied',
  untracked:  'untracked',
  ignored:    'ignored',
} as const satisfies Record<GitFileStatus, GitFileStatus>;

export type TreeEntryKind = 'file' | 'dir' | 'symlink';
export const TREE_ENTRY_KIND = { /* ditto */ } as const;
```

No magic strings in any of the new endpoints, parsers, or UI.

### Mobile — `<MentionPicker>` (new)

`mobile/components/chat/MentionPicker.tsx` (with `.web.tsx` shim if
needed). A floating overlay anchored above the chat input row.

```ts
interface MentionPickerProps {
  draft: string;
  caret: number;
  agent: AgentKind;
  sessionId: string;
  onPick: (path: string, replaceRange: { start: number; end: number }) => void;
  onDismiss: () => void;
}
```

Implementation outline:

- Detects whether the caret is inside an `@…` token (regex on the chars
  to the left of the caret stopping at whitespace).
- Fetches `/tree?depth=4` on first open per session, caches client-side
  for ~30 s, then filters in JS. Refresh on `file_changed` event.
- Renders a scrollable list of `{ path, basename }` rows, ranked:
  basename-prefix matches first, then path-substring matches.
- Returns up to ~30 results; if no match, shows "No matching files."
- On pick: inserts the path with leading `@`, replaces the partial
  `@…` token in the draft using `replaceRange`.

Gated on `caps.projectBrowser` — if false, the picker never mounts.
The `@` character still types literally.

### Mobile — `<InlineDiff>` (new, shared)

`mobile/components/chat/InlineDiff.tsx`. Used by:

- `Edit`, `Write`, `MultiEdit`, `NotebookEdit` cards in
  `mobile/components/chat/cardPacks/claudeCode.tsx`.
- The per-file diff route (which becomes a thin wrapper that calls
  `/diff?path=<x>` and renders an `<InlineDiff>` per file — even though
  per-file mode has exactly one).

Props:

```ts
interface InlineDiffProps {
  agent: AgentKind;
  sessionId: string;
  path: string;
  /** When true, render a compact preview (≤30 visible lines). */
  collapsed?: boolean;
  /** When provided, render this exact diff without fetching. Used by
   *  the per-file diff route to avoid double-fetch. */
  prefetched?: DiffFile;
}
```

- Fetches `/diff?path=<path>` lazily on mount when `prefetched` is
  absent.
- Renders hunks the same way today's `Diff.tsx` does (green/red rows,
  hunk headers). Picks the first ~30 visible lines when `collapsed`.
- Tap → toggles collapsed state. Long-press (mobile) /
  context-menu-equivalent (web) → navigates to
  `/sessions/[a]/[id]/file?path=…`.
- "Show in chat" backlink button uses the file → toolUseId index
  (see FR-9 / Mobile cross-references below).

### Mobile — Files tab (new)

`mobile/app/sessions/[agent]/[id]/files.tsx` doesn't exist as a
separate route — the Files tab is rendered inline as a pager page,
not a navigation destination. Lives as a component:
`mobile/components/files/FilesPane.tsx`.

`ChatPreviewPager` is extended to accept three pages instead of two.
Today:

```ts
<ChatPreviewPager
  chat={chatBody}
  preview={(active) => <PreviewPane agent={agent} id={id} active={active} />}
  onIndexChange={setPagerIndex}
/>
```

Becomes:

```ts
<ChatPreviewPager
  chat={chatBody}
  files={(active) => <FilesPane agent={agent} id={id} active={active} />}
  preview={(active) => <PreviewPane agent={agent} id={id} active={active} />}
  onIndexChange={setPagerIndex}
/>
```

The pager renders only the pages it was given a renderer for; if
`files` is null (because `caps.gitStatus && caps.projectBrowser` are
both false), the pager stays two-wide.

`FilesPane` renders, in vertical order:

```
┌────────────────────────────────────┐
│  [ search files… ]   ⌕             │ ← FR-6
├────────────────────────────────────┤
│ ▾ Git working tree         (M3 U1) │ ← FR-4
│   M  src/foo.ts                    │
│   U  scripts/wip.sh                │
├────────────────────────────────────┤
│ ▾ Changed this session         (3) │ ← live, today's pane
│   A  src/new.ts                    │
│   M  src/foo.ts                    │
├────────────────────────────────────┤
│ ▾ Project tree                     │ ← FR-5
│   src/                             │
│   docs/                            │
│   …                                │
└────────────────────────────────────┘
```

Each section is collapsible and individually capability-gated. Search
results render in-place (replacing the three sections) when there's an
active search query.

### Mobile — `/diff` route update

`mobile/app/sessions/[agent]/[id]/diff.tsx` reads the existing
`agent` / `id` params plus new optional `path` and `since` query
params. When either is set, it requests the filtered diff and renders
in "focused" mode — single-file mode auto-expands, since-mode shows the
range banner at the top ("3 files changed since 14:32").

### Mobile — `/file` route update

`mobile/app/sessions/[agent]/[id]/file.tsx` swaps its plain-text
renderer for a `<SyntaxHighlightedCode>` component (new), which:

- Resolves the extension via `pathToLanguage()` (a small map: `.ts` →
  `typescript`, `.py` → `python`, etc.).
- Renders an image with `<Image>` (native) / `<img>` (web) for
  image extensions.
- Renders the "preview not supported" surface for everything else.
- Highlighter library choice deferred to Phase 6 LLD (see [Tech
  stack](#tech-stack)).

Also accepts a new optional `line` query parameter and scrolls/
highlights that line on mount.

### Mobile — capability slice extension

`useSessionCapabilities(agent, sessionId)` already returns the full
`AgentCapabilities` payload. No changes needed beyond mobile
mirroring the new fields in `mobile/lib/types.ts`. Components read
`caps.projectBrowser`, `caps.projectSearch`, `caps.gitStatus`.

### Mobile — `file → toolUseId` index

A new per-session ref in the chat container (`mobile/app/sessions/
[agent]/[id]/index.tsx`):

```ts
const fileToToolUseIds = useRef<Map<string, string[]>>(new Map());
```

Populated when a `tool_use` AgentEvent comes through with a known
file-touching tool name (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`)
and an `input.file_path`. The "Show in chat" button on the file viewer
and inline diff calls back with the latest `toolUseId` for the path;
the chat container scrolls to the corresponding chat item.

Backlink survives navigation — the chat container's state is preserved
by `expo-router` because Files / File / Diff are pushed routes, not
replacements.

### Mobile — `lastSeenAt` cursor (FR-9)

Per-session value, persisted via the existing `kv-store` shim under
`session.<agent>.<id>.lastSeenAt`. Updated when the chat page
foregrounds (AppState 'active' transition + initial mount). Read on
chat mount: if there have been `file_changed` events with timestamps
after the cursor, render the "What's changed since you were last here?"
chip.

The chip's destination uses `/diff?since=<iso>`.

## Data flows

### `@`-mention insertion

```
1. User types @ in the chat input.
2. MentionPicker detects an `@…` token at the caret.
3. Picker ensures the tree cache is populated for this session (fetches
   /tree?depth=4 lazily; cached for ~30s, invalidated by file_changed).
4. As the user types more characters, the picker filters the cached
   list client-side and ranks results (basename-prefix > substring).
5. User taps a result.
6. Picker calls onPick(path, replaceRange); the draft becomes
   "… @path/to/file.ts cursor …".
7. User sends. The agent receives "… @path/to/file.ts …" as a literal
   user message; Claude Code's CLI semantics read the file inline.
```

### Per-file diff from the changed-files pane

```
1. User taps a row in "📂 N files changed" pane.
2. router.push(`/sessions/${agent}/${id}/diff?path=${encoded}`)
3. Diff screen reads the `path` query, fetches /diff?path=…
4. Server short-circuits: runs git diff (or session diff) for that one
   file only, returns a one-element DiffFile[].
5. Screen renders <InlineDiff prefetched={diffFiles[0]} collapsed={false} />.
```

### Inline diff on an Edit tool card

```
1. tool_use AgentEvent arrives → Edit card mounts.
2. Card reads input.file_path, mounts <InlineDiff path={file_path}
   collapsed={true} />.
3. <InlineDiff> fetches /diff?path=… on first render (debounced ~150ms
   to coalesce a burst of MultiEdit tool_uses).
4. Bridge returns the cumulative-session DiffFile for that path
   (this is the diff vs the session's baseline SHA, same as /diff
   shows today — just filtered to one file).
5. Card renders the green/red preview. Tap → expand. Long-press →
   navigate to the file viewer.
6. On subsequent file_changed events for the same path, the inline
   diff refetches.
```

### Git working-tree view

```
1. User swipes to Files tab.
2. FilesPane mounts; if caps.gitStatus, fetches /git/status.
3. Renders the entries grouped (Staged / Modified / Untracked).
4. Tap a row → navigate to the file viewer or per-file diff (UX picks
   diff for modified/staged, file viewer for untracked).
5. Per-file diff route fetches /git/diff?path=…&staged=…
```

### Project file tree

```
1. User swipes to Files tab, expands "Project tree" section.
2. FilesPane fetches /tree?path=&depth=1 (cwd children only).
3. Renders entries. Tap dir → fetch /tree?path=<subdir>&depth=1 (lazy).
4. Tap file → /sessions/:a/:id/file?path=<rel>
```

### File search

```
1. User types in the Files tab search bar, taps "Search" (no
   debounce — explicit submit).
2. FilesPane fetches /search?q=…&limit=100
3. Renders results { path, line, preview } in-place.
4. Tap → /sessions/:a/:id/file?path=<rel>&line=<n>
5. File viewer scrolls to + highlights line n on mount.
```

### Since-last-seen diff

```
1. User backgrounds the app (or navigates away from chat).
2. On chat foreground, AppState 'active' handler reads `lastSeenAt`
   from kv-store and queries the local file_changed ring-buffer:
   any timestamps > lastSeenAt?
3. If yes, render the "since last here" chip with the count of files
   changed.
4. Tap chip → router.push(`/diff?since=<lastSeenAt-iso>`)
5. Update lastSeenAt to now.
6. Diff screen calls /diff?since=… → server returns only the per-file
   DiffFiles for files modified after that timestamp.
```

## Tech stack

- Node 22 (existing) + Hono (existing) + node-ws (existing).
- New shell-outs: `git` (already present for the cumulative diff and
  `getHeadSha`), `rg` (preferred) with `grep -RHn` fallback. Both
  must be on `PATH` for the matching capabilities to enable.
- Expo SDK 54 + react-native-web (existing).
- Syntax highlighter — **decision deferred to Phase 6 LLD.** Leaning
  candidates:
  - **`react-native-syntax-highlighter`** (Prism backend) — single
    package for native + web, but Prism grammars are not great at
    tree-shaking; risk of inflating the web bundle by >150 KB.
  - **`shiki` (web) + a regex tokenizer (native)** — shiki has better
    output and proper tree-shaking, but the API is async and
    web-only. Would need a `.web.tsx` for the highlight path.
  - **A tiny regex-based tokenizer for the top 10 extensions** — zero
    runtime deps, native + web parity, lower fidelity.
  - The plan requires the LLD to ship with a bundle-size measurement
    against the web build before committing.

## Compatibility

- All new HTTP endpoints reject with `404 { error: 'unsupported' }`
  when the corresponding capability is missing. Old mobile clients
  that don't know about the new routes simply never call them; new
  mobile clients that hit a missing capability degrade gracefully (UI
  surface hidden) rather than erroring.
- `/diff` and `/file` remain backward compatible: requests with no new
  query params behave exactly as today.
- No new wire frames on the WebSocket. The existing `file_changed`
  event is the only thing the mobile uses to invalidate cached file
  tree / diff state.
- No new permissions on the bridge process — only filesystem-level
  reads under cwd + `git` / `rg` shell-outs, all of which the bridge
  could already do via the existing `/diff` and `/file` endpoints.

## Risks

- **R1 — Syntax highlighter bundle bloat on web.** The web build is
  currently ~530 KB gzipped against a 6 MB FRD budget. A naive Prism
  import can add >150 KB. Mitigation: LLD with bundle measurement
  before merge; ship with a curated grammar subset rather than
  importing all languages.
- **R2 — ripgrep absence on operator machines.** Most dev machines
  have it; some bare-VPS / minimal-Linux installs don't. Mitigation:
  `grep` fallback + boot-time log so operators notice.
- **R3 — Diff fetch storms.** A MultiEdit that touches 20 files would
  spawn 20 inline-diff fetches if naively wired. Mitigation: per-path
  in-flight dedup in `<InlineDiff>` + 150 ms debounce on mount + LRU
  client cache keyed by `(path, headSha)` so quick re-renders are
  free.
- **R4 — Git status latency on huge repos.** `git status` on a 1 GB
  monorepo can take seconds. Mitigation: cap response with a
  `git status --porcelain=v2 --branch -z` (already fastest format),
  set a 3 s server-side timeout that returns a partial response with
  an `incomplete: true` flag rather than blocking the UI.
- **R5 — Symlink escapes.** A `tree?path=` that resolves through a
  symlink outside cwd is a sandbox escape. Mitigation: realpath check
  on every resolved entry against cwd's realpath, reject any escape
  with `400`. Symlinks rooted inside cwd are fine and surfaced as
  `kind: 'symlink'`.
- **R6 — Files tab pager interaction.** Adding a third page might
  conflict with the existing "swipe left for preview" muscle memory.
  Mitigation: Files lands at index 1 (between Chat and Preview);
  pager dots make the count obvious; LLD in Phase 4 confirms layout.
- **R7 — `@`-mention picker over the keyboard on iOS.** The picker
  must not be hidden behind the software keyboard. Mitigation: anchor
  to `KeyboardAvoidingView`'s top edge; same pattern as
  `ApprovalSheet`.
- **R8 — Web mixed-content for image preview.** If the bridge serves
  raw bytes for `/file?path=image.png` and the page is HTTPS but the
  bridge is HTTP, the image won't render. Mitigation: same mixed-
  content message we already surface for the WS / fetch paths,
  centralized in `lib/bridge.ts`.
- **R9 — Capability drift.** If a future Codex/Aider driver reports
  `projectBrowser: true` but its `cwd` isn't a useful filesystem path,
  the UI shows a broken tree. Mitigation: capability docs in
  `bridge/src/agents/types.ts` make the cwd-rooted contract explicit;
  it's up to each driver to report honestly.
- **R10 — Per-turn diff vs per-message diff ambiguity.** "Since I last
  looked" depends on whether you mean "since the last message I sent"
  or "since the app went background." Mitigation: Phase 8 LLD picks
  one and documents it; if both are wanted, add a toggle.

## Decision log

- **HTTP, not WS, for the new endpoints.** The data is request/
  response (tree, search, status, diff). WS would force us to invent a
  request-id channel; HTTP gives us caching, retries, and dev-tools
  inspection for free.
- **One `<InlineDiff>` for everything.** Two components ("the small
  one in cards" and "the big one in the route") would drift in styling
  and behavior within a release. The same component just takes a
  `collapsed` prop.
- **Files tab as a pager page, not a route.** The chat ↔ preview muscle
  memory is already in users' fingers; pushing routes would lose chat
  context (scroll position, draft, live tickers). Pager pages preserve
  everything for free.
- **Picker corpus from `/tree`, not `/search`.** `/search` is for
  contents; `/tree` is for paths. The picker is about paths. Caching
  + filtering in JS gives us instant typing feedback without per-key
  RTT.
- **No "edit on phone" affordance in v1.** Mobile is a steering
  interface, not an editor. The agent edits; the user verifies.
  Skipping edit-on-phone keeps the LLD count down and avoids the
  hardest UX problems (saving, conflict resolution).
- **Per-file diff piggybacks on the cumulative `/diff` endpoint.** Same
  data shape, same parsing path; just a server-side filter. Cheaper
  than a parallel "single-file diff" implementation.
- **Capabilities are bridge-emitted, not auto-detected on mobile.**
  The bridge knows whether the cwd is a git repo, whether ripgrep is
  on PATH, etc. Mobile shouldn't probe.
- **No `@`-mention server validation.** The bridge doesn't enforce
  that an `@path` token references a real file. The agent (Claude
  Code) already handles missing-path gracefully; doing it twice is
  defensive without benefit.
- **No streaming search.** Ripgrep can stream; we collect everything
  up to `limit` and send one response. The UI doesn't need streaming
  for ≤500 results.
- **Skip-list is bridge-side, not config.** node_modules / dist / etc.
  are universal noise; making them configurable invites trouble. We
  add a config flag only if the universal default proves wrong.
