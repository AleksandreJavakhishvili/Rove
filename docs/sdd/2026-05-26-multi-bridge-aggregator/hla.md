# High-Level Architecture — Multi-Bridge Aggregator

Reference: [frd.md](./frd.md), [plan.md](./plan.md).

> **Auth note.** This was originally specced against a `tailscale whois`
> -over-the-local-socket middleware. That was **rejected** in favour of
> reusing the existing `tailscale serve` header-injection auth
> (`bridge/src/auth.ts`) — see *Tradeoffs › Why reuse `tailscale serve`*.
> The mobile UX (home inbox, gestures, discovery, offline) is specced in
> *Mobile UX (target screens)* below.

## Context

This effort generalises the mobile ↔ bridge contract from "one bridge"
to "N bridges". The bridge process itself stays single-tenant and
per-machine — every machine that hosts Claude Code keeps running its
own bridge. The aggregator lives entirely on the *client* side. The
*authentication* model is the **existing** Tailscale-identity path —
each bridge runs behind `tailscale serve`, which injects a
`Tailscale-User-Login` header that `bridge/src/auth.ts` already trusts —
so headless machines can be enrolled with zero on-device configuration.

It does **not** introduce a central server, a relay, a cross-bridge
sync layer, or anything else that would create a single point of
failure between phone and machines. Tailscale already provides
discovery + transport + identity for devices on the tailnet; this work
is mostly about teaching the mobile app to use what's already there.

This sits on top of:
- The existing `tailscale serve` header-injection auth
  (`bridge/src/auth.ts`), with bearer-token auth kept as the off-tailnet
  fallback.
- The existing per-session WS protocol (unchanged on the wire, just
  multiplied N times).
- `GET /health`, which reports a bridge-level `tailscaleServe` flag so
  the mobile app knows whether a given bridge is on the keyless serve
  path. This is a **bridge-level** signal on `/health`, not a per-agent
  `AgentCapabilities` field.

## Architectural pillars

1. **The bridge stays per-machine.** A bridge is an agent driver
   co-located with the files the agent edits. Centralising the bridge
   would just rename "per-machine code" without removing it. The unit
   of trust, isolation, and fault-domain remains the machine.

2. **Aggregation is a client concern.** The mobile app holds a
   `Bridge[]` list, opens N WebSockets in parallel, and merges
   `/sessions` results in memory. No server-side merging, no shared
   state between bridges.

3. **Tailscale identity is the auth.** A bridge runs behind
   `tailscale serve`, which authenticates the caller as a tailnet device
   and injects a `Tailscale-User-Login` header. `bridge/src/auth.ts`
   trusts that header and accepts iff the identity matches the bridge's
   `ALLOWED_USERS` allowlist. No tokens cross the wire on this path.
   _(Originally specced as `tailscale whois` over the local socket —
   rejected; serve-header injection is already shipping.)_

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
         │ serve    │ │serve    │ │serve   │ │serve     │
         │ +header  │ │+header  │ │+header │ │+header   │
         └──────────┘ └─────────┘ └────────┘ └──────────┘
