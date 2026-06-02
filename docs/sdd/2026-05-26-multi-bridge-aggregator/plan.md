# Plan — Multi-Bridge Aggregator

Reference: [frd.md](./frd.md), [hla.md](./hla.md).

## Overview

Six phases, ordered so the bridge changes ship first (so the mobile
side has something to target), then the mobile refactor, then the
discovery flow, then polish. Each phase is independently shippable —
phases 1–2 are useful even before the mobile refactor lands (any
client could call `/peers`), and the mobile refactor (phase 3) makes
the existing single-bridge UX no worse.

1. **Bridge: confirm serve auth + `/health` no-key signal** (most of the
   auth is already shipping — see hla.md *Tradeoffs › Why reuse
   `tailscale serve`*)
2. **Bridge: `/peers` endpoint + `rove-bridge init` config**
3. **Mobile: `Bridge[]` model + `bridgeId` threaded through every
   helper / route**
4. **Mobile: sessions aggregator + machine pills + filter strip**
5. **Mobile: anchor-based discovery + add-bridge flow**
6. **Mobile: offline / unreachable handling, sidebar pills, final
   polish**

## Definition of done (whole effort)

- Bridge exposes `/peers` and accepts requests authenticated by the
  `tailscale serve` identity header OR bearer token (existing
  `bridge/src/auth.ts`); `GET /health` reports `bridgeId` and a
  bridge-level `tailscaleServe` flag (not a per-agent capability).
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
  (`authMode`, `tailscaleServe`, peer-info fields) has a named
  constant.

---

## Phase 1 — Bridge: confirm serve auth + `/health` no-key signal

Branch: `2026-05-26-multi-bridge-aggregator-phase1-health-signal`

Goal: the bridge auth is **already** the no-key path — `tailscale serve`
injects `Tailscale-User-Login`, which `bridge/src/auth.ts` trusts, with
bearer token as the off-tailnet fallback. This phase does NOT build a whois
middleware (rejected — see hla.md *Tradeoffs › Why reuse `tailscale
serve`*). It only surfaces the bridge-level signals mobile needs.

### LLD

- `tailscaleServe` is a bridge-level fact already known at startup
  (`runtimeState.tailscaleServing`). Expose it on `/health`, not on the
  per-agent `AgentCapabilities`.
- `bridgeId`: a stable per-bridge id (persist a random UUID in the bridge
  config on first run). The bridge stays agnostic of its user-given name —
  mobile owns the label.
- Allowlist semantics are unchanged: `ALLOWED_USERS` matched against the
  serve-header login; empty = current OS user's tailnet login
  (auto-derived); wildcard `"*"` = any tailnet member (homelab).

### Tasks

- [x] `bridge/src/server.ts` — extend `GET /health` to return
      `{ ok, user, bridgeId, tailscaleServe }`.
- [x] `bridge/src/config.ts` — persist a stable `bridgeId` on first run
      (`~/.config/rove/bridge-id`; `BRIDGE_ID` env override).
- [x] Confirm the WS upgrade path runs through auth: `app.use('*',
      authMiddleware)` wraps the `upgradeWebSocket` routes too. No new
      middleware.
- [ ] Sanity test (live curl): serve path accepts with no token; bearer
      path accepts with token; neither + non-loopback rejects 401.

### Definition of done

- `GET /health` from another tailnet device (behind `tailscale serve`,
  no bearer token) returns 200 with `tailscaleServe: true`, a `user`, and
  a stable `bridgeId`. A non-tailnet caller without a token gets 401.
- No whois middleware and no `AgentCapabilities.tailscaleIdentity` field
  were added.

---

## Phase 2 — Bridge: `/peers` endpoint + init command

Branch: `2026-05-26-multi-bridge-aggregator-phase2-peers`

Goal: any one bridge can enumerate the rest. Headless install story
lands here.

### Tasks

- [x] `bridge/src/tailscale.ts` — `listTailnetDevices()` parses `Self` +
      the `Peer` map + `MagicDNSSuffix` from `tailscale status --json`
      (3s timeout; returns null → 503 when Tailscale is unavailable).
