# Plan — Mobile File Visibility

Reference: [frd.md](./frd.md), [hla.md](./hla.md).

## Overview

Six phases, ranked by user value. Each phase is independently shippable
behind a capability flag — if a phase lands but a follow-on phase
slips, the existing system keeps working. The plan tracks work via
checkboxes; "Definition of done" at the end of each phase is the
objective gate.

Phases:

1. **`@`-mention picker + project tree endpoint** — typing path becomes
   a tap.
2. **Per-file diff route** — tapping a changed file lands on its diff.
3. **Inline diffs on Edit / Write / MultiEdit cards** — verify without
   leaving chat.
4. **Files tab + git working-tree view** — third pager page with git
   status.
5. **File search** — ripgrep over cwd from the Files tab.
6. **Syntax-highlighted file viewer** — extension-aware rendering.
7. **Per-turn diff + chat ↔ file backlinks** — "what changed since I
   last looked" + jump-to-tool-use.

Phase 7 is intentionally last; it's polish and depends on the surfaces
introduced by phases 2–4.

## Definition of done (whole effort)

- `caps.projectBrowser`, `caps.projectSearch`, `caps.gitStatus` exist
  as fields on `AgentCapabilities`; the Claude Code SDK driver reports
  all three `true`; the stub agent reports them all `false`.
- New bridge endpoints `/tree`, `/search`, `/git/status`, `/git/diff`
  ship with capability gates; `/diff` and `/file` accept the new
  optional query params backward-compatibly.
- `<MentionPicker>`, `<InlineDiff>`, `<FilesPane>`,
  `<SyntaxHighlightedCode>` exist as standalone components and are
  type-checked clean on both native and web builds.
- `pnpm exec tsc --noEmit` clean in `bridge/` and `mobile/`.
- `cd web && pnpm build` succeeds; bundle-size delta documented.
- The "no magic strings" gate holds: every new wire-frame value,
  capability key, and enum-like type has a named constant matching
  the existing `SDK_RUN_STATUS` / `COMPACT_TRIGGER` pattern.
- Stub-agent regression: opening a session whose caps report all three
  new flags `false` hides the Files tab, hides the `@`-picker,
  doesn't render `<InlineDiff>` on tool cards, and doesn't crash.

## Phase 1 — `@`-mention picker + project tree endpoint

Branch: `2026-05-24-mobile-file-visibility-phase1-mentions`

Goal: typing `@` in the chat input opens a picker; tapping a file
inserts `@path/to/file.ts` into the draft.

### LLD (write first)

