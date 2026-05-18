# HLA — Per-session dev server preview

## High-level diagram

```
┌──────────────────────────────────┐                   ┌───────────────────────────────────────────┐
│ Mobile (Expo RN)                 │                   │ Bridge (Node + Hono)                      │
│                                  │                   │                                           │
│  Chat screen                     │                   │  GET /sessions/:agent/:id/preview         │
│   ├─ Pager (gesture-handler +    │   poll 3s         │   ├─ resolve sessionCwd                   │
│   │   reanimated)                ├──────────────────►│   ├─ scanDevServers({ cwd, hostname })    │
│   ├─ Page 1: Chat (existing)     │   GET /preview    │   │    ├─ listListeningPorts()            │
│   └─ Page 2: PreviewPane         │                   │   │    │    └─ lsof (mac) / ss (linux)    │
│        ├─ Picker (multi-cand)    │ ◄─────────────────┤   │    ├─ getProcessCwd(pid) per match    │
│        ├─ Localhost warning      │   JSON candidates │   │    └─ frameworkLabel(command)         │
│        └─ WebView                │                   │   └─ return { candidates, hostname }      │
│                                  │                   │                                           │
└──────────────────────────────────┘                   └───────────────────────────────────────────┘
        │                                                       │
        └─────────── direct via tailnet ──────────────────────► dev server (port N on desktop)
                     (WebView loads http://<host>:<port>)
```

## Topology

- The bridge does the detection (it lives next to the dev servers).
- The mobile WebView connects to the dev server **directly** over the tailnet — *not* through the bridge. The bridge only tells the phone "there is a Vite server on port 5173"; the phone loads `http://<tailnet-host>:5173` itself.
- This keeps the bridge out of the data path for dev-server traffic (which would be heavy: HMR websockets, source maps, large bundles). The bridge is a discovery service, not a proxy.

## Components

### New bridge module: `bridge/src/devServers.ts`

Public API:

```ts
export interface DevServerCandidate {
  port: number;
  pid: number;
  bindAddress: string;        // "127.0.0.1" | "0.0.0.0" | "::" | specific IP
  framework: string | null;   // "vite" | "next" | "astro" | "node" | null
  command: string;            // raw process cmdline (truncated)
  reachable: boolean;         // false if bindAddress is loopback-only
  url: string | null;         // null when !reachable
  startedAt: number | null;   // process start epoch, for ranking
  note?: string;              // optional hint, e.g., "bound to localhost"
}

export async function scanDevServers(opts: {
  sessionCwd: string;
  hostname: string;
}): Promise<DevServerCandidate[]>;
```

Internal building blocks:

```ts
listListeningPorts(): Promise<{ pid: number; port: number; bindAddress: string }[]>
getProcessCwd(pid: number): Promise<string | null>   // reuse from lsof.ts
getProcessCommand(pid: number): Promise<string | null>
getProcessStartTime(pid: number): Promise<number | null>
frameworkLabel(command: string): string | null
```

Cache pattern: same 2.5s TTL approach as `lsof.ts` to avoid forking `lsof`/`ss` on every poll.

### New bridge endpoint

`GET /sessions/:agent/:id/preview` → `{ hostname: string, candidates: DevServerCandidate[] }`

Wires together: session lookup → `scanDevServers` → JSON response. Returns 404 if session not found, empty `candidates` array if no servers detected.

### Mobile changes

- `mobile/app/sessions/[agent]/[id]/index.tsx`: wrap content in a 2-page horizontal pager built on `react-native-gesture-handler` + `react-native-reanimated` (both already installed). Page 1 = existing chat UI. Page 2 = `<PreviewPane>`.
- `mobile/components/chat/PreviewPane.tsx` (new): polling, picker, WebView, empty/warning states.
- `mobile/lib/bridge.ts`: add `getPreviewCandidates(agent, id)`.
- `mobile/lib/types.ts`: mirror `DevServerCandidate`.
- `mobile/lib/store.ts`: persist `selectedPreviewPort: Record<sessionId, number>`.

### New dependency

- `react-native-webview` (mobile only). No new bridge dependencies.

## Platform specifics

| Concern | macOS | Linux |
|---------|-------|-------|
| List listening TCP | `lsof -iTCP -sTCP:LISTEN -P -n` | `ss -tlnp` |
| Process cwd | `lsof -a -d cwd -p <pid> -Fn` | `readlink /proc/<pid>/cwd` |
| Process cmdline | `ps -p <pid> -o args=` | `cat /proc/<pid>/cmdline` (NUL-separated) or `ps` |
| Process start | `ps -p <pid> -o lstart=` | `stat /proc/<pid>` or `ps -o lstart=` |

Detect platform once at module load. Linux path is significantly faster (`ss` ~5ms vs `lsof` ~50-150ms).

## Containment matching

```ts
function isInside(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}
```

A process at cwd `/Users/ako/projects/app/packages/web` is inside session cwd `/Users/ako/projects/app`. The `path.sep` guard prevents false positives on prefix-shared sibling paths like `/Users/ako/projects/app2`.

## Framework heuristic

Sequential pattern-matching on command line, first match wins:

| Pattern | Framework |
|---------|-----------|
| `/vite\b/` (anywhere in argv) | `vite` |
| `/next-server/` or `/next.*\bdev\b/` | `next` |
| `/astro\b.*\bdev\b/` | `astro` |
| `/webpack-dev-server/` | `webpack` |
| `/parcel\b.*\bserve\b/` | `parcel` |
| `/\bbun\b.*--hot/` | `bun` |
| `/^node\b/` (fallback) | `node` |
| (anything else) | `null` |

The framework label is cosmetic — discovery doesn't depend on it. If we mislabel, the candidate still works, just looks generic.

## Reachability

`bindAddress` ∈ {`127.0.0.1`, `::1`, `localhost`} → `reachable: false`, `url: null`, surface a `note` with framework-specific hint:

- Vite: "Restart with `vite --host` or set `server.host: true`."
- Next.js: "Restart with `next dev -H 0.0.0.0`."
- Generic: "Bound to localhost — re-bind to `0.0.0.0` to reach from your phone."

Otherwise `url = http://<hostname>:<port>`. Hostname is the bridge's already-known tailnet hostname (used elsewhere for the connection QR).

## Polling strategy (v1)

- Mobile fetches `/preview` on chat-screen mount and every 3s thereafter.
- Cancel the interval on unmount.
- Treat the empty/error case identically — no error banners; just empty state. The bridge being unreachable is already surfaced by the chat layer.

## Auth

The endpoint sits behind the same Tailscale-identity / bearer-token middleware as every other `/sessions/...` route. No new auth surface.

## Single-writer & safety

Read-only feature. No mutation of session state, no interaction with claude subprocesses, no impact on the bridge's existing single-writer guarantees for JSONL files.

## v2 candidates (out of scope)

- Push-based updates: replace polling with a `dev_servers_changed` WebSocket event.
- Process-tree attribution: track when the agent's Bash tool spawns a child whose grandchild becomes a dev server, and tag those candidates as "started by agent."
- HTTPS dev servers + cert handling.
- Tunneling localhost-only servers automatically (would require the bridge to proxy after all — non-trivial).
