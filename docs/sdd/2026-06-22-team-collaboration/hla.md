# Team Collaboration — High-Level Architecture

Related: [frd.md](./frd.md), [plan.md](./plan.md)
Builds on: [multi-bridge-aggregator](../2026-05-26-multi-bridge-aggregator/),
[preview-takeover](../2026-05-25-preview-takeover/),
[notification-actions](../2026-05-28-notification-actions/),
[cross-session-approvals](../2026-05-30-cross-session-approvals/).

## Scope

Turn the single-tenant bridge into a small **trusted-group** bridge: managed
membership, optional per-session participation, an identity-aware **seat**
(single active driver), mentions, and a Team screen. **No central server** —
the host bridge is the authority for its own sessions; the tailnet-wide team is
a client-side convenience that fans out into authoritative per-machine lists.

## Design principles

1. **The host bridge is the only authority.** Membership, participation, and the
   seat for a session live on the machine that hosts that session. This is the
   same pillar as the multi-bridge aggregator: the bridge stays per-machine; the
   client aggregates. We add *people* state to the bridge, not a new server.
2. **Authority is server-side; the roster is a cache.** Every access decision is
   made by the bridge from its own persisted list. The client's tailnet-wide
   roster only *proposes* writes (fan-out); it never grants access on its own.
3. **The seat generalizes takeover.** Today's desktop-vs-phone takeover
   (`runtime.claim`, `POST .../takeover`, `session_busy` → `takeover_prompt`) is
   the special case "something else holds this session." We widen "something
   else" from *the desktop process* to *another identity*, reusing the same
   frames and UI shells rather than inventing a parallel mechanism.
4. **Reuse the broker + push + roster patterns.** Seat claim/notify reuses the
   `handoffBroker` request/resolve shape; mention delivery reuses
   `devices.pushToAll` (extended to `pushToUser`); the Team screen reuses the
   `machines.tsx` + aggregator + per-entity-colour patterns.
5. **Two layers: membership vs participation.** *Membership* = "may this
   identity authenticate to this bridge at all" (the auth gate, today's
   `ALLOWED_USERS`). *Participation* = "which sessions may this member touch."
   Keeping them separate is what lets a person be machine-wide or session-scoped
   without changing the auth path.

## Topology

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Client (mobile RN)                                                       │
│                                                                          │
│  useBridges  ──┐                                                         │
│  useAggregator │  tailnet-wide People roster (NEW: usePeople)            │
│  usePeople ────┘   • person {identity, name, colour, perBridge scope}    │
│                    • "apply to all machines" → fan-out admin writes      │
│                                                                          │
│  Screens:  Machines (exists) ── sibling ──► Team (NEW)                   │
│            Chat: seat indicator + "Take the seat" + @mention picker      │
└───────────────┬──────────────────────────────────────────────────────────┘
                │  N× HTTPS/WSS over Tailscale (TS-identity / bearer)
   ┌────────────┼───────────────┬─────────────────────────────┐
   ▼            ▼               ▼                             ▼