- [x] LLD skipped — design fell out of the SDD's HLA section
  directly. Decisions locked in code: one `/tree?depth=4` per session
  per 30s TTL, ranking is basename-prefix > basename-substring >
  path-substring, refresh keyed on a `mentionRefreshKey` ref bumped
  every `file_changed`. Resolves [FRD Q3](./frd.md#known-unknowns--open-questions).

### Bridge

- [x] Add `projectBrowser?: boolean` to `AgentCapabilities` in
  `bridge/src/agents/types.ts`.
- [x] Add `TreeEntry`, `TreeEntryKind`, `TREE_ENTRY_KIND`,
  `ListDirectoryOpts` types + constants.
- [x] Implement `bridge/src/fileTree.ts` per [HLA — fileTree.ts](./hla.md#bridge--filetreets-new).
  - [x] `listDirectory(cwd, opts)`.
  - [x] Skip list constant (`SKIP_DIRS`).
  - [x] `.gitignore` honoring via `git check-ignore --stdin` (batched per
        directory). Treat non-git cwd as "nothing ignored."
  - [x] Symlink realpath check against cwd realpath; `400` on escape.
- [x] Server route: `GET /sessions/:agent/:id/tree`. Capability gate
  on `projectBrowser`. Query params: `path`, `depth`, `includeHidden`,
  `includeIgnored`. Validates via zod schema; `400` on bad input.
- [x] `ClaudeCodeSdkSession.capabilities()` reports
  `projectBrowser: true` when `existsSync(cwd)`; otherwise `false`.

### Mobile

- [x] Mirror `TreeEntry`, `TREE_ENTRY_KIND`, capability bit in
  `mobile/lib/types.ts`.
- [x] `lib/bridge.ts`: `fetchTree(cfg, agent, id, opts)` helper.
- [x] `components/chat/MentionPicker.tsx`. Per [HLA — MentionPicker](./hla.md#mobile--mentionpicker-new).
      No `.web.tsx` shim needed — the component uses only RN primitives
      (FlatList / Pressable / Text / View) that work cleanly on
      react-native-web.
- [x] Wire into chat input: caret + draft → token detect → picker.
      Caret tracked via `onSelectionChange`; picker insertion uses a
      one-shot controlled `selection` prop to land the caret after the
      inserted token.
- [x] Cache invalidation: subscribe to `file_changed` events; bump the
  cache version on any add/unlink (rename approximation = unlink+add).
- [x] Picker hidden when `caps.projectBrowser` is falsy.

### Definition of done — Phase 1

- [x] `tsc --noEmit` clean in bridge + mobile.
- [ ] `GET /tree` returns the expected JSON shape against a real
  Claude session; `..` escape rejected; symlinks outside cwd rejected.
  *(Smoke verification pending the next real session — code paths and
  zod schema validated, but exercising the route end-to-end is the gate.)*
- [ ] On a real session, typing `@chat` in the chat input on mobile
  shows `components/chat/Markdown.tsx` (and similar) within one RTT;
  tap inserts `@components/chat/Markdown.tsx`. *(Pending smoke.)*
- [ ] On the stub agent (`projectBrowser: false`), typing `@` does
  nothing extra; the character types literally. *(Pending smoke — stub
  agent doesn't override `projectBrowser` so it defaults to falsy.)*
- [ ] Web build: `cd web && pnpm build` succeeds; picker renders in
  desktop Chrome with keyboard navigation. *(Pending — web build not
  re-run in this commit.)*

## Phase 2 — Per-file diff route

Branch: `2026-05-24-mobile-file-visibility-phase2-per-file-diff`

Goal: tapping a changed file from the in-chat pane goes to its diff,
not its current contents.

### Bridge

- [x] Extend `GET /sessions/:agent/:id/diff` to accept optional
  `path=<rel>` query param. When present, the response's `files` array
  contains at most the one matching entry; otherwise behavior is
  unchanged.
- [x] Validation: reject `..` traversal segments up front via the new
      shared `normalizeClientRelPath` helper in `bridge/src/files.ts`.
      No realpath check is needed for the diff route — we're filtering
      an in-memory list, not reading bytes — but the syntactic
      rejection keeps the API surface tidy. zod gate not added; query
      surface is a single optional string.

### Mobile

- [x] Extend `lib/bridge.ts` `fetchDiff` signature with optional
  `{ path?: string }`. Pass through to query string.
- [x] `app/sessions/[agent]/[id]/diff.tsx`: read `path` query via
  `useLocalSearchParams`. When set, auto-expand every returned file
  (per-file mode usually returns one entry, but a rename can produce
  two), hide the cumulative summary, change the screen title to the
  file's basename, and show a per-file empty state when the path has
  no diff vs baseline.
- [x] In-chat "📂 N files changed" pane (in `app/sessions/[agent]/[id]/index.tsx`):
  - [x] Change each row's `onPress` from `router.push(/file?path=…)`
    to `router.push(/diff?path=…)`.
  - [x] Add a "View full file" long-press handler that still goes to
    the file viewer.

### Definition of done — Phase 2

- [x] `tsc --noEmit` clean (bridge + mobile).
- [ ] On a real session with ≥2 changed files, tapping any row in the
  in-chat pane shows that file's hunks only. *(Smoke verification
  pending the next real session.)*
- [x] Backward compat: `/diff` with no `path` returns the cumulative
  diff as before — `pathFilter` only applies when the query param is
  present and non-empty.
- [x] Backward compat: the header overflow's "Open diff" still opens
  the cumulative view (no `path` param passed).

## Phase 3 — Inline diffs on Edit / Write / MultiEdit cards

Branch: `2026-05-24-mobile-file-visibility-phase3-inline-diff`

Goal: green/red preview embedded directly in the tool card.

### LLD

- [x] LLD skipped — decisions captured inline in `lib/diffCache.ts`
  and `components/chat/InlineDiff.tsx`. Settled: cache keyed on
  `(agent, sessionId, path)` (no baselineSha — the session's baseline
  is fixed for its lifetime; the cache is per-session anyway and gets
  fully dropped on unmount), 5-min wall-clock TTL with explicit
  invalidation via `file_changed`, in-flight dedup via a parallel
  `Map<string, Promise>`, 150 ms mount debounce, 200-entry LRU cap.
  "Preview unavailable · <path>" caption on fetch failure. Resolves
  [FRD Q2](./frd.md#known-unknowns--open-questions).

### Mobile

- [x] `components/chat/InlineDiff.tsx` per [HLA — InlineDiff](./hla.md#mobile--inlinediff-new-shared).
  - [x] Lazy fetch on mount with debounce (150ms) and dedup.
  - [x] LRU cache module (`lib/diffCache.ts`) keyed by
    `(agent, sessionId, path)`; invalidated on `file_changed` for that
    path. Whole-session clear on chat unmount.
  - [x] Tap to toggle collapsed/expanded.
  - [x] Long-press → `router.push(/file?path=…)`.
  - [x] On fetch error: render a "Preview unavailable · <path>"
    caption; card's existing JSON view remains visible above.
- [x] Refactor per-file diff route (Phase 2) to render via
  `<InlineDiff prefetched={…} collapsed={false} />` so the route and
  the cards share one render path.
- [x] Wire `<InlineDiff>` into the Claude Code card pack
  (`components/chat/cardPacks/claudeCode.tsx`) for:
  - [x] `Edit` — uses `input.file_path`.
  - [x] `Write` — uses `input.file_path`.
  - [x] `MultiEdit` — uses `input.file_path` (one inline diff for the
    file the multi-edit targets).
  - [x] `NotebookEdit` — uses `input.notebook_path`. Newly registered
    in this phase; previously fell through to the generic fallback.
- [x] `ToolCardContext` extended with `sessionId` so card renderers
  can hit session-scoped bridge endpoints without the chat container
  threading it manually each call.
- [x] Absolute-path normalization helper inside the card pack so
  `claude`-style absolute `file_path` inputs map to git-style
  relative paths for the `/diff?path=` filter. Known limitation:
  paths whose cwd doesn't match the session's cwd quietly degrade to
  "No diff vs baseline" — Phase 8 will fix this properly via the
  chat ↔ file backlink index.

### Definition of done — Phase 3

- [x] `tsc --noEmit` clean (bridge + mobile).
- [ ] On a real session, an `Edit` tool card renders a green/red
  preview within ~250 ms of the tool_result landing. *(Smoke pending.)*
- [ ] An offline-ish bridge error on the diff fetch shows the
  "preview unavailable" caption; the card stays usable. *(Smoke
  pending — error path is wired but not exercised against a dead
  bridge.)*
- [ ] No more than N+debounce diff fetches occur for a MultiEdit
  burst of N files (verified by counting requests in dev tools).
  *(Static reasoning: in-flight dedup + 150 ms mount debounce + LRU
  cache guarantee ≤ N + small constant; behavioral confirmation
  pending.)*
- [ ] On the stub agent, tool cards render with no inline diff (the
  card pack still renders the existing surfaces). *(Stub agent's
  card pack doesn't include Edit/Write so the inline diff never
  renders for it — verified statically; smoke pending.)*

## Phase 4 — Files tab + git working-tree view

Branch: `2026-05-24-mobile-file-visibility-phase4-files-tab`

Goal: a third pager page with git status, session changes, and the
project tree.

### LLD

- [x] LLD skipped — design fell out of the SDD HLA cleanly. Decisions
  locked in code: Files lives at pager index 1 (between Chat at 0
  and Preview at last); gesture is bidirectional on the middle page
  via dynamic `activeOffsetX` keyed on `activeIndex` / `pageCount`;
  section collapse state is component-local (not persisted across
  navigations — re-opening the tab restores defaults: git open,
  session open, tree collapsed); empty state shows a one-line
  explanation rather than nothing. Resolves [FRD Q4](./frd.md#known-unknowns--open-questions).

### Bridge

- [x] Add `gitStatus?: boolean` to `AgentCapabilities`.
- [x] Add `GitFileStatus`, `GIT_FILE_STATUS`, `GitStatusEntry`,
  `GitStatusResult`, `GitDiffFileOpts` types + constants.
- [x] Extend `bridge/src/git.ts`:
  - [x] `runGitStatus(cwd)` shells out to
    `git status --porcelain=v2 --branch -z` and parses. Returns
    `{ isRepo: false, … }` cleanly when cwd isn't a git tree.
  - [x] `runGitDiffFile(cwd, { path, staged })` shells out to
    `git diff [--cached] -- <path>` and reuses the existing
    `parseUnifiedDiff` parser.
- [x] Server route: `GET /sessions/:agent/:id/git/status`. Capability
  gate. 3 s server-side timeout returning `{ incomplete: true, … }` on
  big repos.
- [x] Server route: `GET /sessions/:agent/:id/git/diff?path=&staged=`.
  Capability gate. Reuses the shared `normalizeClientRelPath` validator
  for the `path` query.
- [x] `ClaudeCodeSdkSession.capabilities()` reports `gitStatus: true`
  when `existsSync(join(cwd, '.git'))`; otherwise `false`.

### Mobile

- [x] Mirror new git types + capability bit in `mobile/lib/types.ts`.
- [x] `lib/bridge.ts`: `fetchGitStatus`, `fetchGitDiffFile` helpers.
- [x] `components/chat/ChatPreviewPager.tsx`: extend to accept an
  optional `files` render prop; pager renders 2 or 3 pages depending
  on which props are present. Generalized to render `pages.map()` so
  growing past 3 pages later is also trivial.
- [x] `components/files/FilesPane.tsx` per [HLA — Files tab](./hla.md#mobile--files-tab-new).
  - [x] Search bar (placeholder; `editable={false}` until Phase 5 lands).
  - [x] Git working tree section (collapsible; capability-gated;
    Staged / Modified / Untracked sub-groups).
  - [x] Session changes section (reuses the chat container's
    `changedFiles` map; threaded in via props).
  - [x] Project tree section (capability-gated on `projectBrowser`;
    placeholder caption directing user to @-mention picker until the
    full tree browser lands in a follow-up).
- [x] Chat container (`app/sessions/[agent]/[id]/index.tsx`):
  - [x] Wire `files` render prop into the pager when at least one
    of `caps.gitStatus`, `caps.projectBrowser`, or
    `changedFiles.size > 0` is true.
  - [x] Pager-index-based gestures already worked for N pages once
    the pager generalized — the `gestureEnabled: pagerIndex === 0`
    rule for iOS back-swipe still makes sense (only Chat allows the
    system gesture; Files / Preview block it so they don't fight the
    horizontal pan).
- [x] Per-file git diff: `app/sessions/[agent]/[id]/diff.tsx`
  refactored around a `DiffMode` discriminated union (`cumulative` |
  `session-file` | `git-file`). When `source=git`, the screen fetches
  via `fetchGitDiffFile` instead of `fetchDiff`; the title gains a
  ` · staged` / ` · git` suffix to make the mode obvious.

### Definition of done — Phase 4

- [x] `tsc --noEmit` clean (bridge + mobile).
- [ ] On a Claude session in a git repo, swiping to the Files tab
  shows git status + session changes + project-tree placeholder.
  *(Smoke pending.)*
- [ ] Tapping a "Modified" entry opens
  `/diff?source=git&path=…` showing the git diff vs HEAD. *(Smoke
  pending; route + fetch wired.)*
- [ ] Tapping a "Staged" entry opens
  `/diff?source=git&path=…&staged=true` showing the git diff vs
  index. *(Smoke pending; route + fetch wired.)*
- [x] On a non-git cwd: `gitStatus` capability reports `false` →
  git section hidden in the Files tab, no error toast.
- [x] On the stub agent: `gitStatus` / `projectBrowser` undefined →
  Files tab hidden entirely *unless* the session has touched files
  in the live stream (which the stub agent currently doesn't).
- [ ] Web build still succeeds; Files tab renders in desktop Chrome.
  *(Pending — not re-run in this commit.)*

## Phase 5 — File search

Branch: `2026-05-24-mobile-file-visibility-phase5-search`

Goal: type a query, get matches, tap a result to land on the matched
line.

### LLD

- [x] LLD skipped — settled in code. Decisions: ripgrep flags
  `--json --max-count=<limit> --max-filesize=2MB` with
  `--fixed-strings` for non-regex queries; ripgrep respects
  `.gitignore` by default. Hard `MAX_PREVIEW_LEN = 240` on each
  preview line (clipped around the match, with `…` ellipses).
  `SEARCH_LIMIT_DEFAULT = 100`, `SEARCH_LIMIT_MAX = 500`. POSIX
  grep fallback uses `-RHnI --exclude-dir=<skip-list> -m <limit>`,
  `-F` (fixed) or `-E` (extended regex). Backend detected once on
  first call, cached, and logged at server boot. Resolves
  [FRD Q6 + Q8](./frd.md#known-unknowns--open-questions).

### Bridge

- [x] Add `projectSearch?: boolean` to `AgentCapabilities`.
- [x] Add `SearchHit` type + `SEARCH_LIMIT_*` constants.
- [x] Implement `bridge/src/search.ts` per [HLA — search.ts](./hla.md#bridge--searchts-new).
  - [x] ripgrep detection cached after first probe; logged once at
        boot from `server.ts`.
  - [x] `--json --max-count=<limit> --max-filesize=2M` flag set.
  - [x] `--fixed-strings` for `regex=false`.
  - [x] POSIX grep fallback with degraded regex (no `--max-filesize`,
        regex downgraded to BRE).
- [x] Server route: `GET /sessions/:agent/:id/search?q=&limit=&regex=`.
  Capability-gated; defends `q.length > 1000`; clamps `limit` to
  `[1, 500]`.
- [x] `ClaudeCodeSdkSession.capabilities()` reports
  `projectSearch: existsSync(cwd)` — the backend (rg/grep) probe is
  deferred to first use so a missing rg doesn't drop the capability
  on machines that have grep.

### Mobile

- [x] Mirror `SearchHit` type + `projectSearch` capability bit.
- [x] `lib/bridge.ts`: `fetchSearch` helper with `FetchSearchOpts`
      (`limit`, `regex`).
- [x] Wire the FilesPane search bar (placeholder from Phase 4) to
  trigger fetches on explicit submit (return-key). Capability-gated
  on `projectSearch`; bar hidden entirely when the agent doesn't
  support it.
- [x] Replace the FilesPane sections with the results list when a
  query is active; "Clear" button returns to the sectioned view.
  Results show the matched substring in accent color.
- [x] File viewer accepts a `line=N` query param and scrolls +
  highlights line N on mount (uses `addBg` from the diff palette
  for the highlight stripe).

### Definition of done — Phase 5

- [x] `tsc --noEmit` clean (bridge + mobile).
- [ ] Searching for `useEffect` in the rove repo returns matches in
  multiple files via ripgrep; tapping a result opens the file viewer
  scrolled to the matched line. *(Smoke pending.)*
- [ ] grep fallback path: rename rg on PATH, restart bridge, repeat
  the same search; degraded but functional results. *(Smoke pending.)*
- [x] On the stub agent: search bar hidden (`projectSearch` capability
  not advertised by the stub).

## Phase 6 — Syntax-highlighted file viewer

Branch: `2026-05-24-mobile-file-visibility-phase6-highlight`

Goal: code files render with extension-aware syntax highlighting;
image files render the image; binaries render a clean fallback.

### LLD

- [ ] `syntax-highlight-lld.md`: pick the highlighter library, measure
  bundle delta against the existing web build (target < 150 KB
  gzipped additive), define the extension → language map, define the
  binary / unsupported fallback. Resolves [FRD Q1](./frd.md#known-unknowns--open-questions).

### Mobile

- [ ] `components/files/SyntaxHighlightedCode.tsx` (+ `.web.tsx` if
  the chosen library needs it). Wraps the highlighter and applies the
  app's theme tokens for colors.
- [ ] `lib/pathToLanguage.ts`: small map from extension to language
  identifier the highlighter understands.
- [ ] `components/files/ImagePreview.tsx`: `<Image>` for native,
  `<img>` for web; handles SVG, PNG, JPG, GIF, WebP, BMP, ICO.
- [ ] `components/files/UnsupportedPreview.tsx`: centered "Preview not
  supported · path · copy path" with copy-to-clipboard button.
- [ ] `app/sessions/[agent]/[id]/file.tsx`:
  - [ ] Pick renderer based on extension: highlighted code / image /
    unsupported.
  - [ ] Wire `line` query param: scroll + highlight target line on
    mount.
  - [ ] Keep existing line numbers, horizontal scroll, copy-all,
    metadata bar.

### Definition of done — Phase 6

- [ ] `tsc --noEmit` clean.
- [ ] `cd web && pnpm build` succeeds; bundle delta documented in
  the LLD, ≤150 KB gzipped additive.
- [ ] `.ts` files render with TS highlighting on mobile and web.
- [ ] `.png` / `.jpg` / `.svg` files render the image.
- [ ] `.bin` / `.unknown` files render the unsupported surface.
- [ ] `?line=42` lands scrolled and highlighted on line 42.

## Phase 7 — Per-turn diff + chat ↔ file backlinks

Branch: `2026-05-24-mobile-file-visibility-phase7-backlinks`

Goal: "what's changed since I was last here?" chip + bidirectional
chat ↔ file jumps.

### LLD

- [ ] `per-turn-diff-lld.md`: anchor choice (lastSeenAt wall clock
  vs last user message), AppState integration, chip visibility rules.
  Resolves [FRD Q5](./frd.md#known-unknowns--open-questions).

### Bridge

- [ ] Extend `GET /sessions/:agent/:id/diff` with optional
  `since=<iso>` query param; mutually exclusive with `path=`. Returns
  per-file diffs filtered to files modified after the timestamp.

### Mobile

- [ ] Chat container: maintain `fileToToolUseIds: Map<string, string[]>`
  ref, populated from `tool_use` events with known file-touching
  tools (Edit / Write / MultiEdit / NotebookEdit) and an
  `input.file_path`.
- [ ] Chat container: `lastSeenAt` per-session cursor stored via the
  existing `kv-store` shim. Updated on AppState 'active' transitions
  and initial mount. Read on mount.
- [ ] Chat container: render a "What's changed since you were last
  here?" chip when the local `file_changed` ring buffer has entries
  > `lastSeenAt`.
- [ ] Diff route: accept `since` query param, pass through to
  `/diff?since=`.
- [ ] File viewer: "Show in chat" button uses the
  `fileToToolUseIds` index (looked up via a small route param +
  context shared via the existing pager wrapper). On tap, replace
  back to the chat route and scroll the chat list to the matching
  `toolUseId`.
- [ ] `<InlineDiff>` and per-file diff screen: same "Show in chat"
  button.

### Definition of done — Phase 7

- [ ] `tsc --noEmit` clean.
- [ ] On a real session, sending a message, backgrounding the app,
  letting the agent edit 3 files, foregrounding: the chip appears
  showing 3 changed files; tap opens a per-file diff filtered to
  those three.
- [ ] From a file viewer opened via an Edit card, "Show in chat"
  scrolls the chat list to that exact tool_use.
- [ ] Backwards compat: `/diff` with no params still returns the
  cumulative view.

## Open questions (cross-phase)

- ⚠️ **Inline diff data source for non-git sessions.** Today's
  cumulative `/diff` is computed against a session baseline SHA. If
  the cwd isn't a git repo, the cumulative diff falls back to
  "working tree vs baseline snapshot" — we should confirm the per-
  file slice still makes sense in that case before Phase 2 lands.
- ⚠️ **Picker UX on physical keyboard (iPad Magic Keyboard, web).**
  Arrow keys to navigate, return to select, escape to dismiss — needs
  testing alongside the iOS software keyboard.
- ⚠️ **Files tab vs Preview swipe gesture.** Today's pager has
  `gestureEnabled: pagerIndex === 0` to prevent the chat from
  swiping when the preview is in focus. Three pages need a richer
  gesture policy; Phase 4 LLD must spell it out.
- ⚠️ **Image preview over HTTPS-to-HTTP bridge.** Existing mixed-
  content guard catches the fetch; image element load failure is a
  separate path that needs explicit handling.
- ⚠️ **Big-tree response size.** A `depth=4` recursive listing on a
  large monorepo could return tens of thousands of entries. Phase 1
  LLD must set a response cap (e.g. 10k entries, return
  `truncated: true`).

## Out of scope (tracked for v2+)

- Editing files from the phone.
- Staging / unstaging / committing from the phone.
- Conflict / rebase / merge UI.
- File history (`git log`) / blame.
- Multi-repo sessions.
- Indexed search (current ripgrep approach is good enough at v1
  scales).
- Cross-session file comparison.
