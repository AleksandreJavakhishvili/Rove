# Testing multi-bridge with a Docker "second machine"

Discovery (`/peers`) enumerates tailnet **devices** and the phone probes each
one's `/health`, so to exercise the multi-bridge flow you need a second device
on your tailnet. The fastest throwaway one is a Docker container that joins the
tailnet itself (`tailscaled` in userspace mode — works on Docker Desktop for
macOS, no `/dev/net/tun`).

Files live in `bridge/`: `Dockerfile`, `docker-entrypoint.sh`,
`docker-compose.yml`.

## 1. Get a Tailscale auth key

Create one at <https://login.tailscale.com/admin/settings/keys> — "reusable" +
"ephemeral" is convenient (the device auto-removes when the container stops).
Keep it owned by **your** account so its identity matches your phone's.

## 2. Build + run

```sh
cd bridge
export TS_AUTHKEY=tskey-auth-xxion
docker compose up --build          # or: docker compose up -d --build
```

You should see it join the tailnet (`rove-bridge-docker`), configure
`tailscale serve`, then `rove-bridge listening …`.

## 3. See it on the phone

- **Auto:** with the app already connected to your Mac, the periodic
  re-discovery (or reconnecting in Settings → magic moment) surfaces
  *"1 new machine on your tailnet"* → tap to add.
- **Manual:** Machines screen (chip icon, top-right) → **Find on my tailnet**.

It shows up **online with 0 sessions** (the container has no `claude`, so no
sessions). That's enough to verify discovery, the Machines screen, the machine
pill/colour, and offline behaviour (stop the container → its row goes offline).

## 4. (Optional) give it real sessions

To make it appear in the inbox with sessions and test cross-machine **approval
routing**, install + log into Claude Code inside the container and start a
session there:

```sh
docker compose exec rove-bridge sh -lc \
  'npm i -g @anthropic-ai/claude-code && claude /login && claude'
```

(Sessions live under `/data/claude-projects` in the container.)

## 5. Clean up

```sh
docker compose down            # add -v to also drop the tailscale state volume
```

An ephemeral auth key removes the device from your tailnet automatically;
otherwise delete `rove-bridge-docker` from the Tailscale admin console.

## Notes

- `ALLOWED_USERS` defaults to the auth key's account, which matches your phone —
  so the keyless serve path "just works". Override via the env var if needed.
- This is a **test/discovery target**, not a production deployment. The real
  headless-install story (`rove-bridge init` + a service unit) is separate.
