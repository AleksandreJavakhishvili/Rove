# Plan — Multi-Bridge Aggregator

Reference: [frd.md](./frd.md), [hla.md](./hla.md).

## Overview

Six phases, ordered so the bridge changes ship first (so the mobile
side has something to target), then the mobile refactor, then the
discovery flow, then polish. Each phase is independently shippable —
phases 1–2 are useful even before the mobile refactor lands (any
client could call `/peers`), and the mobile refactor (phase 3) makes
the existing single-bridge UX no worse.

1. **Bridge: Tailscale identity middleware + capability flag**
2. **Bridge: `/peers` endpoint + `rove-bridge init` config**
3. **Mobile: `Bridge[]` model + `bridgeId` threaded through every
   helper / route**
4. **Mobile: sessions aggregator + machine pills + filter strip**
5. **Mobile: anchor-based discovery + add-bridge flow**
6. **Mobile: offline / unreachable handling, sidebar pills, final
   polish**

## Definition of done (whole effort)

- Bridge exposes `/peers` and accepts requests authenticated by
  Tailscale identity OR bearer token; `tailscaleIdentity` capability
  is `true` iff the local Tailscale socket responds to `whois`.
- `Bridge` type and `useBridges` store land in
  `mobile/lib/bridges.ts`; legacy single-bridge settings migrate
  on first load without user action.
- Every helper in `mobile/lib/bridge.ts` takes a `Bridge` or
  `bridgeId`; every session route includes `[bridge]`.
- Sessions list, sidebar, and approvals inbox aggregate across all
  configured bridges. Each row shows a machine pill.
- Adding a tailnet host to one's tailnet, running the install script,
  and pulling-to-refresh in mobile results in the new machine appearing
  in the list. Verified manually on the dev tailnet (smoke).
- Removing a machine from the tailnet (or stopping its bridge)
  degrades its rows to offline within 30 s. Other bridges keep
  working.
- `pnpm exec tsc --noEmit` clean in `bridge/` and `mobile/`.
- `cd web && pnpm build` succeeds.
- Existing single-bridge users see no flow change beyond a one-time
  "Bridges" rename in settings. QR-scan path unchanged.
- "No magic strings" gate holds: every new wire-frame value
  (`authMode`, `tailscaleIdentity`, peer-info fields) has a named
  constant.

---

## Phase 1 — Bridge: Tailscale identity middleware

Branch: `2026-05-26-multi-bridge-aggregator-phase1-tailscale-auth`

Goal: a bridge running on a tailnet accepts requests from authorised
Tailscale identities without needing a bearer token. Bearer token
remains as fallback.

### LLD

- Tailscale local API client: prefer the official Tailscale Go
  binary's `tailscale whois <ip>` over the local socket via `tsnet`'s
  HTTP API at `http://local-tailscaled.sock/localapi/v0/whois?addr=…`.
  Use a tiny `node-fetch`-over-unix-socket helper, not a Go shim.
  Document the macOS / Linux / Windows socket paths.
- Allowlist semantics: `allowed_users: string[]` matched against
  `whois.UserProfile.LoginName`. Empty list = derived default
  (current OS user @ tailnet). Wildcard `"*"` allows any tailnet
  member (use case: lab / homelab where every device on the tailnet
  is trusted).
- Caching: `whois` results cached by source-IP for 60 s. Tailscale
  IPs are stable per device.
- Capability emission: bridge probes the socket on startup; if
  reachable, `capabilities.tailscaleIdentity = true`. Probe is
  idempotent and re-runs on /health.

### Tasks

- [ ] `bridge/src/tailscale.ts` — `whois(ip): Promise<TailscaleIdentity
      | null>`, `listPeers(): Promise<PeerInfo[]>`,
      `selfStatus(): Promise<SelfInfo | null>`. Cross-platform socket
      path detection.
- [ ] `bridge/src/auth.ts` — middleware that runs whois first, falls
      through to bearer-token check. Adds `c.var.identity` for
      downstream handlers.
- [ ] `bridge/src/server.ts` — wire the new middleware in front of
      every existing protected route. Verify the WS upgrade path
      runs through the same auth.
- [ ] `bridge/src/config.ts` — load `~/.config/rove/bridge.toml`;
      derive defaults; write on first run.
- [ ] `bridge/src/agents/types.ts` — add `tailscaleIdentity?:
      boolean` to `AgentCapabilities`. Constants where applicable.
- [ ] Unit tests: whois success + cache hit + cache miss + fallback
      to bearer + reject on unknown user.

### Definition of done