┌────────┐  ┌────────┐     ┌────────┐                    each bridge:
│ iMac   │  │MacBook │     │mac-mini│                    AUTHORITATIVE
│ bridge │  │ bridge │     │ bridge │                    • members.json
│        │  │        │     │        │                    • participation policy
│members │  │members │     │members │                    • per-session seat
│ seat   │  │ seat   │     │ seat   │                    • per-user devices
└────────┘  └────────┘     └────────┘
```

## Components

### Bridge

#### Membership store — `bridge/src/team.ts` (new)
- Persists members at `~/.config/rove/members.json` (next to the existing
  `bridge-id` file from `config.ts`). Shape:
  ```ts
  interface Member { user: string; role: 'owner' | 'driver'; addedAt: number; }
  interface TeamFile {
    members: Member[];
    participationPolicy: 'open' | 'scoped';   // default 'open'
    // sessionParticipants only consulted when policy === 'scoped'
    sessionParticipants: Record<string /*"agent:sessionId"*/, string[] /*users*/>;
  }
  ```
- `listMembers()`, `addMember(user, role)`, `removeMember(user)`,
  `isMember(user)`, `isAdmin(user)`, `setPolicy(p)`,
  `participants(agent,id)`, `addParticipant`, `removeParticipant`,
  `canSeeSession(user, agent, id)`.
- Never throws on disk failure (mirrors `resolveBridgeId`): falls back to an
  in-memory list seeded from the env/owner for the run.
- The **owner** = the auto-derived tailnet owner (today's
  `effectiveAllowedUsers` seed). Always `role: 'owner'`, always present, never
  removable, always admin, always participates in all sessions.

#### Auth integration — `bridge/src/auth.ts` (modify)
- `effectiveAllowedUsers()` becomes `team.listMembers()` ∪ `config.allowedUsers`
  (env, kept as an override/break-glass) ∪ owner. This is **membership** (FR-1).
- New helper used by session routes: `requireParticipation(c, agent, id)` →
  403 unless `team.canSeeSession(auth.user, agent, id)` (FR-2). Applied to the
  per-session route group and the WS attach. Under `open` policy it's a cheap
  always-true for members.

#### Seat model — `bridge/src/runtime.ts` + `bridge/src/seatBroker.ts` (new)
- `runtime` gains per-session `currentDriver: { user: string; deviceLabel?: string } | null`.
- Today `runtime.claim(agent,id)` exists for desktop takeover; we widen it to
  carry the claiming identity and to be the single seat mutation point.
- Enforcement (the crux): in `server.ts onMessage` and the state-changing HTTP
  routes, a frame/route that *drives* the agent (`user_message`,
  `resolve_request`, `interrupt`, `set_mode`, `set_model`, `rewind_to`,
  secret/handoff/screenshot replies) is honored **only** if
  `auth.user === currentDriver.user`. Otherwise → `seat_denied { heldBy }`.
  Read-only frames/routes (history, status, diffs, file, tree, preview, search)
  are open to any participant.
- `seatBroker` (mirrors `handoffBroker`): `claimSeat`, `releaseSeat`,
  `vacateOnDisconnect`, single-writer guarantee, and a notify hook that pushes
  `seat_changed` to the prior holder. Seat-claim in v1 is **immediate** (all
  members are trusted full drivers; "seat passes back" freely), with a short
  anti-thrash guard and a confirm if the prior holder has a turn in flight.
- On WS disconnect of the seat holder: vacate after a bounded grace window
  (fallback to owner is configurable; default: vacant) and broadcast.

#### Mentions + push attribution — `bridge/src/devices.ts` (modify)
- `POST /devices` records `auth.user` with the token (FR-6).
- `pushToUser(user, payload)` filters the registry by attributed user; reuses
  the existing Expo push path and the `category` field from notification-actions
  (new category `mention`, action `Take the seat` / `Open`).
- `server.ts onMessage`: when a `user_message` carries `mentions`, after the
  message is accepted, call `pushToUser` for each mentioned identity with
  `{ category:'mention', bridgeId, agent, sessionId, fromUser, excerpt }` and a
  `rove://sessions/<agent>/<id>?bridge=<id>` deep link. Best-effort; never
  blocks the turn.

#### HTTP endpoints — `bridge/src/server.ts` (new)
All under the existing `authMiddleware`; mutating ones add an admin check.
```
GET    /team                      → { members, participationPolicy, owner, seats[] }   (any member)
POST   /team/members              → { user, role }            (admin)  add/update member
DELETE /team/members/:user        →                           (admin)  remove member
PUT    /team/policy               → { policy:'open'|'scoped' } (admin)
GET    /sessions/:a/:id/participants                          (participant)
POST   /sessions/:a/:id/participants    → { user }            (admin)   add to session
DELETE /sessions/:a/:id/participants/:user                    (admin)
POST   /sessions/:a/:id/seat       → { action:'claim'|'release' }       (participant) seat ops
```
- `GET /sessions` and `GET /sessions/:a/:id` gain a `seat` field
  (`currentDriver`), so the inbox and headers can render it without a second
  round-trip (mirrors how `/health` carries `tailscaleServe`).
- `POST /sessions/:a/:id/seat` supersedes the desktop-only
  `POST /sessions/:a/:id/takeover` (kept as an internal special case: claiming
  a seat held by the desktop still escalates SIGTERM→SIGKILL on the PIDs).

### Client (mobile RN)

#### People roster — `mobile/lib/people.ts` (new, sibling to `bridges.ts`)
- `usePeople` Zustand slice, persisted via `kv` under `rove:people:v1`.
  ```ts
  interface Person {
    user: string;           // tailscale identity
    name: string;           // editable label; default derived from identity
    colourSeed: string;     // = user; deterministic hue
    onBridges: string[];    // bridgeIds where we last saw them as a member
  }
  ```
- `applyToAllMachines(user, role)` → fan-out `POST /team/members` to every
  reachable bridge (parallel, per-host timeout, like the aggregator's
  `refresh()`); records results per bridge.
- Reads each bridge's `/team` during the aggregator's existing fan-out to keep
  `onBridges` and seat info fresh — no new polling loop.