```

## Components

### Bridge — mostly existing

**Tailscale identity auth — already built** (`bridge/src/auth.ts`).
No new middleware. `identify()` reads the `Tailscale-User-Login` header
injected by `tailscale serve`, checks it against the `ALLOWED_USERS`
allowlist (default: the current OS user's tailnet login, auto-derived),
and falls through to the bearer token + a loopback-dev escape hatch.
`identifyForWs()` runs the same logic on the WS upgrade. This is the
auth path for the whole effort.

_(The original spec here described a new `tailscale whois`-over-socket
middleware with cross-platform socket paths. Rejected — see
*Tradeoffs › Why reuse `tailscale serve`*.)_

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
Gated on the `/health` `tailscaleServe` flag. 3s timeout — if tailscale
isn't running, return 503 cleanly.

**No-key signal on `/health`** (`bridge/src/server.ts`). Whether a bridge
is on the keyless serve path is a **bridge-level** fact, so it is reported
by `GET /health` as `tailscaleServe: boolean`, **not** added to the
per-agent `AgentCapabilities`. The bridge already knows
this at startup (`runtimeState.tailscaleServing`). Mobile reads it during
the discovery `/health` probe to decide whether to surface the
auto-discovery flow.

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

**Sessions list = the unified home inbox.** Aggregates chats across every
machine into one list (not a machines-first hierarchy). Sorted by **what
needs you** — `pending-approval ▸ live ▸ recently-active ▸ idle` — never
filtered by the sort (idle chats still show, lower). Each row carries the
machine's coloured pill (deterministic hue per hostname). A horizontal
**filter chip strip** at the top (`All · iMac · MacBook · …`, recent-first)
scopes the list; a `●` on a chip flags a machine that needs you even when
not selected; selection is **sticky** through offline transitions. Empty
(zero-session) machines are hidden from the chips but visible on the
Machines screen. Rows render **per machine as results arrive** (no
full-screen spinner); offline machines' rows **fade, they don't vanish**.

**Switcher** (the existing `SessionsSidebar`, button-triggered by `⊟`).
Opens **scoped to the current machine** (the common case: switch to a
sibling chat on the same box), with the same chip strip as home to pull up
another machine — or `All` — without leaving the chat. Reads the
aggregator's cached list filtered by `bridgeId`; no separate fetch. It is
**not** swipe-opened — horizontal swipe in the chat is owned by
`ChatPreviewPager` (Chat ⟷ Workspace) and a second swipe would collide.

**Routing.** Bridge identity travels as a **`?bridge=<id>` query param**
on the existing `/sessions/[agent]/[id]` routes (and `diff`/`file`), not a
new `[bridge]` path segment. Each session screen resolves the param to a
`Bridge` and falls back to the active bridge when it's absent — so old
share links keep working with no redirect wrapper, and the route tree is
untouched. (Implemented: `index.tsx`, `diff.tsx`, `file.tsx` read the param
and build their connection config from it.) Chosen over a `[bridge]` folder
because it's the same correctness with far less navigation risk.

**Machines screen + add-bridge flow.** Reached from a header icon on home
(badges on new discovery) and the switcher footer — **no bottom nav** (you
live in the immersive chat, where a tab bar would just hide). The Machines
screen is the only place empty machines appear; it shows per-machine
health / offline / `lastSeenMs` and offers rename. Adding a bridge:
1. **Find on my tailnet** — user adds one anchor (hostname / QR). Mobile
   calls `/peers` on it and probes each returned device at `/health`;
   the ones that are bridges are offered for one-tap add. The instant the
   **first** bridge connects this runs automatically and surfaces inline
   ("Found N machines on your tailnet — Add all"); later new machines
   surface as a banner.
2. "Paste URL + token" — manual path for off-tailnet (bearer) bridges.
3. "Scan QR" — unchanged (token-less payload on the serve path).

**Tailnet-presence detection.** The app detects whether the phone is on
the tailnet — `100.64.0.0/10` on a `utun` interface (iOS), `TRANSPORT_VPN`
(Android) — and, when it is not, shows "Turn on Tailscale to reach your
machines" instead of a generic network error. Detection only gates
UX/copy; it never blocks a connection attempt.

## Interfaces

### Bridge HTTP (new + changed)

- `GET /peers` — see PeersResponse above. Gated on the `/health`
  `tailscaleServe` flag.
- All existing routes accept either: the `Tailscale-User-Login` header
  injected by `tailscale serve`, OR `Authorization: Bearer <token>`
  (and `?token=` for WS upgrades). Either path succeeds independently
  (`bridge/src/auth.ts`).
- `GET /health` — returns `{ ok, user, bridgeId, tailscaleServe }`
  so the mobile probe knows what it's looking at without a second
  round-trip.

### Bridge config (per-machine)

A tiny config file at `~/.config/rove/bridge.toml`:
```toml
[auth]
# default: derived from the current OS user's tailnet login
allowed_users = ["you@example.com"]
# default: random bearer token, used only on the off-tailnet fallback path
bearer_token = "…"

