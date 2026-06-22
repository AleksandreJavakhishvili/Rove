# Team Collaboration — Plan

Related: [frd.md](./frd.md), [hla.md](./hla.md)

Scope: managed per-machine **membership** + optional per-session
**participation**, an identity-aware **seat** (single active driver, passes
back), **mentions** (push + in-app), and a **Team screen** with a tailnet-wide
roster that fans out into authoritative per-machine lists. Role = full driver
only; bridge host = admin/owner. No central server; no third party in the path.

Phasing rationale: bridge-first and headless-testable before any UI. P0 pins the
wire/data contract. P1 (membership) and P2 (seat) are the security core and must
land with server-side enforcement + tests. P3 (mentions) rides existing push.
P4–P6 are the client surfaces, each an end-to-end, user-visible win. P7 is the
optional Tailscale-share enhancement.

DoD convention: a phase is done only when its objective DoD is demonstrably met
(unit/integration test or scripted smoke), not when boxes are merely checked.
Security gates (P1, P2) require a test that exercises them **with the client UI
off** — i.e. a raw request — since the threat model assumes a hostile client.

> **Decisions (2026-06-22):**
> - Default participation policy: **`open`, scope on demand** — member sees all
>   sessions by default; "scope to this session" at invite flips that bridge to
>   `scoped`. (Decided.)
> - Per-session participation: **in v1.** (Decided.)
> - Seat fallback on disconnect: vacant vs owner. (Still open; recommend vacant,
>   sensible default in place — not a P1 blocker.)

---

## Phase 0 — Wire contract + data model + types

DoD: new frame/route types compile in `bridge/src/types.ts` and
`mobile/lib/types.ts`; the `members.json` shape and `TeamFile` type exist; a raw
WS `claim_seat` / `user_message{mentions}` is parsed and routed (even if the
handlers are stubs); `docs/WIRE_PROTOCOL.md` documents every new frame/route.

- [ ] `TeamFile` / `Member` types + `participationPolicy` + `sessionParticipants` (`bridge/src/team.ts` types only)
- [ ] `ServerToClient`: `seat_changed`, `seat_denied`, `team_changed`
- [ ] `ClientToServer`: `claim_seat`, `release_seat`; extend `user_message` with `mentions?: string[]`
- [ ] Extend `SessionListItem` / session-info responses with a `seat` field (`currentDriver | null`)
- [ ] Mirror all of the above in `mobile/lib/types.ts`
- [ ] Document new frames + the `/team*`, `/participants`, `/seat` routes in `docs/WIRE_PROTOCOL.md`
- [ ] `server.ts onMessage` routes the new inbound frames to stubs (no behavior yet)

## Phase 1 — Bridge membership + participation (authoritative, server-side)

DoD: with the **client UI off** (raw `curl`/scripted requests): a non-member is
403; an admin can add/remove members and flip policy; under `scoped`, a member
can open only sessions they participate in (other sessions 403) while the owner
sees all; `members.json` persists across restart; an unwritable file degrades to
in-memory without crashing. All via unit/integration tests.

