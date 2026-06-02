#!/usr/bin/env bash
# Brings the container up as a tailnet device, fronts the bridge with
# `tailscale serve` (the keyless identity path), then runs the bridge.
set -euo pipefail

: "${TS_AUTHKEY:?Set TS_AUTHKEY — create one at https://login.tailscale.com/admin/settings/keys}"
TS_HOSTNAME="${TS_HOSTNAME:-rove-bridge-docker}"
PORT="${PORT:-8443}"

echo "[entry] starting tailscaled (userspace networking)…"
tailscaled \
  --state=/var/lib/tailscale/tailscaled.state \
  --socket=/var/run/tailscale/tailscaled.sock \
  --tun=userspace-networking &

# Wait for the daemon socket before issuing commands.
for _ in $(seq 1 50); do
  [ -S /var/run/tailscale/tailscaled.sock ] && break
  sleep 0.2
done

echo "[entry] joining tailnet as '${TS_HOSTNAME}'…"
tailscale up --authkey="${TS_AUTHKEY}" --hostname="${TS_HOSTNAME}"

# Configure serve BEFORE the bridge starts so it detects the proxy and takes the
# keyless identity path (no bearer token). serve just stores the mapping; it
# proxies once the bridge is listening a moment later.
echo "[entry] fronting bridge with 'tailscale serve' (https :443 → 127.0.0.1:${PORT})…"
tailscale serve --bg --https=443 "http://127.0.0.1:${PORT}"

echo "[entry] starting rove-bridge on :${PORT}…"
exec env PORT="${PORT}" pnpm start
