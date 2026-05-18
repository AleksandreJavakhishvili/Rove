# Contributing

Thanks for considering a contribution. This project is small and unopinionated — practical patches over big rewrites.

## Dev setup

Requirements:

- Node 22+
- pnpm 10+
- Tailscale (for any phone-side work; not needed for bridge-only changes you can `curl`-test)
- `claude` CLI installed and logged in
- Xcode (for iOS dev) or Android Studio (for Android dev) if you're building the mobile app standalone

Clone, install, run:

```bash
git clone <repo-url> rove
cd rove

# Bridge — terminal 1
cd bridge && pnpm install && pnpm start

# Mobile — terminal 2 (uses Expo Go for dev)
cd ../mobile && pnpm install && pnpm start
```

## What's where

- `bridge/src/agents/` — the abstraction layer that lets us support multiple coding-agent CLIs. If you're adding Codex / Aider / Gemini / something else, this is the only directory you should need to touch.
- `bridge/src/server.ts` — HTTP routes, WebSocket upgrade, the MCP permission-prompt endpoint.
- `bridge/src/runtime.ts` — Per-session subprocess registry with idle reaper.
- `bridge/src/mcp/permission-server.ts` — Standalone MCP stdio server that claude spawns; forwards permission requests back to the bridge over HTTP.
- `mobile/app/` — Expo Router screens.
- `mobile/components/chat/` — message rendering: markdown, code blocks, diff, tool cards, approval sheet, QR scanner.
- `mobile/lib/bridge.ts` — typed HTTP + WebSocket client.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full layout.

## Code style

- TypeScript strict mode on both sides. `pnpm typecheck` in each package.
- Two-space indentation, single quotes, no semicolons-mode wars — match the surrounding file.
- No comments that explain WHAT the code does (the code itself does that); reserve comments for WHY a non-obvious decision was made.
- Don't add dependencies casually. The mobile app especially has a tight budget — every native dependency complicates builds.

## Adding a new agent driver

1. **Read `bridge/src/agents/types.ts`** — the `AgentDriver` interface defines exactly what you need to implement.
2. **Copy `bridge/src/agents/claudeCode.ts`** as a template. The hard parts are:
   - Finding the agent's session storage (where it persists conversation history).
   - Parsing the agent's per-line stream output into our normalized `AgentEvent` schema. See [`docs/WIRE_PROTOCOL.md`](docs/WIRE_PROTOCOL.md).
   - Spawning the agent's CLI in a headless / non-interactive mode that emits structured output.
3. **Register your driver** in `bridge/src/agents/registry.ts`.
4. **Optional: tailored tool cards.** If the agent has named tools (Bash, Edit, etc.), add cases to `mobile/components/chat/ToolCard.tsx` for nicer rendering. Generic JSON-dump fallback already works.
5. **Test end-to-end** — open a session of that agent from your phone, run a prompt, verify history loads.

## PRs

- Branch from `main`.
- Run `pnpm typecheck` in `bridge/` and `pnpm exec tsc --noEmit` in `mobile/` before submitting.
- Keep PRs focused. Driver implementation, perf fix, UX tweak — pick one per PR.
- Describe the user-visible change in the PR body. Screenshots / short clips for mobile UI changes are appreciated.

## Issues

When filing a bug:

- Tell us which deployment mode you're in (LAN / Tailscale IP / Tailscale serve).
- Bridge terminal output (the `[bridge]` and `[claude ...]` lines) is the single most useful thing.
- Mobile Expo console output if it's a UI issue.

## Code of conduct

Be kind. Disagree with the technical decision, not the person. The maintainers reserve the right to lock or remove discussions that get hostile.