#### Team screen — `mobile/app/team.tsx` (new, mirrors `mobile/app/machines.tsx`)
- Lists `Person` rows: colour dot, name, identity, online/offline (derived from
  whether any bridge reports them as the current driver or a connected device),
  and "driving: <session> on <machine>" when applicable.
- Actions: **Invite** (pick identity from a bridge's `/peers` device list or
  type it; choose scope: this machine / all machines / a session), **Remove**,
  **Per-machine membership** toggles. Reached from a header icon next to the
  Machines icon.

#### Seat UI — chat screen (`mobile/app/sessions/[agent]/[id]/index.tsx` + new bits)
- Header shows a **seat pill**: "You're driving" or "◆ Alex is driving".
- When a non-holder, a banner/affordance **Take the seat** (reuses the
  `takeover_prompt` ChatItem shell that `session_busy` already renders; we add a
  `heldByUser` variant alongside the existing desktop-PID variant).
- On `seat_changed` frames, update the pill and, if you just lost the seat, show
  a brief "Alex took the seat" notice. Composer is disabled (with the reason)
  when you don't hold the seat.

#### Mentions UI — composer + message rendering
- The mention picker already exists for files (the chat invalidates a "mention
  picker cache" on `file_changed`). Add a **people source** to that picker fed
  by `usePeople` filtered to this bridge's members.
- A sent message serializes people mentions into the `user_message`'s new
  `mentions: string[]` field; rendered messages show `@name` chips in the
  person's colour. Incoming `@you` increments a Team/inbox badge via the
  aggregator (guaranteed in-app surface, independent of push).

#### Notifications — `mobile/lib/push.ts` + `notifications/` (modify)
- `POST /devices` call includes nothing new client-side (the bridge attributes
  by `auth.user`); the mention `category` and its actions register alongside the
  existing `permission-prompt` / `handoff-request` categories.
- Tap on a mention → `rove://sessions/<a>/<id>?bridge=<id>`; the `Take the seat`
  action posts `POST /sessions/:a/:id/seat {action:'claim'}` from the background
  handler (same pattern as notification-actions resolving a permission).

### Transport (wire) — `bridge/src/types.ts` + `mobile/lib/types.ts` + `docs/WIRE_PROTOCOL.md`

New `ServerToClient` frames:
```ts
| { type:'seat_changed'; agent; sessionId; holder: { user; deviceLabel? } | null; reason:'claimed'|'released'|'vacated'|'fallback' }
| { type:'seat_denied'; agent; sessionId; heldBy: { user; deviceLabel? } }
| { type:'team_changed'; members: Member[]; participationPolicy:'open'|'scoped' }   // on /events
```
New / extended `ClientToServer` frames:
```ts
| { type:'claim_seat'; }      // on the per-session WS (or via POST /seat)
| { type:'release_seat'; }
// user_message gains:
| { type:'user_message'; text: string; mentions?: string[] }
```
`seat_changed` and `team_changed` also ride the bridge-wide `/events` stream
(the same channel `usePendingPermissions` already consumes) so non-focused
surfaces update.

## Key flows

### Invite to a single session (scoped)
```
Owner (admin) on Team screen → Invite → pick identity U, scope = "this session"
Client: POST /team/members { user:U, role:'driver' }           (membership)
        PUT  /team/policy  { policy:'scoped' }  (if not already)
        POST /sessions/:a/:id/participants { user:U }           (participation)
Bridge: team.addMember(U); team.addParticipant(a,id,U); persists members.json
        broadcasts team_changed on /events
U opens Rove (already on tailnet / shared node): /sessions filtered by
        canSeeSession → only :id is visible/drivable; other sessions → 403
```

### Mention → notify → take the seat
```
Driver A types "@bob can you check this" → sends
  user_message { text, mentions:['bob@...'] }
Bridge: appends message (normal turn path); then
  pushToUser('bob@...', { category:'mention', bridgeId, agent, sessionId,
                          fromUser:A, excerpt, url:'rove://…?bridge=…' })
Bob's phone: mention banner → tap → opens the session (cross-bridge via ?bridge)
  Bob sees "A is driving"; taps Take the seat
  POST /sessions/:a/:id/seat { action:'claim' }   (or claim_seat WS frame)
Bridge: seatBroker.claimSeat(sessionId, bob)
  currentDriver = bob; pushes seat_changed to A ("Bob took the seat")
  broadcasts seat_changed on session WS + /events
Now only Bob's prompts/approvals are honored; A's composer disables with reason.
```

### Non-holder tries to drive
```
A holds the seat. Bob (participant, no seat) sends user_message.
Bridge onMessage: auth.user(bob) !== currentDriver(A)
  → reply seat_denied { heldBy:A }   (message NOT enqueued to the agent)
Bob's client: shows "A is driving — take the seat?" (does not silently drop)
```

### Seat holder disconnects
```
Bob holds the seat; WS drops.
Bridge: grace timer (bounded). On expiry with no reconnect:
  currentDriver = null (or owner, if fallback configured)
  broadcast seat_changed { holder:null, reason:'vacated' }
Anyone eligible can now claim. (Mirrors handoffBroker's cancel-on-disconnect.)
```

## Tech stack

- **No new bridge dependencies.** Members persist as JSON beside `bridge-id`;
  seat state is in-memory in `runtime`; mentions reuse the Expo push path.
- **No new auth model.** Membership extends `effectiveAllowedUsers`;
  participation is a new check on the same `authMiddleware`-protected routes;
  admin = the existing owner identity. Tailscale-identity / bearer unchanged.
- **No new transport.** New frames ride the existing per-session WS and the
  `/events` stream.
- **Client reuse.** Team screen ≈ `machines.tsx`; roster ≈ `bridges.ts`; seat
  UI ≈ `takeover_prompt`; mention picker extends the existing file picker.

## Cross-cutting concerns

### Where authority lives
| Decision | Authority | Notes |
|---|---|---|
| May U authenticate to this bridge? | bridge `members.json` | membership (FR-1) |
| May U open session S? | bridge participation (`open`/`scoped`) | FR-2 |
| Who drives S right now? | bridge `runtime.currentDriver` | the seat (FR-3) |
| Tailnet-wide "the team" | client `usePeople` roster | convenience only; fans out to the above |

### Enforcement, not decoration
A participant is on your network and can `curl` the bridge directly. Every
gate — membership, participation, seat — is enforced in the bridge
(`authMiddleware`, `requireParticipation`, the `onMessage` seat check), with the
client UI assumed hostile. UI affordances (disabled composer, hidden sessions)
are ergonomics, never the control.

### Mention delivery is best-effort push + guaranteed in-app
A bridge can only push to a person who has registered a device with **it**. If
the mentioned person never connected to that bridge, there is no token and the
push is skipped — but the mention is in the transcript and the aggregator
surfaces an "@you" badge on next open. We do **not** add a central relay to
close this gap (that would reintroduce a third party). Stated explicitly so it
reads as a drawn boundary, not a silent omission.

### Seat thrash / mid-turn claims
Claiming while a turn is in flight is allowed (members are trusted), but: the
running turn completes, pending approvals re-route to the new holder, and a
short cooldown + a confirm-if-mid-turn guard prevents two clients fighting over
the seat in a tight loop.

### Idempotency
- Member add/remove and policy set are last-writer-wins on the JSON file;
  re-adding an existing member is a no-op update.
- `seat claim` by the current holder is a no-op; a duplicate `release` is
  benign. Seat ops carry no client-minted ids — the bridge is the single writer.

### Failure paths
| Failure | Behavior |
|---|---|
| `members.json` unwritable | in-memory list for the run; logged; owner still admin |
| Non-admin hits a mutating team route | 403 `forbidden: admin only` |
| Non-participant opens a session (scoped) | 403 `forbidden: not a participant` |
| Non-holder sends a driving frame | `seat_denied { heldBy }`; not enqueued |
| Seat holder disconnects | grace timer → vacate/fallback → broadcast |
| Mention target has no device on this bridge | push skipped; in-app badge only |
| Fan-out "apply to all" partially fails | per-bridge result surfaced; authoritative lists that did take are correct |

### Observability
Bridge logs (no secrets): `[team] add member bob@… role=driver`,
`[team] policy=scoped`, `[seat] a:abc claim bob@… (was A)`,
`[seat] a:abc vacate (disconnect)`, `[mention] a:abc → bob@… push=sent|no-token`.

## Open questions (settle in plan / review)

1. **Default participation policy.** **RESOLVED — `open`, scope on demand.**
   A member sees all sessions on a machine by default; "scope to this session"
   at invite time adds them as an explicit participant and flips that bridge to
   `scoped`; `scoped` is also a one-toggle on the Team screen. (Owner decision,
   2026-06-22.)
2. **Seat fallback on disconnect.** Vacant (anyone claims) vs fall back to owner.
   Recommendation: vacant by default; owner-fallback as a per-bridge setting.
3. **Is per-session participation a v1 gate or a fast-follow?** **RESOLVED —
   v1.** It ships with membership as the primary blast-radius control given
   full-driver-only. (Owner decision, 2026-06-22.)
4. **In-app Tailscale node-share via API** — enhancement vs v1. Recommended:
   enhancement; v1 manages the allowlist + emits the connect payload.
