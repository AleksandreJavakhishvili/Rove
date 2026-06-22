# Team Collaboration — FRD

Related: [hla.md](./hla.md), [plan.md](./plan.md)

## Problem

Today a Rove bridge is single-tenant. `ALLOWED_USERS` (or the auto-derived
tailnet owner) is treated as **one person** — every allowed identity is
indistinguishable from the owner, can open every session, and there is no
notion of "who is driving" because only one human was ever assumed.

But the work isn't always solo. A user wants to pull a teammate into a running
session — to look at what the agent did, approve a step, or take the wheel and
continue the work — without handing over the whole machine by accident and
without routing anything through a third party. Concretely, they want to:

1. **Invite a trusted person** onto their tailnet (or a single machine, or even
   a single session) so that person gets the same Rove surface they have:
   history, live diffs, tool cards, approvals, and the dev-server preview.
2. **@mention that person inside a session's chat**, which pings them with a
   notification that deep-links straight to that session.
3. Let the mentioned person **review and then take the session over** — become
   the active driver, send the next prompts, answer approvals — and hand the
   seat back later. The agent never leaves the machine that hosts it.
4. **See and manage their people** in one place: a Team screen, sibling to the
   existing Machines screen.

All of this must hold Rove's core promise: your machines, your tailnet, nobody
else in the path.

## v1 scope (this document)

A **single role — full driver** — plus the coordination and surfaces that make
shared sessions safe and legible:

- **Membership** (bridge-level): a managed, persisted allowlist of identities
  permitted on a machine, replacing the static `ALLOWED_USERS` env list. The
  bridge host is the **admin/owner** and is always present.
- **Participation** (session-level): which members may see/drive a given
  session. A per-bridge **default policy** (open: all members | scoped: only
  explicitly-added members) plus explicit per-session add/remove. This is what
  makes "invite to one session, not the whole machine" possible.
- **The seat**: identity-aware session ownership. Exactly one active driver at a
  time; the seat can pass back and forth. Generalizes the existing
  desktop-vs-phone takeover into person-vs-person.
- **Mentions**: `@person` in a session chat → best-effort push notification with
  a deep link, guaranteed in-app surfacing.
- **Team screen + tailnet-wide roster**: a client-side people list with
  "apply to all machines" fan-out, online/seat status, and invite / remove.

### Scope of "both" (per-machine and tailnet-wide)

Per your decision, team scope is **both**:

- **Per machine is the source of truth.** Each bridge owns its own
  authoritative membership list. This is the security boundary, because an
  invited person is on your network and can reach a bridge's endpoints
  directly — so each bridge must decide for itself who is allowed.
- **Tailnet-wide is a client convenience on top.** The client holds the roster
  of all your people; "apply to all machines" fans an identity out into every
  bridge's per-machine list in one action. There is **no central server** and
  no cross-bridge sync daemon — global membership is just a fan-out write into
  the authoritative per-machine lists.

## Trust model (read this first)

**A full driver can do anything the agent can do on your machine.** The agent
has Bash and file access; a teammate who holds the seat can run commands, read
and write files, and spend your model budget on the host box. Inviting someone
as a full driver is therefore equivalent to **granting them code execution on
that machine, mediated by the agent**, for the sessions they participate in.

v1 has **no read-only / reviewer tier** (see Non-goals). That means there is no
"safe to watch only" invite yet — every invited participant is a full driver.
The UI must state this plainly at invite time. Per-session participation
(scoped policy) is the main blast-radius control in v1: invite someone to the
one session you want them in, not the whole machine.

## What v1 guarantees (and what it does not)

**v1 guarantees:**
- An invited identity can only act on a bridge if it is in that bridge's
  authoritative membership list — enforced server-side, not just hidden in the
  UI. Removing them from the list revokes access immediately for new requests.
- Under the **scoped** participation policy, a member can only open/drive
  sessions they were explicitly added to. Enforced on every session route and
  on the WS attach, not only in the client.
- At most one identity holds the seat for a session at any moment. Only the seat
  holder's prompts and approvals are honored; a non-holder is told who is
  driving and offered the seat.
- The agent process and its files never move. The seat is pure coordination
  state on the host bridge.
- No turn, mention, or seat change traverses a third-party server. Mentions use
  Apple/Google push only for the device *wake* (unavoidable for any phone app);
  the content surfaces in-app over the existing tailnet transport.

**v1 does NOT guarantee:**
- It does **not** sandbox a full driver. There is no read-only tier and no
  per-tool restriction beyond the existing approval prompts. See Trust model.
