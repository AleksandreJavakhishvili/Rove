# rove-bridge

Bridges a phone (over Tailscale) to a local `claude` CLI (or other coding-agent CLI). Lives on your desktop next to the agent.

```bash
cd bridge
pnpm install
pnpm start
```

That's the whole thing. The bridge:

- Raises its own file-descriptor limit.
- Listens on `127.0.0.1:8443` (override with `HOST` / `PORT` env vars).
- Auto-detects your Tailscale device-owner email and uses it as the allowlist (override with `ALLOWED_USERS=`).
- Runs claude in-process via `@anthropic-ai/claude-agent-sdk`, streams normalized events back over WebSocket.
- Routes tool-permission prompts through the SDK's `canUseTool` callback to the phone — no subprocess hop.
- Prints a QR code with the right connection URL for the mobile app to scan.

## Run modes

See [`SETUP.md`](SETUP.md) for the three deployment shapes:

- **LAN** — same wifi, bearer-token auth.
- **Tailscale IP** — works from anywhere, bearer-token auth.
- **Tailscale serve + TLS** — HTTPS, auth via Tailscale identity headers, no token. Recommended.

## Architecture

- `src/server.ts` — Hono HTTP + WebSocket. Routes for `/sessions`, `/sessions/:agent/:id/{history,stream,interrupt,takeover,diff,file,fork}`.
- `src/runtime.ts` — Per-session registry. Lifecycle: lazy on first message, idle reaper after 5 min.
- `src/agents/` — `AgentDriver` interface, the SDK-backed Claude Code driver, and an optional stub agent fixture for multi-agent UI regression. Each driver knows how to discover its sessions, read history, run the agent, and emit normalized `AgentEvent`s + a capability snapshot.
- `src/permissions.ts` — Pending-prompt registry shared by every driver. The SDK driver's `canUseTool` callback awaits on this; the WS approval handler resolves it.
- `src/tailscale.ts` — Calls `tailscale status --json` and `tailscale serve status --json` to detect the owner email + HTTPS-serve state.
- `src/qr.ts` — Prints the connection QR on startup.

## API surface (wire protocol)

See [`../docs/WIRE_PROTOCOL.md`](../docs/WIRE_PROTOCOL.md) for the full WebSocket event schema.

HTTP routes:

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness probe, returns identified user |
| GET | `/agents` | List registered agents and availability |
| GET | `/sessions` | All sessions across all agents, sorted by recency |
| GET | `/sessions/:agent/:id/history?limit=N&before=ISO` | Paginated history (oldest-first) |
| POST | `/sessions/:agent/:id/interrupt` | Interrupt the running query (graceful) |
| POST | `/sessions/:agent/:id/takeover` | Kill any desktop `claude` holding the session, claim it |
| POST | `/sessions/:agent/:id/fork` | Capability-gated: fork the session into a new ID |
| GET | `/sessions/:agent/:id/file?path=...` | Read a file scoped to the session's cwd |
| GET | `/sessions/:agent/:id/diff` | Cumulative session diff (since baseline at first spawn) |
| WS | `/sessions/:agent/:id/stream` | Bidirectional event stream |
| WS | `/events` | Bridge-wide pending-permission stream for the sessions list |

## Auth

- **Tailscale identity** (preferred): when fronted by `tailscale serve`, the bridge reads `Tailscale-User-Login` headers and validates against `ALLOWED_USERS` (or the auto-detected device-owner when unset).
- **Bearer token**: set `BEARER_TOKEN=<value>` and pass as either `Authorization: Bearer <value>` or `?token=<value>` (query string is used by mobile WebSockets since RN can't set custom headers).
- **Loopback dev**: when bound to `127.0.0.1`, any local request is accepted as `local-dev` (development affordance only).

## Env vars

| Var | Default | Notes |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address. Set `0.0.0.0` for LAN, or your Tailscale IP. |
| `PORT` | `8443` | |
| `ALLOWED_USERS` | (auto-detect from Tailscale) | Comma-separated emails. |
| `BEARER_TOKEN` | unset | If set, accepts requests with this token. |
| `CLAUDE_BIN` | `claude` | Path to the claude binary. |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | |
| `PERMISSION_MODE` | `default` | Pass-through to `claude --permission-mode`. |
| `AUTO_ALLOW_TOOLS` | `Read Grep Glob Ls WebSearch` | Pre-approved tools (no prompt). |
| `HISTORY_MAX_ENTRIES` | `50` | Max entries returned per history page. |
| `IDLE_TIMEOUT_MS` | `300000` | Idle reaper threshold per session. |
| `STUB_AGENT` | unset | Set to `1` to register a stub agent for multi-agent UI testing. |
