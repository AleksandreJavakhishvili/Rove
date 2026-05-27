# Functional Requirements — Multi-Bridge Aggregator

## Problem

Today the mobile client talks to one bridge: settings holds a single
`baseUrl` + `token`, every API call passes that one config, the chat WS
connects to that one host. If you run Claude Code on more than one
machine — desktop + laptop + a headless mac mini, say — the phone can
see *one of them* at a time. To check the other, you re-point the app
at the second host's URL, which throws away the cached connection,
re-fetches sessions, and forgets the bridge you were just on.

Specific friction this creates today:

- **No cross-machine inbox.** "Which sessions are alive right now?"
  requires opening each bridge in turn. The most-recently-touched
  session across the fleet is invisible.
- **Per-machine onboarding doesn't scale.** Today each bridge has its
  own bearer token, displayed as a QR on the desktop's screen. A
  headless mac mini has no screen to show the QR. The current
  enrollment flow is desktop-only.
- **No notion of "which machine."** Once you're inside a session there's
  nothing in the UI that says "this is your iMac" vs "this is your
  MacBook." Project name + cwd hint at it but only after you've memorised
  every project's location.
- **Per-machine config drift is hidden.** If one machine is on an older
  bridge build, the user has no way to see that from the phone — they
  just see weird behavior on some sessions and not others.

For a "Rove drives all my dev boxes" workflow this means the phone is
effectively bound to one box at a time, which defeats the point of
having multiple machines on the same tailnet.

## Goals

1. **One unified sessions view across every machine on the tailnet.**
   Newest activity surfaces first regardless of host. Each row carries
   a machine pill so identity is visible without forcing a step.
2. **First-class machine identity.** Every chat / WS / approval call
   carries a `bridgeId` so the right bridge gets the right request,
   even when many bridges are connected at once.
3. **Zero-config enrollment of headless machines.** Install the bridge
   on a mac mini, it appears on the phone automatically without
   scanning a QR or copying a token. The single configuration step is
   "you're on the same tailnet as the phone."
4. **Tailscale identity is the auth.** No bearer tokens to rotate, no
   per-machine secrets. The bridge accepts a request iff the caller's
   Tailscale identity matches the bridge's owner.
5. **Graceful offline.** A machine that's asleep or unreachable
   degrades to "offline" on its rows; existing chats with reachable
   bridges keep working. No popups, no spinners-of-death.
6. **Backward compatible.** Existing single-bridge users keep working
   without re-onboarding. The current bearer-token path stays as a
   fallback for users who don't want Tailscale identity (or who
   tunnel from outside the tailnet).

## Non-goals

- **Cross-machine session migration.** A session belongs to one machine
  (its JSONL is on disk there). We are *not* moving sessions between
  hosts.
- **Push notifications when a machine is asleep.** Wanted, but a
  separate effort — needs a relay component this work intentionally
  doesn't introduce.
- **Discovery across tailnets.** Out of scope. One tailnet = one
  bridge fleet.
- **An "open in Tailscale Funnel" public endpoint.** Tailnet-only.
- **Multi-user / shared tailnets where each user sees their own
  bridges.** Identity gating is per-bridge ("this bridge's user is
  `you@example.com`"), not per-tailnet. Family-tailnet support is
  table-stakes but team-tailnet RBAC is not.

## User stories

**A — Power user with multiple machines.**
> I have an iMac and a MacBook and a mac mini, all on my tailnet. I
> want to glance at my phone and see every active session across the
> three, sorted by recent activity, and tap one to jump in. When I add
> a new mac mini I plug it in, run the install script, and it shows
> up on the phone within seconds without me touching the phone or the
> mini's screen.

**B — Single-machine user.**
> I have one mac. I scan one QR, the bridge is added, everything works
> like before. I never see the multi-bridge UI until I add a second
> machine.

**C — Tailscale-shy / remote user.**
> I want to access my bridge from outside my tailnet sometimes. The
> bearer-token path still works; Tailscale identity is offered but
> not required.

**D — Headless mac mini owner.**
> My mac mini lives in a closet with no monitor. I run the install
> script over SSH, the bridge starts, the next time I open my phone
> it shows up alongside my other machines. No QR, no port forwarding.

## Personas

**Aleks** — owns 2–4 machines on a personal tailnet. Already uses Rove
from one machine. Wants the rest.

**Aleks's roommate (shared tailnet)** — also on the tailnet, also
running their own bridge. The two phones must NOT see each other's
sessions even though both phones can reach both bridges by IP.

**A first-time user with one machine** — should not be punished by the
multi-bridge work. Their flow stays 1-step: scan QR, done.

## Definition of done (functional)

- The phone can be configured with N bridges (N ≥ 0). Adding a bridge
  is one of: (a) enter a tailnet hostname (auto-discovery via
  `/peers`), (b) scan a QR (existing flow), (c) paste a URL + token
  manually.
- The sessions list, sidebar, and approvals inbox aggregate across all
  configured bridges. Each item shows a machine pill.
- A filter chip strip at the top of the sessions list lets the user
  scope to "All" or one specific machine.
- Adding a new machine to the tailnet, installing the bridge there,
  and opening the phone results in the new machine appearing in the
  list without further user action.
- Removing a machine from the tailnet (or stopping its bridge) causes
  its rows to show as offline, not disappear.
- A user on a shared tailnet only sees bridges whose `tailscale whois`
  identity matches a user they've authorised on each bridge.
- The bearer-token path keeps working: a bridge without Tailscale
  identity available falls back to the existing auth.
- Existing single-bridge users upgrade in place: on first launch after
  the migration their old `{ baseUrl, token }` becomes a single entry
  in the new `Bridge[]` list.
