# FRD — Web client (rove in a browser)

## Summary

Ship a browser-based rove client that reuses the existing Expo / React Native codebase via React Native Web, deployed as a static site to GitHub Pages. No parallel web codebase — the same components, hooks, and bridge client power both surfaces.

## Motivation

Today, driving an agent from anywhere other than your own laptop means installing the iOS / Android app and signing into Tailscale on a personal device. For users on a loaner machine, a coworking iMac, a Linux desktop without TestFlight, or simply an iPad they'd rather drive from Safari, that gate is enough friction to push them back to ssh + tmux.

A web client closes that gap without doubling the maintenance surface. The mobile app already declares `react-native-web` and ships an `expo start --web` script; the architectural question is not "is it possible" but "what does the connection model look like when the origin is HTTPS and the bridge is HTTP-on-tailnet."

A public, browsable URL also doubles as a marketing artifact: a visitor can click the GitHub Pages link, see the actual UI (with a mocked or demo connection), and understand what rove is in 5 seconds rather than reading the README.

## Personas

- **Borrowed-laptop user.** Away from their own machine, doesn't want to install an app, has a phone with Tailscale and a browser tab open — wants to drive their home bridge from the borrowed laptop's browser.
- **iPad / tablet user.** Prefers Safari over App Store install, wants the same chat + preview UX.
- **Curious visitor.** Lands on the README, clicks "Try the web demo" — wants to poke at the UI without setting up a bridge.
- **Contributor.** Hacks on a component once, sees it land on both mobile and web automatically.

## User stories

1. **Open in browser.** As a user, I open `https://<owner>.github.io/<repo>/` and see the rove UI in my browser.
2. **Connect to my bridge.** As a user with a running bridge on my tailnet, I can enter the bridge URL + token in a connection screen and reach my sessions list — provided my bridge is exposed via HTTPS (see HLA for the recommended Tailscale Serve setup).
3. **Same UX as mobile.** Sessions list, chat thread, tool cards, diffs, approval bottom sheets, file viewer, dev-server preview pane all behave the way they do on mobile, adjusted for mouse + keyboard where appropriate.
4. **One-click connect from the bridge terminal.** As a user starting `rove-bridge` in my terminal, I see a clickable web link in the printed connection block (e.g., `https://<owner>.github.io/<repo>/#connect=<encoded>`). ⌘-clicking it opens the web client with the bridge URL + token pre-filled and the connection already attempted — no scanning, no typing.
5. **Manual paste fallback.** As a user on a different machine from the bridge (terminal isn't clickable, or I'm pasting into a browser on a borrowed laptop), I can copy the URL and token printed by the bridge into a two-field connection screen.
6. **Camera QR scan when available.** As a user on a browser that exposes `getUserMedia` + a barcode-detection capability (Chromium with camera permission), I can still scan the QR. Unsupported elsewhere — manual entry / deep link are the primary paths.
7. **Persistent preferences.** Bridge URL, auth token, theme, per-session preview selections survive a browser reload and a tab close-and-reopen.
8. **One codebase.** As a contributor, I change a single file and see the change on iOS, Android, and web — I don't need to remember a parallel web component.
9. **Public demo entry point.** As a first-time visitor, I land on the site and see the chat UI with an obvious "demo mode" or empty-connection state — the page doesn't immediately fail with a connection error.

## Functional requirements

| ID | Requirement |
|----|-------------|
| F1 | `cd web && pnpm build` produces a static site in `web/dist/` deployable to GitHub Pages. The build internally invokes `expo export` against `../mobile`. |
| F2 | No parallel web source tree. Web-specific divergence lives only in platform-suffixed files (`Foo.web.tsx` / `Foo.native.tsx`) where the underlying APIs genuinely differ. |
| F3 | Every native-only API used by the mobile app has a working web behavior — either via Expo's built-in web support or an explicit `.web.tsx` shim (see [HLA fallback table](./hla.md#native-api-fallback-table)). |
| F4 | Bridge URL, auth token, and per-session preferences persist across reloads in the browser (via `expo-sqlite/kv-store`'s web backend or an equivalent localStorage/IndexedDB layer). |
| F5 | The site assumes a `/<repo>/` base path so absolute asset URLs and Expo Router links resolve correctly on `*.github.io`. |
| F6 | Client-side routing under static hosting: a hard refresh of a deep link (e.g., `/sessions/claude-code/<id>`) resolves to the right screen, not a GH Pages 404. |
| F7 | When the user lands without a configured bridge, the app shows a clear empty/connection screen — not a runtime error toast. |
| F8 | A GitHub Actions workflow builds and deploys to GitHub Pages on every push to `main`. |
| F9 | Connection over HTTPS is documented end-to-end: the user can follow a single guide to expose their HTTP bridge as `https://<host>.<tailnet>.ts.net` and have the web client connect successfully. |
| F10 | The bridge's connection-info terminal output includes a web deep link of the form `https://<owner>.github.io/<repo>/#connect=<base64-encoded url+token>`. Clicking it opens the web client with credentials pre-filled. The token sits in the URL fragment (never sent to GH Pages) and is scrubbed from the address bar via `history.replaceState` after the web client consumes it. |

## Non-goals (v1)

- **PWA install / offline mode.** The web client is online-only in v1. Service worker, manifest install prompts, and offline cache are deferred.
- **HTTP-bridge mixed-content workaround in the GH Pages build.** We do not ship a relay, proxy, or browser extension. Users either expose their bridge over HTTPS (via Tailscale Serve) or run the web build locally over plain HTTP. See HLA.
- **Custom URL schemes / deep-link handoff.** No `rove://` link handling, no Universal Links — these are mobile concerns.
- **Push notifications.** Already removed on mobile (per `f345976`); web push is not in scope here either.
- **Multi-tab session sync.** Opening the same session in two tabs may double-poll; we don't attempt to dedupe.
- **Native-feel gestures with no mouse analog.** The chat ↔ preview pager works on touch and on click-drag, but we don't reinvent it for keyboard navigation in v1.
- **First-class iOS Safari mobile-web parity for every interaction.** We will test it; we won't gate the release on every animation feeling identical.
- **Dedicated demo mode with mocked data.** The README link will surface the same connection screen real users see; a separate mocked-bridge demo is a v2 candidate.

## Success criteria

- A user with a running bridge exposed via `tailscale serve` opens the deployed URL on a fresh browser, enters their `https://<host>.<tailnet>.ts.net` URL + token, and lands on their sessions list within 10 seconds.
- A user sending a prompt from the web client receives streamed tool calls, diffs, and approval prompts identical in content to what the mobile client shows for the same session.
- A contributor edits one chat-message component file and observes the change on iOS simulator and `pnpm web` simultaneously, with no parallel edit required.
- The `web/dist/` output is < 6 MB gzipped after Expo's static export (target — not a hard gate).
- The GitHub Pages workflow turns green on `main` and the resulting URL serves the latest build within 2 minutes of merge.
