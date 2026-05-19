# Web client setup

The rove web client ([live demo](https://aleksandrejavakhishvili.github.io/Rove/)) is a
browser build of the same React Native app that ships on iOS and Android. To connect it
to your bridge, the bridge needs to be reachable over **HTTPS** — because GitHub Pages
serves the site over HTTPS, and modern browsers refuse to talk from an HTTPS page to a
plain `http://` endpoint (mixed-content blocking).

This page walks through the supported paths.

## Why HTTPS

Open the deployed web client in a browser and put `http://100.x.y.z:8443` as the bridge
URL. The connection fails with a generic network error. Open the devtools console — the
browser tells you the truth: it blocked the request because the page is HTTPS and the
target is HTTP. There is no flag, no header, no CORS dance that unblocks this from page
JavaScript. The fix is to expose the bridge itself over HTTPS.

## Option 1 — Tailscale Serve (recommended)

[Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve) gives any TCP port on
your machine a public name on your tailnet with a real, browser-trusted LetsEncrypt
certificate. No relay, no public exposure — only people on your tailnet can reach it.

On the machine running `rove-bridge`:

```sh
# Replace <bridge-port> with whatever port rove-bridge is listening on
# (usually 8443; check the URL the bridge prints on startup).
tailscale serve --bg --https=443 http://localhost:<bridge-port>
```

Tailscale prints the resulting URL — something like:

```
https://desktop.tailnet-abc.ts.net (Tailscale Funnel off)
|-- proxy http://localhost:8443
```

Open the web client, paste `https://desktop.tailnet-abc.ts.net` as the bridge URL, and
the token your bridge printed alongside the QR (if any), and you're connected.

To stop serving later:

```sh
tailscale serve --https=443 off
```

### Identity headers (optional, no token needed)

If you'd rather not paste a token, point `tailscale serve` at the bridge with identity
headers:

```sh
tailscale serve --bg --https=443 --identity-header http://localhost:<bridge-port>
```

The bridge already understands the forwarded identity. Leave the token field blank in
the web client.

## Option 2 — Run the web client locally (power users)

If you'd rather not expose your bridge to your tailnet at all, you can run the web
client over HTTP locally:

```sh
git clone https://github.com/aleksandrejavakhishvili/Rove
cd Rove/mobile
pnpm install
pnpm web
```

Open the dev server URL it prints (`http://localhost:8081`). Because the page is HTTP,
the browser is happy to talk to an HTTP bridge over your tailnet. No certificate, no
public name needed.

## What we don't recommend

**Tailscale Funnel.** Funnel exposes the bridge to the public internet over HTTPS. It
works, but it defeats the "no third-party touch, no public exposure" property that
motivates rove. If you want public access, use a regular reverse proxy in front of an
auth gate.

**Self-signed certs.** Browsers refuse to talk to self-signed origins without a
per-machine trust step that's painful to script. `tailscale serve` is strictly easier.

## Troubleshooting

- **"Your browser blocked the connection: the bridge URL is HTTP but this page is HTTPS."**
  You pasted an `http://` URL into the HTTPS-hosted web client. Follow Option 1 above
  and use the `https://*.ts.net` URL `tailscale serve` printed.
- **Connection works in one tab but not another.** Browsers cache mixed-content
  decisions per-origin. Hard-refresh (`Cmd-Shift-R` / `Ctrl-Shift-R`) the page after
  switching bridge URLs.
- **Certificate not trusted.** Tailscale issues certs via LetsEncrypt and they're
  trusted by default. If yours isn't, your system clock is probably wrong — fix that
  first.
- **iOS Safari refuses the camera for QR scan.** Camera access on iOS Safari requires a
  user gesture (a tap) before `getUserMedia` will resolve. Tap "Scan QR" first, then
  grant the permission prompt.