- It does **not** prevent a member, once allowed on a bridge under the **open**
  policy, from opening any session on that bridge. Per-session confinement
  requires the **scoped** policy.
- It does **not** sync team state across machines automatically. "Apply to all"
  is an explicit, client-driven fan-out; bridges you didn't fan out to don't
  know about the person.

## Goals (v1)

1. **Invite without oversharing.** A user can invite a person at the right
   altitude: this machine, all machines, or a single session.
2. **One active driver, legible.** Everyone can always see who holds the seat;
   taking and returning it is one tap and is broadcast to all watchers.
3. **Mentions that reach the person.** `@someone` notifies them and lands them
   in the exact session, even across machines.
4. **People managed in one place.** A Team screen mirrors Machines: who's on the
   team, their status, what they're driving, and the invite / remove controls.
5. **No new trust hole.** All enforcement is server-side on the authoritative
   per-machine list; the tailnet-wide roster is a convenience, never an
   authority.

## Non-goals (v1)

- **Viewer / reviewer / approver-only roles.** v1 is full-driver only. Tiered
  roles are the most likely fast-follow (the data model leaves room — see HLA).
- **Guest-over-public-URL (Tailscale Funnel) mode.** Inviting someone who never
  installs Tailscale, via a public URL + scoped token, is a separate,
  clearly-labeled "leaves your tailnet" feature. Not in v1.
- **Simultaneous co-driving / real-time multi-cursor.** One seat at a time.
- **Central server / automatic cross-bridge team sync.** Client-side fan-out
  only.
- **Web client parity.** Mobile (Expo RN) first; web Team UI deferred, as with
  the multi-bridge aggregator.
- **Standalone person-to-person chat** outside a session. Mentions live inside a
  session's existing chat.
- **Audit log, seat history, rotation, expiry.** Track later if a need appears.
- **In-app Tailscale node-share via the Tailscale API.** v1 manages the bridge
  allowlist and emits a connect payload; the actual node share can still be done
  in Tailscale. Doing the share fully in-app via the Tailscale API is a tracked
  enhancement (see plan), not a v1 gate.

## Personas

- **Owner (primary).** Runs one or more bridges. Wants to pull a teammate into a
  session occasionally without giving away the farm. Is the admin on their own
  machines.
- **Invited driver.** A trusted teammate on the same tailnet (via a shared node
  or full membership). Gets pinged into a session, reviews, takes the seat,
  continues the work, hands it back.

## User stories

### US-1: Invite a person to a machine
> As an owner, I want to add a teammate to one of my machines so they can see
> and drive its sessions with the same surface I have.

Acceptance:
- The owner adds a person by Tailscale identity (picked from the tailnet device
  list or typed). The bridge persists them in its authoritative membership list.
- The person, once on the tailnet/shared node, opens Rove and the machine's
  sessions appear with full functionality (history, diffs, approvals, preview).
- The invite UI states plainly that the person will be a **full driver**.

### US-2: Invite a person to a single session only
> As an owner, I want to invite someone to just one session, not everything on
> the machine.

Acceptance:
- With the bridge's participation policy set to **scoped**, the owner adds a
  person to a specific session; that person can open/drive only that session.
- Attempting to open any other session on that bridge fails server-side
  (403), not just hidden in the client.
- Removing them from the session revokes it immediately for new requests.

### US-3: Mention a person in a session
> As a driver, I want to `@mention` a teammate in the chat so they get pinged
> and land in this exact session.

Acceptance:
- The composer offers a people picker (the same mention affordance used for
  files, extended to people on the team).
- Sending a message with `@person` delivers a push (if that person has a device
  registered with this bridge) titled with the mentioner and an excerpt, whose
  tap opens this session — across machines, via the `?bridge=` deep link.
- If no push token is known for them, the mention still lands in the transcript
  and surfaces as an "@you" badge the next time they open Rove (guaranteed
  in-app, best-effort push).

### US-4: Take the seat, then hand it back
> As an invited driver, after I review what happened, I want to take over and
> continue, and later give the seat back.

Acceptance:
- The session shows who currently holds the seat. A non-holder sees "X is
  driving" and a **Take the seat** action.
- Taking the seat makes the taker the only honored driver: their prompts run,
  approvals route to them. The prior holder is notified they no longer hold it
  and can take it back.
- The agent keeps running on the host machine throughout; nothing migrates.
- Only one identity holds the seat at any instant (enforced server-side).