[bridge]
# default: random UUID written on first run; reported on /health
id = "…"
```
(Serve mode is auto-detected at startup — `runtimeState.tailscaleServing` —
not a config toggle.)
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

## Mobile UX (target screens)

ASCII can't show colour; each machine gets a shape here. **In the app each
machine gets a deterministic colour** (hash of hostname → hue), used
identically on inbox rows, filter chips, the chat header pill, and the
switcher — so a machine is recognisable before its label is read. Default
name = hostname; user-renamable.

```
◆ machine A (iMac)    ● needs you   ◉ live   ○ idle   ⚠ offline
🖥 machines screen     ⊟ open switcher   › tap target   ⤴ send
```

### Navigation map

```
  first run ─► Connect a machine (Scan QR / Find / URL)
                        │ first bridge connects
                        ▼
   ┌──────────────────────────────────────────┐
   │ HOME — unified inbox                       │
   │  chips · needs-me sort · machine pill      │
   │  header 🖥 ─► MACHINES (discover/add/      │
   │              rename/health)                │
   └───────┬────────────────────────────────────┘
           │ tap a chat row
           ▼
   ┌──────────────────────────────────────────┐
   │ CHAT (immersive)                           │
   │  header: ◆ machine pill · chat · ⊟         │
   │  swipe ⟶ Workspace (Files / Preview)       │
   │  ⊟ ─► switcher (current machine; chips)    │
   └────────────────────────────────────────────┘
   Settings = header gear. No bottom tab bar.
```

### Home — unified "needs-me" inbox (the chats list)

```
┌──────────────────────────────────┐
│  Rove                       🖥 ⚙ │  🖥 badges on new discovery
│ [All] [◆iMac ●] [●MacBook] [▲mini⚠]│ chips: ● needs you, ⚠ offline
│ ──────────────────────────────── │
│  ◆ iMac    fix-auth              │
│    ● needs approval · now    ›   │ ◄ floated to top
│ ──────────────────────────────── │
│  ● MacBook  api-refactor         │
│    ◉ live · 5m               ›   │
│ ──────────────────────────────── │
│  ◆ iMac    write-docs            │
│    ○ idle · 1h               ›   │
│ ──────────────────────────────── │
│  ▲ mini    nightly-build         │
│    ⚠ offline · seen 2h       ›   │ ◄ faded, stays visible
│ ──────────────────────────────── │
│            ↻ pull to refresh     │
└──────────────────────────────────┘
```

Tapping a chip scopes the list; the selection is **sticky** (a selected
machine going offline keeps the filter and shows offline, it does not snap
back to "All").

### Chat — immersive, machine-aware

```
┌──────────────────────────────────┐
│ ‹  ◆ iMac · fix-auth        ⋮  ⊟ │ ◄ machine pill + switcher button
│ ──────────────────────────────── │
│  assistant: I'll update the auth │
│  middleware…                     │
│  [tool] Edit auth.ts             │
│  ┌──────── approval ──────────┐  │
│  │ Allow Edit auth.ts?        │  │
│  │     [ Deny ]    [ Allow ]  │  │
│  └────────────────────────────┘  │
│ ──────────────────────────────── │
│  › message…                 ⤴   │
└──────────────────────────────────┘
        swipe ⟶ Workspace (Files / Preview)
