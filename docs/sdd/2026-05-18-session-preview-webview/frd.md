# FRD — Per-session dev server preview

## Summary

Add a per-session preview pane to the rove mobile app that automatically shows the running frontend (or any HTTP dev server) associated with the session's project, accessible by swiping right from the chat.

## Motivation

Today, when a user is iterating on a UI from their phone, they can drive the agent and read tool output but cannot see what the agent has built. The current workflow is "wait until I'm back at my desk to look." Because both phone and desktop are on the same tailnet, the bridge can detect dev servers running on the desktop and surface them to the phone with no extra infrastructure — a capability hosted-relay competitors (Happy etc.) structurally cannot offer.

## Personas

- **Solo developer iterating on a frontend while away from desk.** Has `pnpm dev` running on their laptop, wants to ask the agent to make changes and see them.
- **Multi-project developer.** Runs several dev servers across monorepo packages; wants the right one to appear per session without manual configuration.
- **Backend + frontend developer.** Runs both an API and a frontend dev server in the same repo; wants to pick which one to preview and have that choice remembered.

## User stories

1. **Auto-detect existing servers.** As a user, when I open a chat session whose project already has a running dev server, the preview pane should show that running UI without me configuring anything.
2. **Detect newly-started servers.** As a user, when I (or the agent) start `pnpm dev` mid-session, the preview should appear within a few seconds.
3. **Pick from multiple candidates.** As a user, when more than one server is detected in the project's cwd, I should be able to choose which to preview, and that choice should be remembered for the session.
4. **Localhost-only warning.** As a user, when a server is bound only to `127.0.0.1` and unreachable from my phone, I should see a clear message explaining what to change, not a broken WebView.
5. **Swipe to access.** As a user, I should reach the preview pane by swiping right from the chat (without fighting the iOS back-swipe gesture).
6. **State preservation.** As a user, swiping between chat and preview should preserve the WebView's loaded page so HMR state survives.
7. **Disappearance handling.** As a user, when the dev server stops, I should see a "server stopped" state, not a frozen WebView.

## Functional requirements

| ID | Requirement |
|----|-------------|
| F1 | Bridge auto-discovers dev servers per session — no per-session configuration required. |
| F2 | Discovery is scoped: only servers whose process cwd is inside the session's cwd appear. |
| F3 | Phone polls the bridge every ~3s while the chat screen is mounted (v1; push-based may come later). |
| F4 | When multiple candidates exist, mobile shows a picker; selection persists per session across app restarts. |
| F5 | Servers bound to loopback only (`127.0.0.1`, `::1`) are surfaced with an explicit warning instead of attempting WebView load. |
| F6 | Chat and preview panes stay mounted simultaneously; swiping between them does not unmount the WebView. |
| F7 | When zero candidates are detected, the preview pane shows an empty state with a framework-aware hint when possible. |
| F8 | Framework heuristic identifies common dev servers from the process command line: Vite, Next.js, Astro, generic Node. |

## Non-goals (v1)

- Restricting detection to agent-started servers only — the common case is user-started servers; detection is impractical and confines the feature.
- Push-based updates over the existing WebSocket — polling is simpler; push is a v2 candidate.
- Starting dev servers from the phone — out of scope.
- Authenticated, HTTPS-only, or certificate-pinned dev servers — out of scope; standard `npm run dev` HTTP only.
- Editing dev-server bind address from the phone — surface the warning, but require the user to fix it on the desktop.

## Success criteria

- A user with Vite running in their project, opening that project's chat from their phone, sees the live UI in the preview pane within 5 seconds of opening the chat, with zero configuration.
- A user with two dev servers (API + frontend) running in the same project sees both in the picker and can switch between them.
- Time-to-first-paint of the chat screen is not measurably affected (preview is fetched asynchronously off the chat-render path).