- Curling the bridge from another tailnet device without a bearer
  token succeeds (200 on /health). Curling from a non-tailnet IP
  without a token fails with 401.
- `~/.config/rove/bridge.toml` is created on first run if absent.
- `tailscaleIdentity` field appears on the capabilities event when
  the bridge is on a tailnet.

---

## Phase 2 — Bridge: `/peers` endpoint + init command

Branch: `2026-05-26-multi-bridge-aggregator-phase2-peers`

Goal: any one bridge can enumerate the rest. Headless install story
lands here.

### Tasks

- [ ] `GET /peers` — wraps `tailscale.listPeers()`. Gated on
      `tailscaleIdentity` capability. Returns `PeersResponse` with
      `self`, `peers[]`, `tailnet`.
- [ ] Update `GET /health` to include `bridgeId`, `user`,
      `tailscaleIdentity`. Probes from the mobile client read this.
- [ ] `bridge/bin/rove-bridge init` subcommand that writes a default
      config and prints the bridge URL.
- [ ] Install script `scripts/install-bridge.sh` for headless boxes:
      `brew install rove-bridge && rove-bridge init && brew services
      start rove-bridge`.

### Definition of done

- `curl http://<tailnet-host>:7777/peers` from another tailnet device
  returns the full peer list including `self`.
- The install script run on a fresh mac mini results in a running
  bridge accepting connections from the user's iPhone, with no
  on-mini UI required.

---

## Phase 3 — Mobile: `Bridge[]` model + threaded `bridgeId`

Branch: `2026-05-26-multi-bridge-aggregator-phase3-bridge-model`

Goal: the mobile codebase stops assuming "one bridge." Everything
typed correctly; UX still looks single-bridge until phase 4.

### LLD

- `mobile/lib/bridges.ts`:
  ```ts
  export const BRIDGE_AUTH_MODE = {
    tailscale: 'tailscale',
    bearer: 'bearer',
  } as const satisfies Record<BridgeAuthMode, BridgeAuthMode>;
  export type BridgeAuthMode = 'tailscale' | 'bearer';

  export interface Bridge {
    id: string;
    name: string;
    baseUrl: string;
    token?: string;
    authMode: BridgeAuthMode;
    lastSeenMs?: number;
  }
  ```
- Migration: if `useHydratedSettings()` returns the legacy shape,
  produce a single `Bridge` with `id = "default"`, `authMode =
  'bearer'`, persist, never run the migration again.
- `BridgeConfig` (the existing `{ baseUrl, token }`) becomes a
  derived view of `Bridge` for the helper-call ergonomics.

### Tasks

- [ ] `mobile/lib/bridges.ts` — types + store + migration.
- [ ] `mobile/lib/bridge.ts` — every exported helper gains a `Bridge`
      (or `bridgeId`) parameter; settings-derived defaults removed.
- [ ] Routing: `app/sessions/[bridge]/[agent]/[id]/{index,diff,file}.tsx`.
      Old `app/sessions/[agent]/[id]/*` becomes a redirect wrapper.
- [ ] WS connection: keyed by `bridgeId` so we can hold many open at
      once. Reconnect logic moves into the aggregator (phase 4).
- [ ] Pending-permissions store: re-keyed by
      `${bridgeId}:${agent}:${sessionId}:${toolUseId}`.
- [ ] Diff cache: re-keyed by `(bridgeId, agent, sessionId, path)`.

### Definition of done

- Both bridge and mobile `tsc --noEmit` clean.
- A user with one bridge sees zero behavior change.
- Routes still resolve from existing share links via the
  backward-compat redirect.

---

## Phase 4 — Mobile: sessions aggregator + machine pills

Branch: `2026-05-26-multi-bridge-aggregator-phase4-aggregator`

Goal: the sessions list and sidebar show every machine's sessions in
one view, with machine identity visible on every row.

### Tasks

- [ ] `mobile/lib/aggregator.ts` — fans out `/sessions` on each
      bridge in parallel with a 5s per-host timeout. Merges results
      by `lastModified` desc. Emits per-bridge connection state.
- [ ] Sessions screen — filter chip strip (`All · machine A …`),
      machine pill on each row, offline badge on rows whose bridge
      is unreachable.
- [ ] `SessionsSidebar` — same machine pill; current session's
      bridge highlighted.
- [ ] Approvals inbox — aggregator-driven; banner shows
      `N pending across M machines`.
- [ ] Pull-to-refresh triggers `aggregator.refresh()` on all bridges.

### Definition of done

- Two bridges configured → sessions list shows interleaved rows
  sorted by recency, each row's pill visible.
