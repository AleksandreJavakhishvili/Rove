# HLA — Web client

## High-level diagram

```
                                     ┌────────────────────────────────────────┐
                                     │ Browser (any platform)                 │
                                     │                                        │
                                     │  Static bundle from web/dist/       │
                                     │   ├─ Expo Router (web)                 │
                                     │   ├─ React Native Web                  │
                                     │   ├─ lib/bridge.ts (shared)            │
                                     │   ├─ lib/store.ts (kv-store web)       │
                                     │   └─ components/* (shared, .web.tsx    │
                                     │                   only where needed)   │
                                     └────────────┬───────────────────────────┘
                                                  │
                       fetch + WebSocket (HTTPS / WSS, cross-origin)
                                                  │
                                                  ▼
   ┌─────────────────────────────────────────────────────────────────────────┐
   │ tailscale serve --bg --https=443 → http://localhost:<bridge-port>       │
   │   public name:  https://<host>.<tailnet>.ts.net                         │
   │   cert:         LetsEncrypt via Tailscale MagicDNS                      │
   │   auth in front: --identity-header forwarded to bridge                  │
   └─────────────────────────────────────────────────────────────────────────┘
                                                  │
                                                  ▼
                                       Bridge (Node + Hono) — unchanged
                                                  │
                                                  ▼
                                       claude / codex / etc.

   GitHub Pages publishes web/dist/ at https://<owner>.github.io/<repo>/
   from .github/workflows/deploy-web.yml on every push to main.
```

## Topology

- **One codebase, two outputs.** The existing `mobile/` package builds for iOS, Android, and now web. The web target uses Expo's `metro` + `react-native-web` integration that is already declared in `mobile/package.json`. No new top-level package, no shared-`packages/*` refactor.
- **Static export.** `expo export -p web` produces a fully static `web/dist/` directory. There is no Node runtime in production — the bundle, HTML, and assets ship to GitHub Pages as-is.
- **Browser → bridge is direct.** Same shape as mobile: the browser opens HTTP + WebSocket connections to the bridge over the user's tailnet. The bridge already permits cross-origin requests (`cors({ origin: '*' })` in `bridge/src/server.ts`), so no bridge code change is required for CORS.
- **HTTPS is the user's responsibility.** The web client itself does not solve mixed-content blocking. It documents the supported path (Tailscale Serve, which gives the bridge a `*.ts.net` HTTPS endpoint with a valid public cert) and ships UX that nudges users toward it. See [Mixed-content strategy](#mixed-content-strategy) below.

## Code-sharing strategy

The Metro bundler (which Expo uses for web too) resolves platform-suffixed files in this order on the web target: `Foo.web.tsx` → `Foo.tsx`. On native it resolves `Foo.native.tsx` → `Foo.ios.tsx` / `Foo.android.tsx` → `Foo.tsx`.

Rules of thumb:

- **Default:** write one `Foo.tsx`. React Native primitives (`View`, `Text`, `Pressable`, `ScrollView`, `Image`, `FlatList`, `TextInput`) all have working web equivalents via `react-native-web`. The vast majority of the existing code falls in this bucket and needs zero change.
- **Only split when the underlying API genuinely differs.** E.g., `QRScanner.tsx` uses `expo-camera`'s `CameraView`, which has no meaningful web equivalent. Split to `QRScanner.native.tsx` (existing code) + `QRScanner.web.tsx` (manual paste input + optional `BarcodeDetector`-based fallback).
- **Don't fork wholesale.** If 90% of a component is shared, factor the shared part into a hook or sub-component and only platform-split the divergent leaf.

## Native API fallback table

Every `expo-*` import in `mobile/app/`, `mobile/components/`, and `mobile/lib/` needs an answer here.

