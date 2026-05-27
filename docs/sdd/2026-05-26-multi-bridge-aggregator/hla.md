# High-Level Architecture — Multi-Bridge Aggregator

Reference: [frd.md](./frd.md), [plan.md](./plan.md).

## Context

This effort generalises the mobile ↔ bridge contract from "one bridge"
to "N bridges". The bridge process itself stays single-tenant and
per-machine — every machine that hosts Claude Code keeps running its
own bridge. The aggregator lives entirely on the *client* side. The
*authentication* model gains a Tailscale-identity path so headless
machines can be enrolled with zero on-device configuration.

It does **not** introduce a central server, a relay, a cross-bridge
sync layer, or anything else that would create a single point of
failure between phone and machines. Tailscale already provides
discovery + transport + identity for devices on the tailnet; this work
is mostly about teaching the mobile app to use what's already there.

This sits on top of:
- The existing bearer-token auth (kept as fallback).
- The existing per-session WS protocol (unchanged on the wire, just
  multiplied N times).
- The capability-negotiation pattern from
  `docs/sdd/2026-05-21-sdk-driver-migration/` — a new
  `tailscaleIdentity` capability tells the mobile app whether a given
  bridge supports identity-based auth.

## Architectural pillars

1. **The bridge stays per-machine.** A bridge is an agent driver
   co-located with the files the agent edits. Centralising the bridge
   would just rename "per-machine code" without removing it. The unit
   of trust, isolation, and fault-domain remains the machine.

2. **Aggregation is a client concern.** The mobile app holds a
   `Bridge[]` list, opens N WebSockets in parallel, and merges
   `/sessions` results in memory. No server-side merging, no shared
   state between bridges.

3. **Tailscale identity is the auth.** A bridge that has access to
   the local Tailscale socket calls `tailscale whois` on every
   request and accepts iff the caller's identity matches the bridge's
   owner. No tokens cross the wire on this path.

4. **Bearer token stays as the fallback.** A bridge with no Tailscale
   socket (CI, container, remote tunnel) keeps the existing
   token-based auth. Mobile clients work on either path
   transparently.

5. **One anchor bootstraps the rest.** The bridge exposes a `/peers`
   endpoint that returns the tailnet device list from `tailscale
   status --json`. The mobile app needs to know ONE bridge to
   discover ALL of them. New machines auto-appear; the user never
   manually adds them.

6. **`bridgeId` is part of every API call.** All client helpers that
   today take `(agent, sessionId)` gain a leading `bridgeId`. All
   routes that today are `/sessions/[agent]/[id]` become
   `/sessions/[bridge]/[agent]/[id]`. Backward-compat redirects
   handle legacy share URLs.

7. **Failure is local.** A bridge going offline degrades that
   bridge's rows; other bridges keep streaming. The aggregator never
   blocks on a slow / unreachable host — every fan-out has a per-host
   timeout and falls through to "offline" UI.

## Target topology

```
                ┌──────────────────────────────┐
                │  iPhone (Rove mobile)        │
                │                              │
                │  Settings: Bridge[] {        │
                │    id, name, baseUrl,        │
                │    token?, authMode,         │
                │    lastSeenMs                │
                │  }                           │
                │                              │
                │  per-bridge: WS + REST       │
                │   ┌────────────┐             │
                │   │ aggregator │             │
                │   │  (memory)  │             │
                │   └─────┬──────┘             │
                └─────────┼────────────────────┘
                          │  (Tailscale)
                ┌─────────┼─────────┬──────────┐
                ▼         ▼         ▼          ▼
         ┌──────────┐ ┌─────────┐ ┌────────┐ ┌──────────┐
         │  iMac    │ │ MacBook │ │mac-mini│ │  …       │
         │  bridge  │ │  bridge │ │ bridge │ │  bridge  │
         │ :7777    │ │  :7777  │ │  :7777 │ │  :7777   │
         │          │ │         │ │        │ │          │
         │ /sessions│ │/sessions│ │…       │ │…         │
         │ /peers   │ │/peers   │ │/peers  │ │/peers    │
         │ /ws/…    │ │/ws/…    │ │/ws/…   │ │/ws/…     │
         │          │ │         │ │        │ │          │
         │ whois    │ │whois    │ │whois   │ │whois     │
         │ (auth)   │ │(auth)   │ │(auth)  │ │(auth)    │
         └──────────┘ └─────────┘ └────────┘ └──────────┘
```