- One bridge taken offline → its rows show offline badge within 30s
  AND remain visible; other bridge keeps working.
- Filter chip "machine A" hides other machines' rows; "All" restores.

---

## Phase 5 — Mobile: anchor discovery + add-bridge flow

Branch: `2026-05-26-multi-bridge-aggregator-phase5-discovery`

Goal: adding a machine is one step. Headless boxes auto-enrol.

### Tasks

- [ ] Settings → "Bridges" screen. List of configured bridges with
      reachability state. Per-row: rename, remove, edit token.
- [ ] "Find on my tailnet" action: prompts for one hostname, calls
      `/peers` on it, lists discovered peers with checkboxes,
      probes each on confirm, adds successes.
- [ ] First-run onboarding: if `Bridge[]` is empty, present the
      three options (Find / Scan QR / Paste URL).
- [ ] Periodic re-discovery: every 5 min while the app is foreground,
      call `/peers` on any reachable bridge, surface newly-seen
      peers as a "1 new machine on your tailnet" banner. User taps
      to confirm before it's added.

### Definition of done

- Installing the bridge on a fresh mac mini in the dev tailnet
  results in the mobile app showing it as discoverable within 5
  minutes, and adding it is one tap.
- Removing a bridge from settings cleans up its WS, pending
  approvals, and aggregator entry.

---

## Phase 6 — Mobile: offline polish + sidebar pills + DoD pass

Branch: `2026-05-26-multi-bridge-aggregator-phase6-polish`

Goal: graceful degradation, no rough edges.

### Tasks

- [ ] Offline UX: rows from unreachable bridges show with a faded
      pill, an offline badge, and a tap-to-retry. Tapping into the
      session shows a connecting state until the bridge comes back.
- [ ] Stale data: bridge `lastSeenMs` shown in the bridges
      management screen.
- [ ] Auth failure: 401 from a bridge demotes its state to
      `unauthorised` and surfaces an inline "re-auth" banner on its
      rows. Tapping the banner walks the user through re-scanning
      the QR or re-entering the token.
- [ ] Sidebar machine pill (matching the sessions-list pill style).
- [ ] Smoke checklist (manual): two bridges configured, both online;
      one online + one offline; one online + one unauthorised;
      anchor discovery with three peers; legacy single-bridge
      migration from a prior release.

### Definition of done

- All goals from the FRD verified manually.
- No regressions on single-bridge users (verified with an explicit
  one-bridge test pass).
- Bundle-size delta documented for the mobile JS bundle.

---

## Migration notes

- **Legacy bearer-only bridges keep working.** The mobile aggregator
  accepts both `authMode` values transparently. No upgrade required
  on bridges users don't want to touch.
- **First launch after upgrade.** Mobile detects the legacy
  `{ baseUrl, token }`, creates a single `Bridge` entry with
  `id: "default"`, `authMode: "bearer"`, migrates it, and routes
  every existing screen through the new `bridgeId`-keyed flow.
  Migration is irreversible by design — the legacy shape is dropped
  after migration completes.
- **Old share URLs.** `/sessions/[agent]/[id]` becomes a redirect
  that disambiguates among configured bridges: if exactly one owns
  `(agent, id)`, jump there; otherwise show a picker. Redirect
  stays for one release, then gets removed.
- **Per-bridge auth tokens stay user-rotatable** via the Bridges
  settings screen. Rotating doesn't disturb the WS — the next
  reconnect uses the new token.

## Risk register

- **`tailscale whois` socket path varies by platform.** Document
  paths; smoke-test on Linux (Tailscale snap *and* deb), macOS
  (CLI install *and* GUI app), Windows (admin pipe). Fall back to
  bearer if socket detection fails — never block startup.
- **Shared tailnet privacy.** Default `allowed_users` to the current
  OS user only. Document the wildcard explicitly; never enable it
  by default. Smoke: roommate on the same tailnet must NOT see the
  other user's bridges.
- **Many WebSockets on a low-end iPhone.** Limit to one open WS per
  *visible* session — the rest of the bridges contribute via REST
  polling for `/sessions` only. Live WS is opened lazily when the
  user opens a session on a given bridge.
- **Anchor offline.** Aggregator caches last `/peers` response per
  bridge; if no bridges are reachable, fall back to cached state
  and surface a "no bridges reachable" banner.
- **Tailscale not installed.** Bridge falls back to bearer; mobile
  Find-on-tailnet flow shows "your bridges aren't reporting
  tailnet identity — paste a URL instead." No silent failure.
