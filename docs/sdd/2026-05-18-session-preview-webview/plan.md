# Plan — Per-session dev server preview

Tracking checkboxes for the work described in [frd.md](./frd.md) and [hla.md](./hla.md).

## Phase 0 — Repo prerequisites (not strictly part of this feature)

- [ ] `git init` at repo root
- [ ] Root-level `.gitignore` (covering `node_modules`, `.expo`, `dist`, `.env*`)
- [ ] Initial commit + push to `origin/main` (`AleksandreJavakhishvili/Rove`)

## Phase 1 — Bridge port scanner core

File: `bridge/src/devServers.ts` (new)

- [x] Types: `DevServerCandidate`, internal helpers
- [x] `listListeningPorts()` — macOS implementation via `lsof -iTCP -sTCP:LISTEN -P -n -Fpcn`
- [x] `listListeningPorts()` — Linux implementation via `ss -tlnpH`
- [x] Platform detection at module load; one implementation chosen
- [x] `getProcessCwd(pid)` — exported from `lsof.ts` and reused
- [x] `getProcessArgsBatch(pids)` — `ps -p <list> -o pid=,args=` (works on mac + linux)
- [ ] `getProcessStartTime(pid)` — deferred (ranking heuristic, not blocking v1)
- [x] `frameworkLabel(command)` — pattern match per [hla.md framework table](./hla.md#framework-heuristic)
- [x] `isInside(child, parent)` — path containment with `path.sep` guard
- [x] `scanDevServers({ sessionCwd, hostname })` — orchestrator
- [x] Cache lsof/ss output with 2.5s TTL (same pattern as `lsof.ts`)
- [x] Reachability classification + framework-specific `note` strings
- [ ] Smoke test: pending (not run yet — needs a manual session pointing at a project with Vite running)

**Definition of done — Phase 1:**
- Running `scanDevServers({ sessionCwd: <project-with-vite-running> })` returns a Vite candidate with `framework: 'vite'` and a valid `url`.
- With Vite bound to `127.0.0.1`, the same call returns `reachable: false` and a non-empty `note`.

## Phase 2 — Bridge endpoint

File: `bridge/src/server.ts` (edit)

- [x] Add route `GET /sessions/:agent/:id/preview`
- [x] Resolve session by `(agent, id)` (existing pattern from `/sessions/:agent/:id`)
- [x] Resolve hostname from `c.req.url` (the host the phone used to reach us — works for tailnet, LAN, and `tailscale serve` alike)
- [x] Call `scanDevServers`, return `{ hostname, candidates }`
- [x] 404 if session not found
- [x] Applies the same auth middleware as other `/sessions/...` routes (registered after `app.use('*', authMiddleware)`)

**Definition of done — Phase 2:**
- `curl -H 'Authorization: Bearer ...' http://localhost:8443/sessions/claude-code/<uuid>/preview` returns valid JSON with Vite detected when it's running.

## Phase 3 — Mobile transport & state

Files: `mobile/lib/{bridge,types,store}.ts`

- [x] Install `react-native-webview` (added: ^13.16.1)
- [x] Mirror `DevServerCandidate` and `PreviewResponse` in `mobile/lib/types.ts`
- [x] `fetchPreview(cfg, agent, id)` in `mobile/lib/bridge.ts`
- [x] New `usePreviewPrefs` store with `selectedPort: Record<sessionKey, port>` and `customLabels: Record<sessionKey, Record<port, string>>`
- [x] Setters: `setSelectedPort`, `setLabel`, `clearLabel`
- [x] Hydrate via existing `expo-sqlite/kv-store` pattern (`useHydratedPreviewPrefs`)

**Definition of done — Phase 3:**
- From the mobile dev console, calling `getPreviewCandidates(...)` returns the expected JSON.
- Setting and re-reading `selectedPreviewPort` survives an app reload.

## Phase 4 — Mobile pager & preview pane

Files: `mobile/app/sessions/[agent]/[id]/index.tsx` (edit), `mobile/components/chat/PreviewPane.tsx` (new), `mobile/components/chat/ChatPreviewPager.tsx` (new), `mobile/app/_layout.tsx` (edit)

- [x] Horizontal 2-page pager (`ChatPreviewPager`) built on gesture-handler `Gesture.Pan()` + reanimated shared values
- [x] `activeOffsetX([-14, 14])` + `failOffsetY([-12, 12])` so vertical FlatList scroll wins and iOS edge back-swipe is unaffected
- [x] Both pages mounted simultaneously (Animated.View with width × 2)
- [x] `GestureHandlerRootView` added at app root in `_layout.tsx`
- [x] **Post-test tuning:** swapped `withSpring` for `withTiming` (220ms, ease-out cubic) — removed perceived bounciness. Bumped velocity-projection factor to `0.25` for more decisive flicks.
- [x] **Post-test tuning:** disabled gesture while keyboard is visible (`Gesture.Pan().enabled(!keyboardVisible)`) so dragging horizontally while typing doesn't accidentally throw the user to the preview pane.
- [x] `PreviewPane.tsx`:
  - [x] Polling loop using recursive `setTimeout` (paused when `active===false` to save battery)
  - [x] Empty-state component (no candidates) with framework-aware hint
  - [x] Picker component (n≥1 candidates) using chip styling
  - [x] Localhost-only warning component with framework-specific note from the bridge
  - [x] `<WebView>` with `source={{ uri: selected.url }}`, kept mounted across pager swipes
- [x] Persist selection: auto-saves on first detection; tapping a picker entry overwrites
- [ ] Stopped-server state needs polish: today the picker reflects the new set (the stopped one disappears); we don't yet show a "stopped" banner if the *currently-selected* port disappears. Track for Phase 5.

**Definition of done — Phase 4:**
- Swipe right from chat → preview pane visible
- Vite preview loads from tailnet host
- Stop Vite on desktop → within ~6s the pane shows "stopped"
- Restart Vite → within ~6s the WebView reloads with the running UI
- Swipe back to chat → no visible reload; WebView retains scroll/HMR state when swiping forward again

## Phase 4.5 — Custom labels

Files: `mobile/components/chat/PreviewPane.tsx`

- [x] Picker entries render `customLabel || frameworkLabel || "Port ${port}"`
- [x] Pencil glyph (`✎`) edit affordance next to each picker entry
- [x] `RenameModal`: prefilled input with current label, save / cancel / reset-to-auto
- [x] Reset-to-auto clears the custom label, falling back to the framework heuristic
- [x] Saved labels persist via existing `expo-sqlite/kv-store` (`rove:preview-prefs:v1`)
- [x] Documented behavior: labels are keyed by port; a port shift means a new label slot

## Adjacent fixes (uncovered during testing, not part of the original feature)

The first end-to-end test surfaced two pre-existing bugs that the preview feature didn't cause but did expose. Recorded here for the commit history.

### MCP permission flow over HTTPS / tailnet-bound bridge

`bridge/src/permissions.ts` hardcoded `BRIDGE_INTERNAL_URL: http://127.0.0.1:${port}`. Two problems with that assumption when the bridge is on the tailnet:

1. The bridge isn't listening on `127.0.0.1` — `resolveBindHost()` binds to the Tailscale IP. So MCP got `ECONNREFUSED`.
2. The bridge is on HTTPS (Let's Encrypt cert via `tailscale cert`), not HTTP — even if we hit the right address, plain HTTP fetch fails the TLS handshake.

Layered fixes:
- [x] `getMcpConfig` now uses `runtimeState.tailscaleHostname ?? runtimeState.bindHost ?? '127.0.0.1'` and `runtimeState.urlScheme`. Hostname is preferred so TLS validates against the cert cleanly.
- [x] `bridge/src/mcp/permission-server.ts` rewritten to use `node:http` / `node:https` directly with `rejectUnauthorized: false` (fallback safety net for the IP-vs-cert mismatch case). Removed reliance on global `fetch`, which is undici-backed and ignores `NODE_TLS_REJECT_UNAUTHORIZED`.

### Chat list didn't open at the bottom

`onScroll` on the FlatList interpreted the initial layout pass (scroll at offset 0 while content is many viewports tall because history just loaded) as a manual scroll-up, and flipped `stickToBottomRef` to false before the first paint — defeating `onContentSizeChange`'s scroll-to-end.

- [x] Added `userScrolledRef` flag set only by `onScrollBeginDrag`. `onScroll` now ignores its layout-derived verdict until the user has actually touched the list. Initial scroll lands at the bottom; manual scroll-up still works the same.

**Definition of done — Phase 4.5:**
- Three `node` candidates can be renamed to "Admin FE", "Storefront", "API"; the picker shows the custom names.
- Closing and reopening the app preserves the names.
- Resetting a label restores the auto-detected framework label.

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
- **DOD-7.** A user with three same-framework candidates can assign meaningful custom names that persist across app restarts and override the auto-detected labels in the picker.

## Risks & open questions

- **Gesture conflict with iOS back-swipe.** Mitigated by `activeOffsetX([-14, 14])` — the system back-swipe still wins at the screen edge in testing.
- **WebView + HMR over WSS through tailnet hostname.** Some dev servers' HMR clients assume `localhost`. Vite with `--host` handles it; Next may need additional config. Document the workaround in `bridge/SETUP.md` if it bites in real use.
- **Process start time on macOS** parses `lstart` from `ps`, which is locale-dependent. Either set `LC_ALL=C` for the call or defer the feature to v1.1.
- **`react-native-webview` is a native module.** Expo Go cannot load it — users must run `npx expo run:ios` / `run:android` (or use an EAS dev client) first. Confirmed in testing.

## Known limitations (discovered during testing, accept for v1)

- **The scanner cannot see processes owned by a different user.** `lsof` (and `ss`) only expose the current user's file descriptors. If someone runs `sudo npm run dev`, the resulting dev server is owned by root and is invisible to the bridge running as the regular user. Fix: don't run dev servers under sudo (it's never required for unprivileged ports). Worth a line in the README.
- **Dev servers bound to `127.0.0.1` or `::1` cannot be loaded from the phone.** The preview pane shows a framework-specific note instead of a broken WebView. Vite frequently binds to `::1` by default; user must restart with `--host` or set `server.host: true` in their config. Surfaced cleanly by F5; not silently broken.
- **Custom labels do not follow port shifts.** If Vite bumps `5173` → `5174` because the original port is taken, the label remains on the old port slot. Accepted; renaming is cheap.