### US-5: See and manage the team
> As an owner, I want one screen showing my people, their status, and controls
> to invite or remove them.

Acceptance:
- A Team screen lists each person: name, identity, online/offline, and which
  session (and machine) they currently drive, if any.
- The owner can invite, remove, and choose per-person scope: this machine, all
  machines (fan-out), or specific sessions.
- Removing a person drops them from the selected machines' authoritative lists;
  their in-flight requests stop being honored.

### US-6: Seat is never stuck
> As any participant, if the current driver drops off, I don't want the session
> frozen.

Acceptance:
- If the seat holder disconnects, the seat goes vacant (or falls back to the
  owner) within a bounded window, so anyone eligible can take it.
- A vacated seat is broadcast like any other seat change.

## Functional requirements (v1)

### FR-1: Authoritative per-machine membership
Each bridge persists a mutable membership list (identities + role, role =
`owner | driver` in v1). `effectiveAllowedUsers()` resolves to this list,
unioned with any `ALLOWED_USERS` env and the auto-derived owner. The owner
identity is always present and cannot be removed. Admin-only endpoints mutate
the list; mutations take effect immediately for subsequent requests.

### FR-2: Session participation + policy
Each bridge has a **participation policy**: `open` (any member participates in
any session) or `scoped` (a member participates only in sessions they're added
to). Under `scoped`, every session route and WS attach checks participation and
returns 403 for non-participants. The owner always participates in all sessions.

### FR-3: The seat (identity-aware ownership)
The bridge tracks a single `currentDriver` per session. Only the holder's
`user_message`, approval resolutions, interrupts, and other state-changing
frames are honored; a non-holder's state-changing frame is rejected with a
"held by X" reason. Read-only streaming (history, diffs, preview) is available
to any participant regardless of the seat. Claiming the seat is one request;
the prior holder is notified; releasing or disconnecting vacates it.

### FR-4: Seat broadcast
Every seat change (claim, release, vacate-on-disconnect, fallback) is broadcast
on the session WS and on the bridge-wide `/events` stream, so every watcher and
the Team/Machines surfaces update without polling.

### FR-5: Mentions
A `user_message` may carry structured `mentions` (identities). On receipt, the
bridge delivers a best-effort push to each mentioned identity's devices
registered with **this** bridge, categorized as a mention, carrying
`{ bridgeId, agent, sessionId, fromUser, excerpt }` and a deep link. Delivery
never blocks the message; absence of a push token is not an error.

### FR-6: Device-to-identity attribution
`POST /devices` records the authenticated identity alongside the push token, so
the bridge can address a push to a specific person (`pushToUser`) rather than
only broadcasting to all devices.

### FR-7: Tailnet-wide roster + fan-out
The client maintains a people roster across all known bridges and offers
"apply to all machines," which writes the identity into each reachable bridge's
membership list via FR-1's admin endpoint. Per-machine membership remains the
authority; the roster is a convenience cache and never gates access by itself.

### FR-8: Team screen
A client screen (sibling to Machines) lists people with status and current
seat, and exposes invite / remove / scope controls. People get a deterministic
colour (hash of identity) used consistently across the seat indicator, mention
chips, and the roster, mirroring the per-machine colour convention.

### FR-9: Admin gating
Membership and participation mutations require the caller to be the bridge
owner (admin). All team endpoints ride the existing Tailscale-identity / bearer
auth; no new credential type.

## Out of scope

- The read-only / reviewer tier, per-tool restriction, and any agent
  sandboxing — deferred; v1 is full-driver, and the trust model says so plainly.
- Guest-over-Funnel (public URL + token) invites — separate, labeled feature.
- In-app Tailscale node-share via the Tailscale control API — enhancement.
- Web client Team UI — deferred (mobile first).
- Cross-bridge automatic sync, audit log, seat history, rotation/expiry.

## Success metrics (v1)

- **Invite lands.** An owner can add a teammate to a machine (or a single
  session) and that teammate sees exactly the intended scope — verified by
  attempting an out-of-scope session and getting a server-side 403.
- **One driver, always legible.** In a two-client test, only the seat holder's
  prompts run; the other client always shows the correct holder and can take
  the seat; the seat is never simultaneously held by two identities.
- **Mention reaches the person.** A mention delivers a push that deep-links to
  the right session on the right machine when a token exists, and always
  surfaces in-app when it doesn't.
- **No new trust hole.** Removing a person from a bridge's list immediately
  stops new requests from them; scoped participation blocks other sessions —
  both verified server-side, with the client UI off.