| API | Used in | Web behavior |
|-----|---------|--------------|
| `expo-camera` (`CameraView`, `useCameraPermissions`) | `components/QRScanner.tsx` | Split file. `QRScanner.web.tsx` uses `getUserMedia({ video: { facingMode: 'environment' } })` to render a camera preview, then runs `BarcodeDetector` where available (Chromium, recent Safari) or a lazy-loaded `html5-qrcode` (~30 KB gzip) elsewhere. Same prop surface as `QRScanner.native.tsx` — emits the same `onScan(payload)` event. |
| `expo-sqlite/kv-store` | `lib/store.ts` | Expo ships a web implementation that delegates to `localStorage`. No code change expected; verify on first build. |
| `expo-clipboard` | `app/sessions/[agent]/[id]/file.tsx`, `components/chat/CodeBlock.tsx` | Expo's web implementation uses `navigator.clipboard`. Works on HTTPS origins (GH Pages qualifies). No change. |
| `expo-haptics` | (none currently after notification removal) | Defensive: any new use should be wrapped — on web, `Haptics.impactAsync` is a no-op in Expo's web shim. No change needed. |
| `expo-file-system/legacy` (`readAsStringAsync`, `EncodingType`) | `lib/uploads.ts` | Replace path-based reads with `File` / `Blob` reads in a `.web.ts` variant of `uploads.ts`. Use `FileReader.readAsDataURL` for base64 path. |
| `expo-document-picker` | `lib/uploads.ts` | Replace with `<input type="file">` triggered programmatically in the web variant. |
| `expo-image-picker` | `lib/uploads.ts` | Same `<input type="file" accept="image/*">` path. Camera capture on mobile browsers via `capture="environment"`. |
| `expo-web-browser` | (uses TBD on audit) | Web variant: `window.open(url, '_blank', 'noopener,noreferrer')`. |
| `expo-router` | `app/_layout.tsx`, all routes | First-class web support; the relevant concerns are base path and 404 fallback, addressed below. |
| `react-native-webview` (`<WebView>`) | `components/chat/PreviewPane.tsx` | On web, `react-native-web` does not provide `WebView`. Replace with `<iframe>` in `PreviewPane.web.tsx`. Important: many dev servers send `X-Frame-Options: SAMEORIGIN` (Vite/Next default in some configs); document this as a known limitation and surface an "open in new tab" fallback when iframe load fails. |
| `react-native-gesture-handler` + `react-native-reanimated` (pager) | `components/chat/ChatPreviewPager.tsx` | Both have web implementations. Pointer-based pan works for mouse. Acceptable v1 if scroll-vs-swipe arbitration feels slightly different on trackpad. |
| `Platform.OS` checks | `app/settings.tsx`, `app/sessions/[agent]/[id]/index.tsx`, `components/chat/ChatPreviewPager.tsx` | Returns `'web'` in the browser. The existing `=== 'ios'` checks degrade safely (we get the Android/keyboard-height branch on web, which is the correct fallback for `KeyboardAvoidingView`). |

The audit above is the v1 inventory — the plan calls for re-running `grep -rn "expo-\|Platform\.OS\|react-native-webview"` after Phase 1 to catch any imports added between SDD-time and build-time.

## Bootstrap UX — replacing the QR scan

Mobile uses `expo-camera` + the QR code printed by `bridge/src/qr.ts` to bootstrap the connection in one tap. The web client needs an equivalent. Three complementary paths — the right one depends on *where* the user is relative to the bridge:

**1. Deep link from the bridge terminal (best when browser and bridge are on the same machine).**

`bridge/src/qr.ts` already prints a `rove://settings?url=...&token=...` deep link for mobile. We add a second line — a web deep link of the form:

```
Web:   https://<owner>.github.io/<repo>/#connect=<base64url(JSON{url,token})>
```

The web client checks `location.hash` on load. If `#connect=` is present, it decodes the payload, fills the connection screen, attempts the connection, then immediately calls `history.replaceState(null, '', location.pathname)` to scrub the hash. The token only ever lives in the URL fragment, which browsers never send to the server — GitHub Pages' access logs never see it.