## Components

### Bridge — new

**Tailscale identity middleware** (`bridge/src/tailscale.ts`, new).
Wraps the Hono router. On every request: read the source IP, call
`tailscale whois` over the local Tailscale Unix socket
(`/var/run/tailscale/tailscaled.sock` on macOS/Linux,
`\\.\pipe\ProtectedPrefix\Administrators\Tailscale\tailscaled` on
Windows). If the returned `UserProfile.LoginName` matches the bridge
owner's allowlist (default: `os.userInfo().username @ <tailnet>`),
attach the identity to the request context and allow. Otherwise fall
through to the bearer-token check.

**`/peers` endpoint** (`bridge/src/server.ts`). Shells out to
`tailscale status --json`. Returns:
```ts
interface PeerInfo {
  hostname: string;       // "mac-studio"
  dnsName: string;        // "mac-studio.<tailnet>.ts.net"
  tailscaleIPs: string[]; // ["100.x.x.x"]
  online: boolean;
  os: string;
}
interface PeersResponse {
  self: PeerInfo;
  peers: PeerInfo[];
  tailnet: string;
}
```
Gated on `tailscaleIdentity` capability. 3s timeout — if tailscale
isn't running, return 503 cleanly.

**Capability flag** (`bridge/src/agents/types.ts`). New optional field
on `AgentCapabilities`:
```ts
tailscaleIdentity?: boolean;
```
The bridge sets this at attach time based on whether `tailscale whois`
on the local socket succeeded. Mobile uses it to decide whether to
show the auto-discovery flow.

### Mobile — refactor + new

**`Bridge` type** (`mobile/lib/bridges.ts`, new):
```ts
interface Bridge {
  id: string;          // stable UUID
  name: string;        // user-visible label; defaults to hostname
  baseUrl: string;     // includes scheme + port
  token?: string;      // present iff authMode === 'bearer'
  authMode: 'tailscale' | 'bearer';
  /** Last successful health-check timestamp. Drives offline UI. */
  lastSeenMs?: number;
}
```

**`useBridges` store** (Zustand slice). Replaces today's single
`{ baseUrl, token }` in settings. Migrates the legacy single-bridge
config to a one-entry array on first read. Exposes selectors:
`useBridge(id)`, `useBridges()`, `useReachableBridges()`.

**`fetchBridge` helper** wraps `fetch` with the bridge config; replaces
the `BridgeConfig`-taking helpers in `mobile/lib/bridge.ts`. All
helpers gain a leading `bridgeId` (or `Bridge` object) parameter.

**Aggregator** (`mobile/lib/aggregator.ts`, new). Owns:
- per-bridge `SessionListItem[]` cache,
- per-bridge connection state (`'connecting' | 'open' | 'offline' |
  'unauthorised'`),
- a fan-out `refresh()` that hits `/sessions` on every bridge in
  parallel with a 5s per-host timeout,
- a `discover(anchorId)` that hits the anchor's `/peers` and proposes
  new bridges for the user to add.

**Sessions list** — gains a machine pill on each row and a horizontal
filter chip strip at the top (`All · iMac · MacBook · …`). Empty
machines (zero sessions) are hidden from the chip strip but visible
in the bridges-management screen.

**Sidebar** (already built) — gains the same machine pill on each row.
No filter strip; current-session bridge stays highlighted.