```

### Switcher — button-triggered, current machine + chips

Opens scoped to the current machine (`⊟`, not a swipe). The chip strip
switches scope to another machine — or `All` (grouped) — without leaving
the chat.

```
┌──────────────────────────────────┐
│  Sessions                    ✕   │
│ ‹◆iMac› [●MacBook] [▲mini] [All] │ ◄ opens on current machine
│ ──────────────────────────────── │
│  ◆ iMac                          │
│   • fix-auth        ● now        │
│   • write-docs      ○ 1h         │
│   • api-spike       ○ 3h         │
│ ──────────────────────────────── │
│        [  Manage machines  ]     │
└──────────────────────────────────┘
```

### Machines screen (pushed from home's 🖥)

```
┌──────────────────────────────────┐
│ ‹  Machines                      │
│ ──────────────────────────────── │
│  ◆ iMac   online · 3 sessions ›  │
│  ● MacBook online · 1 session ›  │
│  ▲ mac-mini ⚠ offline · seen 2h  │
│            0 sessions         ›  │
│ ──────────────────────────────── │
│  [ + Find on my tailnet ]        │
│  [ + Scan QR / Enter URL ]       │
└──────────────────────────────────┘
```

### Edge states

- **Empty / first run:** one confident CTA, camera-first (Scan QR), with
  "Find on my tailnet" and "Enter URL" secondary.
- **Phone off the tailnet:** "Turn on Tailscale to reach your machines"
  (+ Open Tailscale / Retry), not a generic network error.
- **Discovery moment:** right after the first bridge connects, an inline
  "Found N machines on your tailnet — Add all".
- **Offline chat entry:** "mac-mini is offline — showing last known
  messages, reconnecting" + Retry; never a hard error. (Waking an asleep
  machine is a future SDD.)

### Gesture model (why switching is a button)

```
 CHAT — horizontal axis is ALREADY taken by the pager:

   page 0                    page 1
  ┌────────┐  swipe ⟷       ┌────────────┐
  │  Chat  │ ───────────►   │ Workspace  │
  └────────┘                └────────────┘
        ▲ a 2nd "machines" swipe would fight this
   ⇒ switcher = button (⊟ → Modal); home scope = visible chips.
```

### Discovery sequence (no key, one anchor)

```
 phone                 anchor bridge          other machines
   │  GET /peers           │                       │
   ├──────────────────────►│ tailscale status --json
   │                       ├──────────────────────►│
   │ { self, peers[],      │◄──────────────────────┤
   │◄──────── tailnet }────┤                       │
   │  probe https://<peer>.<tailnet>.ts.net/health ►│
   │◄──────── ok? add as bridge ────────────────────┤
   │  (no token on the wire — identity via tailscale serve)
```

The phone learns **one** anchor (QR / URL / SSH output); every other
machine is derived from `/peers`.

## Tradeoffs

**Why reuse `tailscale serve`, not build whois-on-socket?**
The serve header-injection path (`bridge/src/auth.ts`) is already built,
tested, and shipping; the `tailscale whois`-over-the-local-socket
middleware would be net-new code plus cross-platform socket detection
(macOS / Linux / Windows) for the same user-visible result — no key on the
wire. Cost accepted: every machine, including headless boxes, must run
`tailscale serve` (the install script handles this). Whois-on-socket would
have removed that requirement (auth without a fronting proxy); we judged it
not worth the extra surface for now.

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

**Why not the Tailscale control-plane API for zero-anchor discovery?**
`GET /api/v2/tailnet/-/devices` (OAuth `devices:read`) would enumerate
every machine with **no** manual anchor at all — the only truly
zero-touch path, since iOS won't let a third-party app read Tailscale's
LocalAPI directly. We **deferred** it: it reintroduces a discovery
credential (an OAuth client) and a `api.tailscale.com` cloud dependency,
which cut against the keyless principle, and OAuth client creds only see
tailnet-owned (not shared) devices. May return later as an optional
power-user toggle. The keyless anchor + `/peers` stays the baseline.

**Why a unified inbox, not a machines-first home?**
The reason you open the phone is "which agent needs me, anywhere?" —
inherently cross-machine. A machines-first hierarchy buries that one tap
down per box and re-introduces the "one machine at a time" friction the
FRD calls out. The inbox is also the smallest delta from today's home and
aligns with the already-shipped cross-session approvals.

**Why no bottom navigation, and why a button (not a swipe) to switch?**
You live inside the immersive chat, which owns horizontal swipe for the
workspace pane (`ChatPreviewPager`). A bottom tab bar would just hide
there, and a second horizontal "machines" swipe would collide with the
pager. So machine/session switching is a visible, button-triggered control
(`⊟`), home scoping is the always-visible chip strip, and the Machines
screen is reached from a header icon — no tab bar.

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
