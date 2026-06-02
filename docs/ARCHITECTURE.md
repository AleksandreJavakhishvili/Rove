# Architecture

## High level

```
┌──────────────────────────┐                     ┌────────────────────────────────────────┐
│ Phone / browser (client) │                     │ Each machine on your tailnet           │
│                          │  Tailscale tunnel   │  (run one bridge per machine)          │
│  Bridge[] + aggregator   │  — one connection   │                                        │
│   - unified inbox        │    per machine,     │  bridge (Hono + WebSocket)             │
│   - machine pills        ├──── HTTPS / WSS ───►│   ├─ /health   /peers                  │
│   - filter chips         │    in parallel      │   ├─ /sessions  /sessions/:agent/...   │
│   - in-chat switcher     │◄────────────────────┤   ├─ runtime: drives claude per turn   │
│   - per-session WS        │     … iMac          │   ├─ permission gate → approvals       │
│                          │     … MacBook       │   ├─ file watcher                      │
└──────────────────────────┘     … mac-mini      │   └─ git helpers                       │
                                                 │                                        │
                                                 │  claude (authenticated locally)        │
                                                 │  ~/.claude/projects/.../*.jsonl        │
                                                 │  your repositories                     │
                                                 └────────────────────────────────────────┘
```

Each machine runs its own single-tenant bridge — the central piece *per machine*. A bridge owns:

- **Session discovery** — scans `~/.claude/projects/` and presents a flat list across all your repos.
- **Process lifecycle** — drives `claude` per turn; reaps idle work; enforces single-writer semantics so a desktop terminal and the phone can't simultaneously corrupt the same JSONL.
- **Transport** — HTTP for control plane, WebSocket for the per-session event stream.
- **Auth** — Tailscale identity (preferred — the `Tailscale-User-Login` header that `tailscale serve` injects, no token on the wire), bearer token (fallback), loopback-dev (in-development convenience).
- **Permissions** — approval requests are forwarded to the client over WebSocket and awaited.
- **File watching + git** — emits `file_changed` over WebSocket; `git diff` provides the cumulative session diff against the baseline captured at first spawn.
- **Identity + discovery** — `GET /health` reports a stable per-bridge `bridgeId` and whether the bridge is on the keyless serve path; `GET /peers` enumerates the tailnet so the client can find the *other* machines.

**Aggregation is client-side.** The client holds a `Bridge[]`, opens these connections to every machine in parallel, tags each session with its `bridgeId`, and merges them into one inbox. There's no central server and no cross-machine sync — see [Multi-bridge aggregation](#multi-bridge-aggregation). The client is otherwise a thin presentation layer for the normalized event stream.

## Repo layout