**Routing.** Session URL changes from
`/sessions/[agent]/[id]` → `/sessions/[bridge]/[agent]/[id]`.
A wrapper redirect lives at the old route for one release: if exactly
one bridge owns a session with that `(agent, id)`, redirect to the new
URL; otherwise show a picker.

**Add-bridge flow.**
1. "Find on my tailnet" — user types one tailnet hostname (or scans
   one QR). Mobile calls `/peers` on it. Each returned peer is
   probed at `:7777/health`. Successes are added.
2. "Paste URL + token" — unchanged manual path for non-tailnet
   bridges.
3. "Scan QR" — unchanged.

## Interfaces

### Bridge HTTP (new + changed)

- `GET /peers` — see PeersResponse above. Gated on `tailscaleIdentity`.
- All existing routes accept either: Tailscale-identity-validated
  source IP, OR `Authorization: Bearer <token>`. Either path
  succeeds independently.
- `GET /health` — returns `{ ok, user, bridgeId, tailscaleIdentity }`
  so the mobile probe knows what it's looking at without a second
  round-trip.

### Bridge config (per-machine)

A tiny config file at `~/.config/rove/bridge.toml`:
```toml
[auth]
# default: derived from `os.userInfo().username`
allowed_users = ["you@example.com"]
# default: true if tailscale socket exists
tailscale_identity = true
# default: random on first run
bearer_token = "…"
```
A new `rove-bridge init` subcommand writes a sensible default. The
install script for headless machines calls this once.

### Mobile types (changed)

```ts
interface SessionListItem {
  bridgeId: string;     // NEW — required
  agent: AgentKind;
  id: string;
  cwd: string;
  // …existing fields…
}
```
`SessionListItem` from `bridge/src/types.ts` is unchanged on the wire
— the mobile aggregator tags each item with `bridgeId` as it merges.
This keeps the bridge agnostic of its own identity (a bridge doesn't
know what name the user gave it).

## Tradeoffs

**Why client-side aggregation, not a central proxy?**
A central proxy is also per-machine code — it still needs a component
on every machine that holds the SDK Query open and owns the filesystem.
You don't actually centralize anything; you just add a hop and a single
point of failure. Tailscale already gives us transport + identity;
piggybacking is cheaper than reinventing.

**Why Tailscale identity, not a federated token?**
A shared token across machines collapses the per-machine fault
boundary: compromise one machine = compromise all. Tailscale identity
keeps each bridge's trust scoped to "is this you?" without requiring
shared secrets.

**Why bearer token at all if Tailscale identity exists?**
Three reasons: (1) Tailscale isn't always reachable (CI, containers,
tunnels through Cloudflare); (2) some users don't run Tailscale on
all their personal devices; (3) graceful upgrade path — existing
users don't break.

**Why one anchor + `/peers` instead of mDNS / Bonjour?**
mDNS multicast doesn't traverse Tailscale by default. The anchor
pattern works on any tailnet and doesn't need any Tailscale-specific
client code on iOS. Cost: one manual entry on first run.

**Why N WebSockets instead of a multiplexed bridge-to-bridge protocol?**
Each WS represents a live agent process; multiplexing them through a
proxy would mean re-implementing flow control, backpressure, and
permission-callback routing. N TCP connections on a phone is fine —
even ten bridges is 10 connections, well under any OS limit. Each WS
is also independently reconnect-able, which simplifies the offline
story.

## Out of scope (covered by other / future SDDs)

- **Push notifications across bridges.** Wanted, but a separate relay
  component. The current effort makes it *possible* (every approval
  carries a `bridgeId` that a future push relay would key on) without
  introducing the relay.
- **Bridge-side session migration.** A session JSONL lives on one
  machine. Moving it is not on this roadmap.
- **Web client multi-bridge support.** The web build currently uses
  one bridge per tab via URL params. The aggregator design works
  there too but the UI changes are deferred.
