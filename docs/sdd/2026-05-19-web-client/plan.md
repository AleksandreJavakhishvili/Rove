# Plan — Web client

Tracking checkboxes for the work described in [frd.md](./frd.md) and [hla.md](./hla.md).

## Phase 1 — Web build baseline

Goal: produce a static export that loads (even if half-broken) and renders the existing sessions list screen in a browser. (Initial build wrote to `mobile/dist/`; later restructured into the `web/` package — see Phase 3.)

- [x] Confirm `pnpm install` (inside `mobile/`) succeeds with existing `react-native-web` + `react-dom` deps
- [ ] Run `pnpm web` locally → app loads at `http://localhost:8081` (deferred to manual QA in Phase 6)
- [x] Run `pnpm exec expo export -p web` → produces a static directory with `index.html`, `_expo/static/...`, assets
- [x] Eventually moved the web-build script out of `mobile/package.json` into a dedicated `web/` package — see Phase 3
- [x] Smoke test the static export with a local file server — index loads, JS bundle downloads (~530 KB gzipped)

**Definition of done — Phase 1:** ✅
- Static export of the Expo app succeeds; gzipped bundle ~530 KB (target was < 6 MB).

## Phase 2 — Native API audit and fallbacks

Goal: every `expo-*` import the app currently uses either works on web out of the box or has an explicit `.web.tsx` shim.