```
.
├── bridge/                  # The desktop daemon
│   ├── bin/rove-bridge.mjs  # CLI entry (npx rove-bridge)
│   ├── src/
│   │   ├── server.ts        # Hono HTTP + WS routes
│   │   ├── runtime.ts       # Per-session subprocess registry + reaper
│   │   ├── auth.ts          # Tailscale-identity / bearer / loopback-dev middleware
│   │   ├── config.ts        # Env-var-driven config
│   │   ├── files.ts         # Path-scoped file reads
│   │   ├── git.ts           # Diff / baseline helpers
│   │   ├── lsof.ts          # `ps`-based attribution of `claude` processes to sessions
│   │   ├── permissions.ts   # Pending-prompt registry + internal token + MCP config
│   │   ├── preflight.ts     # FD-limit + claude-on-PATH startup checks
│   │   ├── qr.ts            # Connection QR printer
│   │   ├── tailscale.ts     # `tailscale status --json` wrapper + /peers enumeration
│   │   ├── types.ts         # Wire-protocol types (mirrored on the mobile side)
│   │   ├── watcher.ts       # chokidar registry
│   │   ├── agents/
│   │   │   ├── types.ts     # AgentDriver / AgentSession / AgentEvent interfaces
│   │   │   ├── registry.ts  # Driver registration + cross-agent session listing
│   │   │   └── claudeCode.ts # Claude Code driver (the one fully-fledged impl)
│   │   └── mcp/
│   │       └── permission-server.ts # Spawned by claude; forwards prompts to bridge
│   └── SETUP.md             # Deployment modes (LAN / Tailscale IP / Tailscale serve+TLS)
├── mobile/                  # Expo React Native app
│   ├── app/                 # Expo Router screens
│   │   ├── index.tsx        # Unified sessions inbox (all machines, needs-me sort)
│   │   ├── machines.tsx     # Machines screen — discovery / reachability / rename
│   │   ├── settings.tsx     # QR scanner + URL/token form (+ connect-time discovery)
│   │   ├── _layout.tsx      # Stack navigator
│   │   └── sessions/[agent]/[id]/
│   │       ├── index.tsx    # Chat screen — the main UI
│   │       ├── file.tsx     # Single-file viewer (syntax-highlighted)
│   │       └── diff.tsx     # Cumulative session diff viewer
│   ├── components/
│   │   ├── QRScanner.tsx    # expo-camera modal
│   │   ├── SessionsSidebar.tsx # In-chat machine/session switcher (chips + grouping)
│   │   └── chat/
│   │       ├── Markdown.tsx       # Markdown + code blocks
│   │       ├── CodeBlock.tsx      # Fenced-code with copy + collapse
│   │       ├── Diff.tsx           # Inline unified diff for Edit tool cards
│   │       ├── ToolCard.tsx       # Per-tool card layouts (Read/Edit/Bash/etc.)
│   │       ├── ApprovalSheet.tsx  # Bottom-sheet for the focused session's permission_prompts
│   │       └── crossSession/      # Other sessions' approvals, in-chat (whisper → badge → tray)
│   └── lib/
│       ├── bridge.ts        # HTTP + WS transport (typed); /health, /peers helpers
│       ├── bridges.ts       # Bridge[] store + migration + per-machine colour
│       ├── aggregator.ts    # Fan-out /sessions across bridges; per-bridge state
│       ├── discovery.ts     # /peers + /health probe → discover bridges; periodic re-scan
│       ├── store.ts         # Settings + per-bridge pending-approval streams (Zustand/kv-store)
│       ├── markdown.ts      # Markdown parsing helpers
│       ├── diff.ts          # Line-level diff algorithm
│       └── types.ts         # Wire-protocol types (mirror of bridge/src/types.ts)
├── docs/
│   ├── ARCHITECTURE.md      # this file
│   └── WIRE_PROTOCOL.md     # WebSocket event schema
├── assets/logo/             # SVG mark + wordmark + app icon
├── LICENSE
├── README.md
└── CONTRIBUTING.md
```

## Key design decisions

### Session = JSONL file on disk