- [x] `GET /peers` — returns `PeersResponse` with `self`, `peers[]`,
      `tailnet`; 503 when Tailscale is unreachable. Auth-protected by the
      global middleware; the client gates on the `/health` `tailscaleServe`
      flag before calling it.
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
- Migration: on first `useBridgesStore.load()` with no `rove:bridges:v1`,
  read the legacy `rove:settings:v1` `{ baseUrl, token }` and produce a
  single `Bridge` with `id = "default"`; `authMode` is **inferred**
  (`token` present → `'bearer'`, else `'tailscale'`). Persist, never run
  the migration again.
- `BridgeConfig` (the existing `{ baseUrl, token }`) becomes a
  derived view of `Bridge` for the helper-call ergonomics.

### Tasks

- [x] `mobile/lib/bridges.ts` — `Bridge` type, `BRIDGE_AUTH_MODE`,
      `useBridgesStore` + selectors, legacy `{ baseUrl, token }` → single
      `default` bridge migration, `bridgeToConfig` derived view,
      `makeBridge` / `newLocalBridgeId` / `getActiveBridge` helpers.
- [x] `mobile/lib/store.ts` — `useBridges` is now the persistent
      connection source; `useSettings` delegates `baseUrl`/`token` to the
      active bridge (facade), so all existing readers + the connect flow
      keep working unchanged. `BridgeConfig` kept as the structural derived
      view (helper signatures unchanged for now).
- [x] Routing via **`?bridge=<id>` query param** (not a `[bridge]` path
      segment): `index.tsx`, `diff.tsx`, `file.tsx` resolve the param to a
      `Bridge`, falling back to the active bridge — old links keep working,
      no redirect wrapper, route tree untouched. Lower-risk than restructuring.
- [ ] (→ Phase 4) WS connection keyed by `bridgeId` (hold many open). Single
      stream to the active bridge today; multiplexing lands with the aggregator.
- [ ] (→ Phase 4) Pending-permissions store re-keyed by
      `${bridgeId}:${agent}:${sessionId}:${toolUseId}`. Single bridge → no
      collision yet.
- [ ] (→ Phase 4) Diff cache re-keyed by `(bridgeId, agent, sessionId, path)`.

### Definition of done

- Both bridge and mobile `tsc --noEmit` clean. ✅ (mobile clean with the
  `bridges.ts` + `store.ts` changes; bridge clean from Phase 1–2.)
- A user with one bridge sees zero behavior change (connection config now
  flows through `Bridge[]` but resolves to the same single bridge).
- The concurrency-only mechanics (per-`bridgeId` re-keying + `[bridge]`
  routes) moved to Phase 4, where two bridges actually stream at once — they
  are no-ops for a single bridge and carry navigation/runtime risk best
  verified on-device alongside the aggregator.

---

## Phase 4 — Mobile: sessions aggregator + machine pills

Branch: `2026-05-26-multi-bridge-aggregator-phase4-aggregator`

Goal: the sessions list and sidebar show every machine's sessions in
one view, with machine identity visible on every row.

### Tasks

- [x] `mobile/lib/aggregator.ts` — fans out `/sessions` on each
      bridge in parallel with a 5s per-host timeout. Emits per-bridge
      connection state, keeps last-known rows on failure (offline stays
      visible), tags each session with `bridgeId`; `mergeSessions()` util.
- [x] Machine identity util — `bridgeColor()` in `bridges.ts`,
      deterministic per-host hue; to be reused on rows, chips, chat
      header, switcher.
- [x] Session screens bridge-aware via `?bridge=` — `index.tsx`,
      `diff.tsx`, `file.tsx` connect to the row's bridge (fallback active).
      Note follow-up: chat → diff/file nav must forward `?bridge` once the
      inbox passes it.
- [x] Sessions screen = unified home inbox (`app/index.tsx`). needs-me
      sort (`pending ▸ live ▸ recent`), machine pill per row (colour +
      name), offline rows **faded + "· offline"**, filter chip strip
      (recent-first, shown when >1 machine), sticky selection, `●` on a
      chip when that machine needs the user. Rows navigate with `?bridge=`.
      Empty / all-offline / connecting states handled.