### Store — `bridge/src/team.ts` (new)
- [ ] Persist/load `~/.config/rove/members.json`; never throw on disk failure (mirror `resolveBridgeId`)
- [ ] `listMembers/addMember/removeMember/isMember/isAdmin`
- [ ] Owner auto-seed from the tailnet owner (today's `effectiveAllowedUsers` seed); owner is `role:'owner'`, unremovable, admin, always a participant
- [ ] `participationPolicy` get/set; `participants/addParticipant/removeParticipant`; `canSeeSession(user,agent,id)`
- [ ] Unit tests: add/remove/idempotent; owner-unremovable; open vs scoped `canSeeSession`; disk-failure fallback

### Auth — `bridge/src/auth.ts` (modify)
- [ ] `effectiveAllowedUsers()` = `team.listMembers()` ∪ `config.allowedUsers` (env override) ∪ owner — **membership** gate (FR-1)
- [ ] `requireParticipation(c, agent, id)` helper → 403 unless `canSeeSession` (FR-2)
- [ ] Apply `requireParticipation` to the per-session route group **and** the WS attach

### Endpoints — `bridge/src/server.ts`
- [ ] `GET /team` (any member); `POST /team/members`, `DELETE /team/members/:user`, `PUT /team/policy` (admin)
- [ ] `GET/POST/DELETE /sessions/:a/:id/participants` (read: participant; write: admin)
- [ ] Admin check helper (`auth.user` is `owner`/admin) returning 403 `admin only`
- [ ] Integration tests (raw requests): non-member 403; non-admin mutate 403; scoped cross-session 403; owner sees all

## Phase 2 — Bridge seat (identity-aware ownership + enforcement)

DoD: in a two-WS-client integration test, exactly one identity holds the seat;
only the holder's driving frames are honored (others get `seat_denied`); claim
transfers and broadcasts `seat_changed` to both clients and on `/events`;
holder-disconnect vacates within the grace window; the legacy desktop takeover
still works as the "seat held by desktop" special case.

### Runtime + broker — `bridge/src/runtime.ts`, `bridge/src/seatBroker.ts` (new)
- [ ] `currentDriver: { user; deviceLabel? } | null` per session in `runtime`; widen `claim()` to carry identity and be the single seat mutation point
- [ ] `seatBroker`: `claimSeat/releaseSeat/vacateOnDisconnect`, single-writer, anti-thrash cooldown, confirm-if-mid-turn
- [ ] `POST /sessions/:a/:id/seat { action }`; reconcile with existing `POST .../takeover` (desktop PIDs still SIGTERM→SIGKILL when the held "driver" is the desktop)
- [ ] Vacate on seat-holder WS disconnect after a bounded grace window (config: vacant | owner-fallback)

### Enforcement — `bridge/src/server.ts onMessage` + state-changing routes
- [ ] Gate driving frames (`user_message`, `resolve_request`, `interrupt`, `set_mode`, `set_model`, `rewind_to`, secret/handoff/screenshot replies) on `auth.user === currentDriver.user`; else emit `seat_denied { heldBy }` and do **not** enqueue
- [ ] Keep read-only frames/routes (history/status/diff/file/tree/preview/search) open to any participant
- [ ] Broadcast `seat_changed` on the session WS and `/events`
- [ ] `GET /sessions` + session-info include the `seat` field
- [ ] Integration tests (two raw clients): single-holder invariant; `seat_denied` on non-holder drive; transfer broadcast; disconnect→vacate; desktop-takeover regression

## Phase 3 — Bridge mentions + push attribution

DoD: a `user_message` with `mentions` delivers an Expo push **only** to that
identity's devices registered with this bridge, categorized `mention` with the
correct deep link; a mention to a person with no token is a no-op (logged), the
turn proceeds; verified by a scripted client + a stub push sink.

- [ ] `POST /devices` records `auth.user` with the token (FR-6); migrate existing entries (unknown user tolerated)
- [ ] `devices.pushToUser(user, payload)` filtering by attributed user; reuse Expo path + `category` field
- [ ] `onMessage`: on accepted `user_message` with `mentions`, `pushToUser` each with `{ category:'mention', bridgeId, agent, sessionId, fromUser, excerpt, url }`; best-effort, non-blocking
- [ ] Tests: mention→push targeting (right user only); no-token no-op; excerpt/deep-link payload shape

## Phase 4 — Client Team screen + tailnet-wide roster

DoD: on a device with ≥2 bridges, the Team screen lists people with status and
current seat; "apply to all machines" writes the identity into every reachable
bridge's list (verified by reading each `/team`); invite/remove work; per-machine
scope toggles work; partial fan-out failures are surfaced, not swallowed.

- [ ] `mobile/lib/people.ts`: `usePeople` slice persisted at `rove:people:v1`; `Person` type; deterministic colour by identity
- [ ] `applyToAllMachines(user, role)` fan-out (parallel + per-host timeout, like aggregator `refresh()`); per-bridge result reporting
- [ ] Fold `/team` reads into the aggregator's existing fan-out (no new polling loop); keep `onBridges` + seat fresh
- [ ] `mobile/app/team.tsx` mirroring `machines.tsx`: rows (colour, name, identity, online, "driving X on Y"); Invite (pick from `/peers` or type; scope: this machine | all | a session); Remove; per-machine toggles
- [ ] Header entry point next to the Machines icon

## Phase 5 — Client seat UI

DoD: on two devices/sims signed in as two identities against one bridge, the
chat header shows the correct holder on both; "Take the seat" transfers and both
update live; the non-holder's composer is disabled with the reason; losing the
seat shows a notice.

- [ ] Seat pill in the chat header ("You're driving" / "◆ Alex is driving")
- [ ] `heldByUser` variant of the `takeover_prompt` ChatItem (reuse the `session_busy` shell) with a **Take the seat** action → `POST /seat {claim}` or `claim_seat` frame
- [ ] Handle `seat_changed` (update pill, "Alex took the seat" notice) and `seat_denied` (surface "X is driving — take the seat?", don't drop)
- [ ] Disable composer + show reason when not the holder

## Phase 6 — Client mentions UI

DoD: the composer's mention picker offers people (this bridge's members);
sending serializes `mentions`; rendered messages show coloured `@name` chips; an
incoming mention to you increments a Team/inbox badge even with push off;
tapping a mention notification opens the right session (cross-bridge) and the
"Take the seat" notification action claims it.

- [ ] Extend the existing file mention picker with a **people source** from `usePeople` (filtered to bridge members)
- [ ] Serialize people mentions into `user_message.mentions`; render `@name` chips in person colour
- [ ] "@you" badge via the aggregator (in-app guarantee, push-independent)
- [ ] Register the `mention` notification category + actions (`Open`, `Take the seat`) alongside existing categories; background `Take the seat` → `POST /seat {claim}` (notification-actions pattern)
- [ ] Mention tap deep-links `rove://sessions/<a>/<id>?bridge=<id>`

## Phase 7 — (Enhancement) In-app Tailscale node-share

DoD: with a configured Tailscale API token, Invite can create the node share for
the bridge machine from inside Rove (no admin console), and emit a connect
payload/QR; without a token, Invite falls back to managing the allowlist + a
"share this machine in Tailscale" instruction. Clearly optional; not a v1 gate.

- [ ] Optional Tailscale API token in bridge config; `POST /team/share` to create a device share invite
- [ ] Client Invite flow uses it when present; graceful instruction fallback when absent
- [ ] Never required for membership/participation to work

## Out of scope (tracked, not built in v1)

- [ ] Read-only / reviewer / approver-only roles + per-tool restriction (most likely fast-follow; data model leaves room via `role`)
- [ ] Guest-over-Tailscale-Funnel (public URL + scoped token) "leaves your tailnet" invite mode
- [ ] Simultaneous co-driving / multi-cursor
- [ ] Web client Team UI (mobile first)
- [ ] Central server / automatic cross-bridge team sync; audit log; seat history; rotation/expiry

## Risks to watch

- **Enforcement must be server-side.** The biggest failure mode is gating only
  the UI. Every membership/participation/seat check needs a raw-request test
  with the client assumed hostile (P1, P2 DoD).
- **Seat correctness under races.** Two near-simultaneous claims, claim during a
  running turn, holder-disconnect mid-approval. The single-writer `seatBroker` +
  anti-thrash guard + broadcast-everywhere are the mitigations; test the races.
- **Trust clarity.** Full-driver = code execution on the host via the agent.
  The invite UI must say this; don't ship an invite that reads as "view only."
- **Mention delivery honesty.** Push is best-effort (per-bridge token only); the
  in-app "@you" badge is the guarantee. Don't imply guaranteed push, and don't
  add a relay to "fix" it (that reintroduces a third party).
- **Don't fork takeover.** Reuse `session_busy`/`takeover_prompt` and
  `runtime.claim`; a parallel seat mechanism would drift from the desktop case.
- **Per-machine remains the authority.** The tailnet-wide roster must never be
  able to grant access on its own — it only proposes fan-out writes.