The unit of conversation is the file Claude Code already writes in `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. Both the desktop terminal and our bridge resume sessions through `--resume <uuid>`, so:

- No bridge-specific session storage.
- Continuity across devices for free — any Claude Code invocation (interactive or headless, desktop or our bridge) appends to the same file.
- Multi-user is constrained by who can read those JSONL files (file-system permissions on the desktop) rather than a custom auth system.

### Per-turn subprocess, not long-lived process

`claude -p` exits after each turn even with `--input-format stream-json`. We don't fight that. The bridge:

- Spawns `claude -p --resume <id>` on each user message.
- Pipes the message in via stdin (stream-json line).
- Reads stream-json events from stdout, normalizes them to `AgentEvent`, broadcasts to WebSocket subscribers.
- Lets the subprocess exit naturally on `result`.

This means slightly higher latency per turn (claude's cold start) but radically simpler lifecycle. The idle reaper exists mostly to clean up sessions that errored mid-turn.

### Single-writer guarantee

Two `claude` processes writing to the same JSONL would corrupt history. The bridge:

- At startup of each session, scans `ps` for live `claude` processes (with `--resume <id>` in argv, or running with the session's cwd as their working directory).
- Refuses to spawn if a desktop-owned process is detected, sends `session_busy` to the phone.
- Offers **Take ownership** — the phone can SIGTERM the foreign PID(s) and claim the session.

### MCP permission tool for approvals

In `--print` mode there's no TTY, so claude's built-in approval prompt doesn't run. Instead:

- The bridge spawns claude with `--mcp-config <inline-json>` registering a `rove` MCP server.
- The server has a single tool: `permission_prompt`.
- When claude wants to use a non-allowlisted tool (Bash, Edit, etc.), it calls `mcp__rove__permission_prompt` with `{tool_name, input, tool_use_id}`.
- The MCP server (a stdio process spawned by claude) HTTP-POSTs the bridge's `/internal/permission` endpoint with an internal one-time token.
- The bridge emits a `permission_request` AgentEvent over WebSocket → mobile shows the approval sheet.
- Mobile sends `{type: 'approval', toolUseId, decision}` back over the WebSocket.
- The bridge resolves the pending request, replies to the MCP server, which returns the decision to claude, which then runs (or refuses) the tool.

`updatedInput` in the MCP response echoes the original input unmodified. Claude's schema requires it to be an object — we don't currently let the user edit the tool input from the phone before approving, though the protocol supports it.

### Multi-bridge aggregation

Each machine runs its own single-tenant bridge; aggregating them lives entirely on the **client**. The client keeps a persisted `Bridge[]`, opens a connection to each in parallel, and merges:

- **One inbox.** `/sessions` is fanned out across every bridge with a per-host timeout; results are tagged with a client-assigned `bridgeId` and sorted by what needs you (pending approval ▸ running ▸ recent). A slow or asleep machine never blocks the others — its rows degrade to "offline" and stay visible rather than vanishing.
- **Discovery via one anchor.** `GET /peers` (a `tailscale status --json` wrapper) lets the client enumerate the tailnet from any one bridge it already knows, probe each device's `/health`, and add the ones that are bridges. Self and non-bridge devices fall out of the probe. New machines surface automatically — on connect, and on a periodic re-check while the app is foreground.
- **Identity, not tokens.** `GET /health` reports a stable per-bridge `bridgeId` and a `tailscaleServe` flag. On the serve path the bridge trusts the identity header `tailscale serve` injects (no token crosses the wire); bearer tokens remain the off-tailnet fallback.
- **Per-bridge approval streams.** The cross-session pending-approval stream (`/events`) is opened once per bridge and keyed by `bridgeId`, so the inbox's needs-you signals span every machine and a decision is routed back to the bridge the request came from.

No central server, no relay, no cross-machine session migration — a session lives where its JSONL file is. Routes carry the bridge as a `?bridge=<id>` query param (falling back to the active bridge), so old single-bridge links keep working. Full design: [`docs/sdd/2026-05-26-multi-bridge-aggregator/`](sdd/2026-05-26-multi-bridge-aggregator/).

### Normalized event stream

Every agent driver translates its CLI's native output into the same `AgentEvent` shape. The mobile app speaks only that shape — never sees raw claude / codex / aider output. This is the seam that makes adding a new agent a per-driver task rather than a UI rewrite.

See [`docs/WIRE_PROTOCOL.md`](WIRE_PROTOCOL.md) for the exact schema.

## Non-goals

- **Hosting agents in the cloud.** This project's value is that nothing runs on someone else's infrastructure. If you want cloud convenience, use Happy or similar.
- **A perfect terminal emulator on phone.** We're a phone-native chat client, not an `xterm.js` shell. Use Blink or Termux + tmux + SSH if you want that.
- **Editing tool inputs before approval.** Possible to add (the MCP `updatedInput` field is exactly for this), not built yet.
- **Multi-tenant SaaS.** Each user runs the bridge on their own machine, joins their own tailnet, has their own data. The project is BYO infrastructure.
- **Cross-machine session sync.** A session belongs to the machine whose disk holds its JSONL. The client shows every machine's sessions side-by-side, but doesn't move or merge a session across hosts.