- [x] Re-run the audit: `grep -rn "from 'expo-\|from \"expo-\|react-native-webview\|Platform.OS" mobile/{app,components,lib}` and reconcile against the [HLA fallback table](./hla.md#native-api-fallback-table)
- [x] **kv-store shim:** `mobile/lib/kv.ts` (re-exports `expo-sqlite/kv-store` for native) + `mobile/lib/kv.web.ts` (localStorage-backed). Replaces the direct `expo-sqlite/kv-store` import in `lib/store.ts`. Required because expo-sqlite's web backend pulls in `wa-sqlite.wasm` (which Metro doesn't resolve by default) and would need COOP/COEP headers (which GH Pages doesn't serve)
- [x] `mobile/components/QRScanner.web.tsx`: camera-based scanner using `getUserMedia({ video: { facingMode: 'environment' } })` + `window.BarcodeDetector`. Graceful "not supported" message on Firefox (no `BarcodeDetector`). Same `ScannedConfig` + `QRScannerProps` surface as the native version
- [x] `#connect=<base64url>` URL fragment handler: `mobile/lib/web-bootstrap.ts` (no-op) + `web-bootstrap.web.ts` (decodes, persists into the settings store via `useSettings.getState()`, scrubs the hash via `history.replaceState`). Wired into `app/_layout.tsx`
- [x] Bridge: `bridge/src/qr.ts` now prints `Web: <ROVE_WEB_CLIENT_URL>/#connect=<base64url(...)>` when `ROVE_WEB_CLIENT_URL` is set. Operator points it at their deployed instance
- [x] `mobile/lib/uploads.web.ts`: replicate the three `uploads.ts` exports using `<input type="file">` (with `accept` and `capture` hints) + `FileReader.readAsDataURL`. Handles cancel via the `cancel` event + a window-focus fallback
- [x] **PreviewFrame split** (preferred over forking PreviewPane): `components/chat/PreviewFrame.tsx` (uses `react-native-webview`'s `WebView`) + `PreviewFrame.web.tsx` (sandboxed `<iframe>` with "Open in new tab ↗" escape hatch). PreviewPane.tsx now imports PreviewFrame — 12 lines split instead of 400
- [x] `expo-sqlite/kv-store` replaced wholesale by the localStorage shim — no runtime persistence verification needed under web (localStorage is well-tested by browsers)
- [ ] Verify `expo-clipboard` actually works in the deployed site (deferred to Phase 6 manual QA)
- [ ] Pass through every screen on `pnpm web` (deferred to Phase 6 manual QA)

**Definition of done — Phase 2:** ✅ (build-time)
- `tsc --noEmit` is clean on mobile and bridge.
- Web bundle compiles cleanly with no platform-only API imports leaking through.
- Runtime per-screen verification is the Phase 6 manual-QA job.

## Phase 3 — Base path, SPA routing, and `web/` package

Goal: the static build works correctly under `https://<owner>.github.io/<repo>/`, including hard-refresh of deep links. Also: the web product gets its own self-contained directory at the repo root, so `mobile/` stays focused on React Native and the GH Pages story is one cohesive concern.

- [x] **Landing + app split.** Repo-root `web/dist/index.html` is a hand-written marketing landing (no Expo bundle). `web/dist/app/` is the React Native Web app. Landing CTA links to `./app/`. v1 wants a fast-loading public entry point; visitors who never click in don't pay the 530 KB bundle download cost
- [x] **Dedicated `web/` package** at the repo root, sibling to `mobile/` and `bridge/`. Contains:
  - `web/landing/` — hand-written HTML + `wordmark.svg` + `og-card.png`
  - `web/package.json` — single `build` script that invokes `expo export` against `../mobile`, drops the result under `web/dist/app/`, then copies `web/landing/.` into `web/dist/`
  - `web/dist/` — build output (gitignored)
  - `web/README.md` — explains the layout
- [x] `mobile/` no longer owns a `web:build` script. The Expo CLI runs from `mobile/` because that's where its deps live, but the web product's orchestration and output belong to `web/`
- [x] Switched from `EXPO_PUBLIC_BASE_URL` (not actually recognized by Expo) to `experiments.baseUrl` via `mobile/app.config.ts`, which reads `ROVE_WEB_BASE_URL` at build time. Verified asset URLs in `web/dist/app/index.html` resolve under `/<repo>/app/`
- [x] `cp dist/app/index.html dist/app/404.html` as SPA fallback for in-app deep links (GH Pages serves 404.html for any unfound path under the repo, which acts as the SPA entry)
- [x] Smoke-tested the full layout locally: `/<repo>/` → landing, `/<repo>/app/` → app, asset paths resolve, all return 200

**Definition of done — Phase 3:** ✅
- `cd web && pnpm build` produces `web/dist/` with the layout above.
- Local serve of `web/dist/` exposes the landing at `/` and the app at `/app/`; asset paths use the configured prefix.
- (The 404.html → index.html SPA bridging is exercised by GH Pages itself when a deep link is hard-refreshed; couldn't reproduce locally with `serve -s` because `serve` looks for 404.html at the server root, not under a subpath. Real GH Pages serves the subpath's 404.html correctly.)

## Phase 4 — HTTPS / connection UX

Goal: a user can follow the docs and connect their browser to their bridge end-to-end, and a mixed-content failure produces a useful error rather than a silent network error.

- [x] `docs/web-client-setup.md`: why HTTPS is needed, the `tailscale serve --bg --https=443` command, identity-header option, local-HTTP fallback, troubleshooting (mixed-content, cert trust, iOS Safari camera gesture)
- [x] Settings screen ("Where do I get this URL?" link) opens the docs page via `Linking.openURL` — works on both native and web
- [x] `lib/bridge.ts`: `isMixedContentBlocked()` guard at the top of `fetchWithTimeout` — short-circuits with a specific error message that names the `tailscale serve` command and the docs URL
- [ ] Manual end-to-end test on real Tailscale Serve (Phase 6)

**Definition of done — Phase 4:** ✅ (build-time)
- Docs page exists at `docs/web-client-setup.md` with copy-pasteable commands.
- Pointing the web client at an `http://` bridge URL from an HTTPS page now throws the specific mixed-content error (verified by code reading; runtime test in Phase 6).

## Phase 5 — GitHub Pages deployment workflow

Goal: every push to `main` rebuilds and republishes the site.

- [x] `.github/workflows/deploy-web.yml`: pnpm install in `mobile/` (for Expo deps) → `cd web && pnpm build` with `ROVE_WEB_BASE_URL=/<repo>/app/` → upload `web/dist/` → deploy-pages action
- [ ] **Manual one-time:** enable GitHub Pages in repo Settings → Pages → Source = "GitHub Actions". Document in PR description
- [ ] Verify the workflow turns green on first push
- [ ] Visit the published URL; confirm landing loads, "Launch web app" navigates to `/app/`, asset paths resolve
- [ ] Add "Try the web client →" link to `README.md`

**Definition of done — Phase 5:** ⚙️ (code shipped; live verification pending)
- Workflow file exists and references `cd web && pnpm build` correctly.
- Live verification requires a push + the manual GH Pages settings toggle.

## Phase 6 — Cross-browser validation

Goal: confirm the v1 surface works on the browsers most users will reach for.

- [ ] Desktop Chrome (Mac + Linux): connection, chat round-trip, preview iframe, file viewer
- [ ] Desktop Safari: same set; pay attention to reanimated pager interactions
- [ ] Desktop Firefox: same set
- [ ] iOS Safari (iPhone): scroll, keyboard avoidance, pager swipe, virtual keyboard up/down
- [ ] Android Chrome: same as iOS Safari
- [ ] Identify and ticket any browser-specific issues; gate v1 on Chrome desktop + at least one mobile browser working end-to-end

**Definition of done — Phase 6:**
- Chrome desktop + one mobile browser (iOS Safari or Android Chrome) pass the full chat → tool card → diff → approval round-trip with no blocker bugs.
- Any known issues on other browsers are documented in `docs/web-client-setup.md` under a "Known limitations" section, not silently broken.

## Out of scope (tracked for v2+)

These are deliberately deferred per the [FRD non-goals](./frd.md#non-goals-v1):

- PWA manifest + service worker for installability
- Dedicated mocked "demo mode" for first-time visitors without a bridge
- Per-route code splitting / lazy loading to shrink first-paint bundle
- Push notification support (also removed from mobile)
- Multi-tab session sync