Modern terminals (iTerm, Terminal.app, VS Code's terminal) render HTTPS URLs as ⌘-clickable. End-to-end: start the bridge → ⌘-click `Web:` → connected. This is the headline path for the "I'm on the same laptop as my bridge" case — which the QR scan on mobile structurally can't solve (you can't point your own webcam at your own screen).

**2. Camera QR scan from another device (best for cross-device pairing).**

When the web client is open on device A (iPad, second laptop) and the bridge is running on device B with the QR on screen, the camera path is straightforward and exactly mirrors mobile. Implementation:

- Use `window.BarcodeDetector` if present (Chromium, recent Safari) — zero extra bundle weight.
- Fall back to a lazy-loaded `html5-qrcode` (~30 KB gzip) for Firefox and older Safari. Lazy-load means the cost isn't paid until the user taps "Scan QR" in the connection screen.
- Request camera via `getUserMedia({ video: { facingMode: 'environment' } })` so mobile browsers prefer the back camera.

This is genuinely useful — a user on an iPad walking up to their desktop bridge gets the same one-tap connect as the mobile app.

**3. Manual paste (always-works fallback).**

The connection screen exposes two fields, URL and Token, with paste-button affordances. The bridge already prints both in plain text (`URL:` and `Token:` lines in `qr.ts`), so the user can copy and paste even when the deep link isn't clickable and the camera isn't appropriate. Slower but never breaks.

**Default connection screen state:**

- If `location.hash` contains `#connect=...` → consume it, scrub, connect. Skip the form entirely.
- Otherwise → show a form with three affordances: a primary "Connect" button (URL + token fields, manual entry), a secondary "Scan QR" button (opens camera modal), and a hint pointing at the terminal output ("These come from your `rove-bridge` terminal").

## Mixed-content strategy

GitHub Pages serves over HTTPS. A page loaded from `https://<owner>.github.io/<repo>/` cannot `fetch` or `new WebSocket` against `http://100.x.y.z:8443`. The browser blocks it unconditionally — no CORS dance, no extension, no opt-out from page JS.

Supported solutions, in order of preference:

1. **Tailscale Serve (recommended; production path).** The bridge stays HTTP on localhost; the user runs:
   ```
   tailscale serve --bg --https=443 http://localhost:<bridge-port>
   ```
   This gives them `https://<host>.<tailnet>.ts.net` with a real LetsEncrypt cert that the browser trusts. The web client connects to that URL. Tailscale Serve also handles auth header injection if the user opts into `--identity-header`. The docs page in this feature must include a copy-pasteable command and a screenshot of the resulting bridge URL.
2. **Local web build over HTTP (developer / power-user path).** The user clones the repo and runs `pnpm --filter rove-mobile web` locally. The dev server serves on `http://localhost:8081`, which can talk to `http://100.x.y.z:8443` without mixed-content blocking. Useful for contributors and for users who don't want to expose their bridge publicly. Documented but not the headline flow.
3. **Tailscale Funnel (not recommended; mentioned only for completeness).** Exposes the bridge to the public internet over HTTPS. Defeats the "no third-party touch" property that motivates rove. Not part of the supported docs.

The web client's connection UX should detect a likely mixed-content failure (network error to an `http://` bridge URL from an `https://` origin) and surface a specific error: *"Your browser blocked the connection because the bridge is HTTP and this page is HTTPS. Expose your bridge via `tailscale serve` and use the `https://<host>.<tailnet>.ts.net` URL instead, or run the web client locally."* with a link to the docs page.

## Base path and routing on GitHub Pages

GitHub Pages serves the repo at `https://<owner>.github.io/<repo>/`. Two concrete consequences:

- **Asset URLs must include the `/<repo>/` prefix.** Expo's static export supports a `--base-url` flag (or `EXPO_PUBLIC_BASE_URL` / app config). We pass `--base-url /<repo>/` in the build step and read the same value in any place that constructs absolute asset URLs.
- **Deep links 404 without help.** GitHub Pages has no SPA fallback. A hard refresh on `/sessions/claude-code/<id>` returns 404 because the file doesn't exist. Standard workaround: a `404.html` that runs a tiny script to rewrite the URL into a `?p=/sessions/...` query and redirects to `index.html`, which restores the original path on load. Expo Router's web router does not ship this out of the box; we add it as a small static file copied into `dist/` during the build step.

## Deployment workflow

File: `.github/workflows/deploy-web.yml`.

The workflow installs `mobile/`'s deps (Expo CLI lives there), then runs `pnpm build` from the `web/` package. `web/`'s build script invokes `expo export` against `../mobile`, writes the result under `web/dist/app/`, drops `web/landing/.` at `web/dist/`, and copies `index.html` to `404.html` as the SPA fallback. The job uploads `web/dist/` as the Pages artifact.

```
name: deploy-web

on:
  push: { branches: [main] }
  workflow_dispatch:

permissions: { contents: read, pages: write, id-token: write }
concurrency: { group: pages, cancel-in-progress: true }

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10 }
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
          cache-dependency-path: mobile/pnpm-lock.yaml
      - run: pnpm install --frozen-lockfile
        working-directory: mobile
      - run: pnpm build
        working-directory: web
        env:
          ROVE_WEB_BASE_URL: /${{ github.event.repository.name }}/app/
      - uses: actions/upload-pages-artifact@v3
        with: { path: web/dist }

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

`cp dist/app/index.html dist/app/404.html` (inside the `web/` build script) is the simplest viable SPA fallback for GH Pages — when a deep link under `/<repo>/app/` 404s, GH serves `app/404.html`, which is the same SPA entry point, so the client-side router takes over.

Repo settings (one-time, manual): Settings → Pages → Source = "GitHub Actions".

## Tradeoffs and known limitations

- **Bundle size.** RN Web ships shims for the full RN primitive surface. Initial gzipped bundle will likely be 2–4 MB. Acceptable for v1 — code splitting per route is a Metro/Expo concern we defer.
- **WebView ≠ iframe.** The dev-server preview pane uses `<iframe>` on web; sites that send `X-Frame-Options: DENY` or strict CSP `frame-ancestors` won't load. We surface a clear error and an "open in new tab" escape hatch.
- **iOS Safari quirks.** `react-native-reanimated` on web has known edge cases on Safari (specifically around `useSharedValue` + complex transforms). The chat-preview pager is the main user of reanimated; we test it specifically on iOS Safari before shipping.
- **No build-time route prerender.** `expo export -p web` produces a single-page bundle, not pre-rendered HTML per route. Fine for an app, suboptimal for SEO. Out of scope.
- **No demo / mocked-bridge mode in v1.** A visitor without a bridge sees the connection screen and a friendly empty state. A future v2 could ship a "demo mode" with canned data; tracked as a non-goal.
- **No PWA install.** Adding a manifest + service worker is small but out of scope for v1; the install prompt UX is one we want to design intentionally, not as a side effect.

## Open questions

These are non-blocking — they have working defaults but warrant a check during implementation:

- Should the connection screen offer a "Trust this bridge URL for this browser" checkbox that suppresses re-entry on each load? (Default: yes, persist by default and offer "forget" in settings.)
- Do we want a `noindex` meta tag on the deployed site to keep it out of search results? (Default: no — the URL is meant to be discoverable.)
- Do we ship the docs page (`tailscale serve` setup) as a route inside the app, or as a static page on the main project site? (Default: as a route in the app, so first-time users see it without leaving the connection screen.)