- [x] `SessionsSidebar` → switcher: aggregator-driven, opens scoped to the
      current machine (`currentBridgeId` prop) with scope chips (machines +
      `All`, shown when >1 machine), machine dot + name per row, navigates
      with `?bridge=`. Button-triggered (existing `⊟`); not swipe.
- [~] Approvals inbox — banner shows total pending across sessions
      (single-stream today; true cross-bridge pending needs the WS fan-out,
      below).
- [x] Pull-to-refresh triggers `aggregator.refresh()` on all bridges.
- [x] Multi-bridge pending streaming — `usePendingPermissions` opens one
      `/events` stream per bridge, tags each request with `bridgeId`, keys the
      map by `${bridgeId}:${agent}:${sessionId}`; `decide()` routes the
      approval to the originating bridge. `selectOthersPending` excludes the
      focused session per-bridge. 68 jest tests pass (incl. a cross-bridge case).

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

- [x] Machines screen (`app/machines.tsx`), reached from a header icon on
      home. Lists bridges with reachability (aggregator `connState`) +
      session count + `lastSeenMs`; per-row rename + remove (token edit via
      "Add manually" → settings for now). Route registered in `_layout.tsx`.
      (`/machines` push is cast `as Href` until expo regenerates typed routes.)
- [x] "Find on my tailnet" — `discovery.ts:discoverBridges(anchor)` calls
      `/peers` on a reachable bridge, probes each device's `/health` over the
      serve path (no token), filters to authorised bridges not already added
      (self/phone/non-bridge drop out via the probe), and offers "Add all".
      `fetchPeers` + extended `fetchHealth` (bridgeId, tailscaleServe) added.
- [x] Discovery magic moment: after a successful connect on the serve path
      (`health.tailscaleServe`), `settings.tsx` auto-runs `discoverBridges`
      from the just-added bridge and offers "Add all" inline — connect one,
      the rest appear.
- [ ] Tailnet-presence detection: `100.64/10`-on-`utun` (iOS) /
      `TRANSPORT_VPN` (Android); when off-tailnet, show "Turn on Tailscale"
      copy. **Needs a native module** (no public RN API) — deferred; the
      all-offline inbox state already points at the tailnet.
- [ ] First-run onboarding: if `Bridge[]` is empty, present the
      three options (Scan QR / Find / Paste URL), camera-first. (Today the
      empty state links to settings, which has QR + URL.)
- [x] Periodic re-discovery: `usePeriodicDiscovery` (mounted at root) probes
      every 5 min while foreground (AppState-gated); newly-seen bridges land in
      `useDiscoveryStore` and surface as a tappable "N new machine(s) on your
      tailnet" banner on the home inbox (add-all / dismiss).

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

- [x] Offline UX: unreachable bridges' rows fade and show "· offline"
      (stay visible); the Machines screen rows are tap-to-retry
      (`refreshBridge`). Opening an offline session shows the chat's
      connecting state.
- [x] Stale data: `lastSeenMs` shown on the Machines screen ("seen 2h ago").
- [x] Auth failure: a 401/403 demotes the bridge to `unauthorised`; inline
      rows show "· re-auth" (danger), and the Machines screen flags
      "re-auth needed". (A guided re-scan walk-through is still TODO — for
      now the user re-connects via Settings.)
- [x] Sidebar/switcher machine pill (dot + name), matching the inbox style.
- [ ] Smoke checklist (manual, needs a device): two online; one online +
      one offline; one online + one unauthorised; discovery with 3 peers;
      legacy single-bridge migration.

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

- **`tailscale serve` may not be running.** Auth depends on the
  serve-injected identity header. If serve isn't fronting the bridge,
  fall back to bearer token — never block startup. Smoke-test on Linux,
  macOS (CLI *and* GUI app), Windows. (This replaces the original
  whois-socket-path risk, which no longer applies — see hla.md.)
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
