# Bridge setup

Three deployment modes, from dev to production. Pick one.

## Quick reference

| Mode | URL on phone | Auth | When to use |
|---|---|---|---|
| Local LAN (dev) | `http://<laptop-LAN-IP>:8443` | bearer token | testing on same wifi |
| Tailscale IP | `http://<tailscale-100.x.x.x>:8443` | bearer token | working anywhere over cellular, quick path |
| Tailscale serve + TLS | `https://<hostname>.<tailnet>.ts.net` | Tailscale identity (no token) | the proper setup |

---

## Prerequisites (all modes)

- `claude` CLI installed and logged in (`claude /login` or `ANTHROPIC_API_KEY` env var).
- Node 22+ and `pnpm`.
- macOS file-descriptor limit raised in the shell running the bridge:
  ```bash
  ulimit -n 8192
  ```

Bridge dependencies:
```bash
cd bridge
pnpm install
```

---

## Mode 1 — Local LAN (dev)

Quickest way to test on your phone while on the same wifi.

```bash
cd bridge
ulimit -n 8192
HOST=0.0.0.0 BEARER_TOKEN=dev-local pnpm start
```

On your phone (same wifi), Settings → set:
- Bridge URL: `http://<your-laptop-LAN-IP>:8443` (find via `ipconfig getifaddr en0`)
- Bearer token: `dev-local`

Only works when phone and laptop are on the same network. macOS firewall may need to allow incoming connections on port 8443.

---

## Mode 2 — Tailscale IP (works anywhere)

Lets your phone reach the bridge from cellular / coffee shop wifi, through Tailscale's encrypted tunnel.

### Install Tailscale

- macOS: <https://tailscale.com/download>
- iOS: <https://apps.apple.com/app/tailscale/id1470499037>
- Android: <https://play.google.com/store/apps/details?id=com.tailscale.ipn>

Log into the **same Tailscale account** on both devices.

### Start the bridge

```bash
cd bridge
ulimit -n 8192
HOST=$(tailscale ip -4 | head -1) BEARER_TOKEN=dev-local pnpm start
```

This binds the bridge **only to the Tailscale interface** (`100.x.x.x`). Your LAN can no longer reach it.

### Configure the phone

Settings → set:
- Bridge URL: `http://100.x.x.x:8443` (your Mac's Tailscale IP, get from `tailscale ip -4` on Mac)
- Bearer token: `dev-local`

Test from cellular to confirm the tunnel works.

---

## Mode 3 — Tailscale serve + TLS + auto-auth (recommended)

Adds:
- **HTTPS with a real Let's Encrypt cert** (no self-signed warnings).
- **Auto-auth via Tailscale identity headers** — no bearer token to manage.
- **Standard HTTPS port** — phone uses a clean `https://...` URL with no port.

### One-time tailnet setup

1. Go to <https://login.tailscale.com/admin/dns>.
2. Enable **MagicDNS** (probably already on).
3. Enable **HTTPS Certificates** — required to provision Let's Encrypt certs for your `.ts.net` hostname.

### Get your hostname

```bash
tailscale status | head -3
# yields something like:
# 100.64.1.5  mybox  ako@  macOS   -
```

Your machine's `.ts.net` URL is `https://<machine-name>.<tailnet-name>.ts.net`. Example: `https://mybox.tail-scales.ts.net`. You can also see it in the Tailscale admin UI under your device.

### Start the bridge on loopback

```bash
cd bridge
pnpm start
```

That's it. No env vars. The bridge:

- Raises its own FD limit automatically (`ulimit -n 8192`).
- Defaults to listening on `127.0.0.1:8443`.
- **Auto-detects the Tailscale device owner's email** from `tailscale status --json` and uses that as the implicit `ALLOWED_USERS` — only your own tailnet identity can reach the bridge.

If you want to allow additional tailnet users (e.g., a teammate), set the env var explicitly:

```bash
ALLOWED_USERS=alice@example.com,bob@example.com pnpm start
```

### Front it with tailscale serve

In a separate terminal:

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:8443
```

What this does:
- Listens on your Tailscale interface, port **443** (standard HTTPS, sudo required for low port).
- Forwards traffic to `127.0.0.1:8443` (the bridge).
- Provisions a valid Let's Encrypt cert for your `.ts.net` hostname (auto-renewed).
- Injects `Tailscale-User-Login`, `Tailscale-User-Name`, `Tailscale-User-Profile-Pic` headers based on the authenticated tailnet device.

Check it's running:
```bash
tailscale serve status
```

### Configure the phone

Settings → set:
- Bridge URL: `https://<machine>.<tailnet>.ts.net`
- Bearer token: **leave blank**

Tap **Test & save**. The health endpoint returns `{ok: true, user: "<your-email>", ...}` — the bridge knows it's you because Tailscale signed the request.

### Stopping tailscale serve

```bash
sudo tailscale serve reset
# or
sudo tailscale serve --https=443 off
```

---

## Multi-user (sharing with others)

Use Mode 3. Each friend:
1. Joins your tailnet (you invite them via Tailscale admin UI).
2. Installs the mobile app on their phone.
3. Sets Bridge URL to your machine's `.ts.net` URL.
4. Their Tailscale identity gets validated against `ALLOWED_USERS`.

Default behavior allows only **you** (auto-detected). To grant access to friends, set `ALLOWED_USERS` explicitly:

```bash
ALLOWED_USERS=you@example.com,friend@example.com pnpm start
```

You control who can reach your sessions via the tailnet ACL + `ALLOWED_USERS`.

---

## Auto-start on boot (macOS)

Run the bridge as a `launchd` service. Sketch — adapt to your tastes:

```xml
<!-- ~/Library/LaunchAgents/com.rove.bridge.plist -->
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.rove.bridge</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/zsh</string>
      <string>-lc</string>
      <string>cd /path/to/rove/bridge && /usr/local/bin/pnpm start</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>/tmp/rove-bridge.log</string>
    <key>StandardErrorPath</key><string>/tmp/rove-bridge.err</string>
  </dict>
</plist>
```

The bridge raises its own FD limit and auto-detects the Tailscale owner — no explicit env vars needed for single-user setups.

Load with `launchctl load -w ~/Library/LaunchAgents/com.rove.bridge.plist`.

`tailscale serve` settings persist across reboots automatically.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `spawn EBADF` in bridge log | macOS FD limit too low — `ulimit -n 8192` before starting |
| Phone hangs on "Test & save" | wrong URL, firewall, or wifi guest isolation; verify with `curl <url>/health` from a third device |
| Phone reaches `/health` but gets 401/403 | `ALLOWED_USERS` doesn't include your Tailscale email, or wrong bearer token |
| `MCP tool ... not found` in claude stderr | the MCP permission server failed to spawn; check the `tsx` path in the bridge's spawn args is absolute |
| `Tailscale serve` errors with "HTTPS certificates are disabled" | enable HTTPS Certificates in the tailnet admin DNS page |
| HTTPS cert provisioning hangs | run `tailscale cert <hostname>` manually once, then retry `tailscale serve` |
