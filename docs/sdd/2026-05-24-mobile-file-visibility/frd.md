# Functional Requirements — Mobile File Visibility

## Problem

The rove mobile / web client is good at watching an agent talk. It is poor
at watching what the agent is **doing to your files**. Today:

- The only path to a file is "the agent edited it this session." Anything
  the agent hasn't touched is invisible from the phone.
- Tapping a changed file opens the full current contents — not what just
  changed in it. To see "did this Edit look right?" you have to open the
  cumulative session diff and scroll to the right file.
- The cumulative diff is the only diff. There is no per-file view, no
  per-turn view, no "what's changed since I last looked."
- Tool cards for `Edit` / `Write` / `MultiEdit` show the raw input JSON.
  The single most natural place to verify an edit ("does this look
  right?") shows you `{ "old_string": "...", "new_string": "..." }`
  instead of a green/red preview.
- There is no `@`-mention picker in the chat input. To reference a file
  in your prompt you have to type the full path from memory.
- There is no view of the broader git state — only the session's own
  baseline diff. If the agent and a co-worker both edited `foo.ts`,
  you can see the agent's part of it (since baseline) but not the
  full working-tree picture.
- The file viewer renders every file as plain text. A 400-line TypeScript
  file with no syntax highlight is hard to scan on a phone screen.
- There is no file search. "Where did I write that helper?" can't be
  answered from mobile.

For a **vibecoding from the phone** flow — agent iterates, you steer —
this means the user is constantly context-switching to the laptop just
to confirm the agent did the right thing. The whole point of the project
is that the laptop is the *agent's* surface, not the user's.

## Goals

1. **Make every file in the project reachable from the phone**, not just
   the ones the agent happened to touch this session.
2. **Make per-file diffs the default view of a change**, with the
   cumulative diff still available for "what did this session do overall."
3. **Surface inline diffs on the Edit / Write tool cards** so the
   user can verify an edit without leaving the chat.
4. **Add an `@`-mention picker** so referencing a file in your prompt is
   a tap, not a typing exercise.
5. **Add a git working-tree view** so the user can see "what is my repo
   in" — staged / unstaged / untracked — independent of what this session
   did.
6. **Render files with extension-aware syntax highlighting** and inline
   image previews. Binary / unknown extensions get a clean fallback.
7. **Add file search** so "find me that helper" works from the phone.
8. **Add per-turn diff + chat ↔ file backlinks** so "what changed since
   I last looked" is one tap and "who edited this file?" jumps back into
   the chat.
9. **Keep the bridge agent-neutral.** Every new bridge endpoint and
   wire frame is gated by a capability declared by the driver. The
   Claude Code SDK driver advertises them all (git + tree access are
   trivial when the agent has a cwd); a future Codex / Aider driver may
   not, and the UI must hide what's not supported, not crash on it.
10. **No new screens that aren't earning their keep.** The Files view
    lives as a third pager page next to the existing Chat / Preview
    pages, not as a separate route.

## Non-goals (v1)

- **Editing files from mobile.** Read + diff only. Edits remain the
  agent's job. (Future v2.)
- **Staging / unstaging / committing from mobile.** The git working-tree
  view is read-only. (Future v2 — once we know what the on-phone UX for
  a hunk-level cherry-pick looks like, which is a hard problem on a
  small screen.)
- **A first-class file tree of the entire host.** The tree is scoped to
  the session's cwd. The bridge's existing `readScopedFile` already
  enforces this; the new endpoints do the same.
- **Replacing the existing `/diff` and `/file` routes.** They are
  extended (`/diff` accepts an optional `path=`; `/file` gains
  syntax-highlighted rendering), not replaced.
- **Replacing the in-chat "📂 N files changed" pane.** It survives — it
  gains the inline-diff treatment from #3 and a per-row tap that goes to
  per-file diff instead of full file contents.
- **Custom syntax grammars or a from-scratch highlighter.** We pick an
  off-the-shelf library that works on RN + react-native-web.
- **Indexing / search-as-you-type across the entire repo.** Search is
  on-demand via ripgrep on the bridge, results capped.
- **Conflict resolution UI.** If git is mid-rebase / mid-merge, the
  status endpoint surfaces the state honestly but no UI tries to drive
  the resolution.
- **Multi-repo support.** One session, one cwd, one repo's worth of
  state at a time.

## Personas

The same one persona that the rest of rove serves:

**Solo developer driving the agent from the phone.** Laptop is running
`claude` and the rove bridge. They are on the couch / on a train / out
walking the dog. Their flow is:

1. Send a prompt to the agent.
2. Watch the tool calls and edits stream in.
3. **Verify edits look right** (this is where today's UX falls apart).
4. Send the next prompt, often referencing a file by name.
5. Approve / reject any permission prompts.
6. Periodically zoom out — "what has this session actually changed?" or
   "what's the state of my repo right now?"

This feature is specifically about steps 3, 4, and 6.

## User stories

### File reference & navigation

1. *As a phone user, when I type `@` in the chat input, I see a picker
   of files in my project matched by what I type after the `@`. Tapping
   one inserts `@path/to/the/file.ts` into my message.*
2. *As a phone user, I can browse my project's file tree from a Files
   tab in the session view — not just files the agent touched.*
3. *As a phone user, I can search file contents from the Files tab and
   tap a result to land on the matching line.*

### Per-file & per-turn diffs

4. *As a phone user, tapping a changed file in the "📂 N files changed"
   pane shows me **its diff**, not the current file contents.*
5. *As a phone user, when the agent runs an `Edit` / `Write` /
   `MultiEdit` tool, the chat card shows a green/red preview of the
   change inline. Tap to expand to the full hunks. Long-press to jump
   to the full file viewer.*
6. *As a phone user, I can ask "what changed since my last message" and
   see exactly that — not the cumulative session diff.*
7. *As a phone user, from a file viewer or per-file diff, I can jump
   back to the chat message whose tool_use produced this change.*

### Git working-tree visibility

8. *As a phone user, the Files tab shows me the full `git status` of
   the repo — staged, unstaged, untracked — independently of what this
   session edited. Tapping any entry shows its diff (vs HEAD or vs
   index).*

### File viewer quality

9. *As a phone user, opening any code file renders it with extension-
   aware syntax highlighting. TypeScript, Python, JSON, Markdown, etc.
   all look like code, not undifferentiated text.*
10. *As a phone user, opening an image file (PNG, JPG, SVG, WebP)
    renders the image. Opening a binary / unknown extension shows a
    clean "preview not supported · copy path" surface.*

### Multi-agent compatibility

11. *As a phone user on an agent that doesn't support the file tree or
    git status (a hypothetical agent without a real cwd, or one whose
    driver hasn't implemented those endpoints), the Files tab is
    hidden, the @-mention picker still works against whatever file
    surface the agent does expose (or is hidden if none), and nothing
    crashes.*

## Functional requirements

### FR-1 — `@`-mention picker

- A `<MentionPicker>` overlay appears when the user types `@` in the
  chat draft, anchored above the input row.
- Typing more characters after the `@` filters the list (substring or
  fuzzy match against full path; ranking favors basename matches).
- Tapping a result inserts the path token `@path/to/file.ext` at the
  caret, replacing the partial `@…` prefix.
- The picker dismisses on space, on send, on `Escape` (web), and on tap
  outside.
- The picker is gated on a new capability: `caps.projectBrowser === true`.
- The agent already understands `@path` semantics natively (Claude Code's
  CLI reads files referenced this way). The bridge does nothing special
  with the inserted token — it goes through as part of the user message.

### FR-2 — Per-file diff route

- The bridge `GET /sessions/:agent/:id/diff` accepts an optional `path=`
  query parameter. When present, the response contains only the matching
  `DiffFile`. Behavior unchanged when absent.
- The mobile `/sessions/[agent]/[id]/diff` screen reads the same `path`
  query parameter. When present, it auto-expands and scrolls to that
  file's hunks; the other files are hidden (per-file mode) or visually
  de-emphasized.
- The in-chat "📂 N files changed" file rows navigate to per-file diff
  (not to the full file viewer, as they do today).
- Backward compatible: a request with no `path` still returns the full
  cumulative diff.

### FR-3 — Inline diff on Edit / Write / MultiEdit cards

- The Claude Code card pack's `Edit` / `Write` / `MultiEdit` /
  `NotebookEdit` cards embed a collapsed `<InlineDiff>` component
  showing the green/red preview of the change.
- Default state: collapsed (first 5 lines of context + every changed
  line, capped at ~30 lines visible).
- Tap → expanded (full hunks).
- Long-press → opens the per-file diff route (FR-2) at this file.
- Inline diff data comes from the existing `/diff?path=` endpoint
  (FR-2), fetched lazily on first render (or eagerly if cheap — decided
  in the LLD).
- Cards remain functional if the diff fetch fails — falls back to the
  raw input JSON they show today.

### FR-4 — Git working-tree view

- New bridge endpoint `GET /sessions/:agent/:id/git/status` returns the
  parsed `git status --porcelain=v2 --branch -z` output: branch, ahead/
  behind, list of `{ path, indexStatus, worktreeStatus, renamedFrom?,
  isUntracked }`. Detects renames.
- New bridge endpoint `GET /sessions/:agent/:id/git/diff?path=...&staged=true|false`
  returns the diff for a single file vs HEAD (`staged=false`, default)
  or vs index (`staged=true`).
- Both gated on a new capability: `caps.gitStatus === true`. Reported by
  any driver whose session cwd is a git working tree.
- The Files tab (FR-7) renders the status as a sectioned list (Staged /
  Modified / Untracked). Tapping any row opens the per-file diff with
  the appropriate `staged` flag.
- If the cwd isn't a git repo, the endpoints return `404` with a typed
  error body; the Files tab section is omitted (not an error toast).

### FR-5 — Project file browser

- New bridge endpoint `GET /sessions/:agent/:id/tree?path=&depth=`
  returns a directory listing scoped to the session's cwd.
  - `path` defaults to `''` (the cwd itself). Resolved against cwd
    using the same path-scoping rules as `readScopedFile` — `..`
    traversal returns `400`.
  - `depth` defaults to `1` (children only). Higher depths flatten the
    subtree.
  - Each entry: `{ name, path (rel), kind: 'file' | 'dir' | 'symlink',
    size?: number, modifiedMs?: number, gitIgnored?: boolean }`.
- Respects `.gitignore` and a built-in skip list: `node_modules`,
  `.git`, `dist`, `build`, `.next`, `.expo`, `.venv`, `__pycache__`,
  `.cache`. `gitIgnored: true` is surfaced so the UI can dim ignored
  entries instead of hiding them entirely, but they default to hidden.
- Hidden files (leading `.`) are returned but flagged so the UI can
  collapse them under a "Show hidden" toggle.
- Gated on `caps.projectBrowser === true`.

### FR-6 — File search

- New bridge endpoint `GET /sessions/:agent/:id/search?q=&limit=`
  returns ripgrep matches under the session's cwd.
  - `q` is a literal substring by default; a `regex=true` flag enables
    regex mode.
  - `limit` defaults to 100, caps at 500.
  - Each result: `{ path, line, column, preview, matchStart, matchEnd }`.
- Skip list = file-tree skip list (FR-5). Respects `.gitignore` via
  ripgrep's defaults.
- Falls back to `grep -RHn` if ripgrep is not on `PATH` (logged once on
  bridge boot). Functional parity for the simple cases; regex flag
  becomes basic POSIX regex.
- Gated on `caps.projectSearch === true`.

### FR-7 — Files tab

- The existing `ChatPreviewPager` becomes a three-page pager:
  **Chat | Files | Preview**. Chat stays page 1 (default landing).
- The Files page renders, in order:
  - **Search bar** at the top — drives FR-6.
  - **Git working-tree section** — collapsible, drives FR-4. Hidden if
    `caps.gitStatus` is false.
  - **Session changes section** — the same list as today's "📂 N files
    changed" pane, now with diff stats per file. Hidden if no
    session-side changes.
  - **Project tree section** — collapsible, drives FR-5. Hidden if
    `caps.projectBrowser` is false.
- If all of git, project-browser, and session-changes are hidden, the
  Files page itself is hidden (pager goes back to two pages).

### FR-8 — Syntax-highlighted file viewer

- The existing `/sessions/[agent]/[id]/file` screen replaces its
  plain-text renderer with extension-aware syntax highlighting.
  - Minimum supported extensions: `.ts .tsx .js .jsx .py .json .md .css
    .html .yaml .yml .toml .sh .go .rs .swift .java .kt .rb .php .sql
    .xml .gitignore .dockerfile .env`.
  - Image extensions render the image (using `<Image>` for native,
    `<img>` for web): `.png .jpg .jpeg .gif .webp .svg .ico .bmp`.
  - PDFs and binaries: a centered "Preview not supported · `path/to/file`
    · copy path" surface with a copy-path button.
- Library choice: see the [HLA tech stack](./hla.md#tech-stack); we lean
  toward `react-native-syntax-highlighter` with Prism grammars, but the
  HLA records the constraint that the chosen library must bundle on
  react-native-web without blowing the web build budget (~530 KB
  gzipped today).
- Existing behaviors preserved: line numbers, horizontal scroll, copy
  button, file metadata bar.
- The file viewer accepts a `line=N` query parameter that scrolls to and
  highlights line N on mount (used by search-result jump).

### FR-9 — Per-turn diff + chat ↔ file backlinks

- The chat container tracks a per-session `lastSeenAt` timestamp,
  updated every time the chat is foregrounded (similar to the existing
  AppState reconnect plumbing). Persisted via the existing `kv-store`
  shim so it survives backgrounding.
- A "What's changed since I was last here?" chip appears at the top of
  the chat (under the status bar) when there are file changes after
  `lastSeenAt`. Tapping it opens the per-file diff route filtered to
  that range (`/diff?since=<iso>`).
- The bridge `GET /diff` accepts an optional `since=` parameter
  (alternative to `path=`; mutually exclusive). When present, returns
  only the per-file diffs for files modified after that timestamp.
- Each `Edit` / `Write` / `MultiEdit` tool card carries a backlink to
  the file viewer (and per-file diff). The file viewer carries a "Show
  in chat" button that scrolls the chat list to the tool_use whose
  `toolUseId` the file was associated with.
- Backlink data: the bridge already emits `tool_use` events with
  `toolUseId` and the file path in `input.file_path`. The mobile
  maintains a `file → [toolUseId]` index per session for the jump.

### FR-10 — Capability negotiation

- Three new fields on `AgentCapabilities`, all booleans, all default to
  `false` on drivers that don't override:
  - `projectBrowser` — `/tree` endpoint supported.
  - `projectSearch` — `/search` endpoint supported.
  - `gitStatus` — `/git/status` and `/git/diff` endpoints supported.
- The Claude Code SDK driver reports all three `true` (cwd is known;
  filesystem + git access are trivial in-process).
- Each new wire frame and HTTP endpoint is gated server-side: a missing
  capability returns `404` with a typed `error` body, not a generic 5xx.
- Mobile reads the capability bits via the existing
  `useSessionCapabilities` hook and hides whole UI surfaces (Files tab
  sections, @-mention picker, etc.) accordingly.

### FR-11 — No magic strings

- Every new wire frame subtype, every new capability key, and every
  enum-like value on the bridge or mobile side is exposed as a named
  constant (`as const satisfies …`), matching the existing
  `SDK_RUN_STATUS` / `COMPACT_TRIGGER` / `PERMISSION_MODES` pattern.
- New constants live in `bridge/src/agents/types.ts` and are mirrored
  in `mobile/lib/types.ts`. A typo in a discriminator becomes a
  type error, not a silently-dropped frame.

### FR-12 — Web parity

- Every new UI surface works on both Expo native and react-native-web.
  Where a primitive needs a `.web.tsx` shim, it's called out in the
  HLA (likely candidates: virtualized file tree on the web side, image
  preview using `<img>` instead of `<Image>` for SVG support).
- The Files tab on web uses mouse + keyboard affordances (click to
  expand, arrow keys in the picker, `Escape` to dismiss) on top of the
  touch ones.

## Success criteria

1. Typing `@compone` in the chat input on mobile shows
   `components/chat/Markdown.tsx` (and similar) as picker entries
   within one network round-trip; tapping inserts the full path.
2. Tapping any file in the "📂 N files changed" pane lands on a screen
   showing only that file's diff (not the cumulative wall).
3. An `Edit` tool card shows a green/red preview within ~250 ms of the
   tool_result landing (or shows a "preview unavailable" caption if the
   diff fetch fails).
4. The Files tab on a Claude Code session shows the git status (with
   any uncommitted changes from outside this session), the session's
   own changes, and the project tree — all in one scroll.
5. Searching for a string from the Files tab returns ripgrep-style
   results; tapping a result opens the file viewer scrolled to the
   matched line.
6. A `.ts` file in the file viewer renders with TypeScript syntax
   highlighting; a `.png` file renders the image; a `.bin` file renders
   the "preview not supported" surface.
7. Pulling up the chat after backgrounding shows a "what's changed
   since you were last here?" chip when relevant; tapping it lands on
   a per-file diff scoped to that range.
8. From any file viewer, a "Show in chat" button scrolls the chat list
   to the tool_use that touched the file.
9. Loading a hypothetical second agent (the existing stub) whose
   capabilities report `projectBrowser: false, gitStatus: false,
   projectSearch: false` hides the Files tab entirely; the chat works
   identically to today; @-mention picker is hidden in the chat input.
10. Bundle-size impact of the chosen syntax-highlighter on the web
    build stays under ~150 KB gzipped (additive; total still well under
    the 6 MB FRD budget for the web client).

## Known unknowns / open questions

These are not yet decided; the HLA captures the current leaning but the
plan should resolve them in the appropriate phase before implementation
locks in:

- **Q1 — Syntax highlighter pick.** `react-native-syntax-highlighter`
  with Prism is the obvious off-the-shelf option, but it pulls in
  Prism's grammars (sizeable). Need to confirm tree-shaking on
  react-native-web. Alternatives: `react-native-highlighter`,
  `react-syntax-highlighter` (web-only fallback wrapped in a
  `.web.tsx`), or a lightweight regex-tokenizer for the top ~5
  extensions. Decision in Phase 6 (syntax) LLD.
- **Q2 — Inline-diff payload caching.** Embedding a diff in every Edit
  card means N fetches for N edits. Options: (a) lazy per card, (b)
  one cumulative fetch + per-card slice, (c) push diffs in-band as a
  new AgentEvent on every file_changed. (a) is simplest; (c) is most
  efficient. Decision in Phase 3 LLD.
- **Q3 — `@`-mention picker corpus.** Two designs: query `/tree` on
  every keystroke (recursive walk) vs. populate from `/search` (file
  paths only) once on focus and filter client-side. Trade-off is
  freshness vs. RTT. Likely: client-side filter from a one-shot
  recursive `/tree` call cached for ~30 s. Decision in Phase 1 LLD.
- **Q4 — Files tab third-page pager interaction.** The existing pager
  is `ChatPreviewPager` and Chat is locked when on the preview side
  (`gestureEnabled: pagerIndex === 0`). The new Files page sits where —
  between Chat and Preview, or after Preview? Decision in Phase 4 LLD.
- **Q5 — Per-turn diff range.** "Since my last message" is one
  interpretation of "what changed since I last looked." "Since
  `lastSeenAt`" is another, depending on app foreground/background.
  Default to message-anchored or wall-clock-anchored? Decision in
  Phase 8 LLD.
- **Q6 — Search debounce vs. submit.** Debounce-as-you-type would be
  ideal but ripgrep cost adds up. Likely: explicit submit (return /
  search icon), debounced suggestions from `/tree` for path prefixes.
  Decision in Phase 5 LLD.
- **Q7 — Git endpoint scope.** Do we limit to "working tree state only"
  in v1, or also surface log / blame / stash / rebase state? Today's
  scope says "status + per-file diff only." Defer the rest to v2.
- **Q8 — Large-file thresholds.** `/file` already truncates; what
  threshold do we set for the new tree and search endpoints to refuse
  serving (e.g. images >5 MB, files >2 MB)? Decision in Phase 5 LLD.
