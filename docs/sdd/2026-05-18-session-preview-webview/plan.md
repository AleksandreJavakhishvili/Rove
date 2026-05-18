# Plan — Per-session dev server preview

Tracking checkboxes for the work described in [frd.md](./frd.md) and [hla.md](./hla.md).

## Phase 0 — Repo prerequisites (not strictly part of this feature)

- [ ] `git init` at repo root
- [ ] Root-level `.gitignore` (covering `node_modules`, `.expo`, `dist`, `.env*`)
- [ ] Initial commit + push to `origin/main` (`AleksandreJavakhishvili/Rove`)

## Phase 1 — Bridge port scanner core

File: `bridge/src/devServers.ts` (new)

- [ ] Types: `DevServerCandidate`, internal helpers
- [ ] `listListeningPorts()` — macOS implementation via `lsof -iTCP -sTCP:LISTEN -P -n`
- [ ] `listListeningPorts()` — Linux implementation via `ss -tlnp`
- [ ] Platform detection at module load; one implementation chosen
- [ ] `getProcessCwd(pid)` — extract from `lsof.ts` into a shared helper if needed, otherwise reuse
- [ ] `getProcessCommand(pid)` — `ps -p <pid> -o args=` (mac) / `/proc/<pid>/cmdline` (linux)
- [ ] `getProcessStartTime(pid)` — for ranking; can be deferred to v1.1 if it slows things down
- [ ] `frameworkLabel(command)` — pattern match per [hla.md framework table](./hla.md#framework-heuristic)
- [ ] `isInside(child, parent)` — path containment with `path.sep` guard
- [ ] `scanDevServers({ sessionCwd, hostname })` — orchestrator
- [ ] Cache lsof/ss output with 2.5s TTL (same pattern as `lsof.ts`)
- [ ] Reachability classification + framework-specific `note` strings
- [ ] Smoke test: from a Node REPL, spawn a temp `http.createServer().listen(0, '0.0.0.0')` in a known cwd, call `scanDevServers` with that cwd, assert the candidate is detected

**Definition of done — Phase 1:**
- Running `scanDevServers({ sessionCwd: <project-with-vite-running> })` returns a Vite candidate with `framework: 'vite'` and a valid `url`.
- With Vite bound to `127.0.0.1`, the same call returns `reachable: false` and a non-empty `note`.

## Phase 2 — Bridge endpoint

File: `bridge/src/server.ts` (edit)

- [ ] Add route `GET /sessions/:agent/:id/preview`
- [ ] Resolve session by `(agent, id)` (existing pattern from `/sessions/:agent/:id`)
- [ ] Look up the session's cwd and the bridge's hostname (reuse whatever `/sessions` or `qr.ts` uses)
- [ ] Call `scanDevServers`, return `{ hostname, candidates }`
- [ ] 404 if session not found
- [ ] Apply the same auth middleware as other `/sessions/...` routes

**Definition of done — Phase 2:**
- `curl -H 'Authorization: Bearer ...' http://localhost:8443/sessions/claude-code/<uuid>/preview` returns valid JSON with Vite detected when it's running.

## Phase 3 — Mobile transport & state

Files: `mobile/lib/{bridge,types,store}.ts`

- [ ] Install `react-native-webview` (`pnpm add react-native-webview` in `mobile/`)
- [ ] Mirror `DevServerCandidate` in `mobile/lib/types.ts`
- [ ] `getPreviewCandidates(agent, id)` in `mobile/lib/bridge.ts`
- [ ] Add `selectedPreviewPort: Record<string, number>` to the Zustand store; setter `setSelectedPreviewPort(sessionId, port)`
- [ ] Hydrate via existing persistence (expo-sqlite/kv-store)

**Definition of done — Phase 3:**
- From the mobile dev console, calling `getPreviewCandidates(...)` returns the expected JSON.
- Setting and re-reading `selectedPreviewPort` survives an app reload.

## Phase 4 — Mobile pager & preview pane

Files: `mobile/app/sessions/[agent]/[id]/index.tsx` (edit), `mobile/components/chat/PreviewPane.tsx` (new)

- [ ] Horizontal 2-page pager wrapper using `Animated` + gesture-handler `PanGesture`
- [ ] Gesture is content-area-only (avoid the left edge so iOS back-swipe still works)
- [ ] Both pages mounted simultaneously (no unmount on swipe)
- [ ] `PreviewPane.tsx`:
  - [ ] `useEffect` polling loop: `setInterval(fetchCandidates, 3000)` + immediate fetch on mount + cleanup on unmount
  - [ ] Empty state component (no candidates)
  - [ ] Picker component (n>1 candidates) using existing chip/button styles
  - [ ] Localhost-only warning component with framework-specific note
  - [ ] `<WebView>` with `source={{ uri: selected.url }}`, kept mounted across pager swipes
- [ ] Persist selection: when picker is tapped, call `setSelectedPreviewPort`; on mount, restore the saved port if still present in candidates
- [ ] Stopped-server state: candidate disappears between polls → show "Dev server stopped"; keep last-known URL displayed until the user re-selects

**Definition of done — Phase 4:**
- Swipe right from chat → preview pane visible
- Vite preview loads from tailnet host
- Stop Vite on desktop → within ~6s the pane shows "stopped"
- Restart Vite → within ~6s the WebView reloads with the running UI
- Swipe back to chat → no visible reload; WebView retains scroll/HMR state when swiping forward again

## Phase 5 — Polish (defer if time-boxed)

- [ ] Small framework icon next to picker entries
- [ ] Skeleton loader during first fetch
- [ ] Manual reload button on the WebView (covers cases where the dev server is up but mid-build)
- [ ] Telemetry-free metric in the bridge log: how often candidates change, p50 scan latency (dev-only)

## Overall definition of done

- **DOD-1.** With Vite running in the project, opening that session's chat from the phone shows the running UI in the preview pane within 5 seconds, no configuration.
- **DOD-2.** With no server running, the preview pane shows an empty state.
- **DOD-3.** With two servers (e.g., API + Vite) in the same cwd, both appear in the picker; the chosen one persists across app restarts.
- **DOD-4.** With a localhost-only-bound server, the pane shows the framework-aware warning instead of a broken WebView.
- **DOD-5.** Swiping between chat and preview preserves both panes' state.
- **DOD-6.** Adding this feature does not regress chat screen first-paint latency (scan happens off-path; the chat doesn't await `/preview`).

## Risks & open questions

- **Gesture conflict with iOS back-swipe.** Mitigation: pager gesture starts X-px in from the left edge. To confirm during Phase 4 testing.
- **WebView + HMR over WSS through tailnet hostname.** Some dev servers' HMR clients assume `localhost`. Vite handles `--host` correctly; Next may need additional config. Document the workaround in `bridge/SETUP.md` if it bites.
- **Process start time on macOS** parses `lstart` from `ps`, which is locale-dependent. Either set `LC_ALL=C` for the call or defer the feature to v1.1.
- **`react-native-webview` is a heavy dep** (native module → requires a fresh EAS build for users on production builds; Expo Go still works for dev). Note in `mobile/README.md`.
