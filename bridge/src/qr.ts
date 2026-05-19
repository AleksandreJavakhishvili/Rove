import qrcode from 'qrcode-terminal';
import { config, runtimeState } from './config.ts';

interface ConnectionInfo {
  url: string;
  token?: string;
  /** Where the URL came from, for the human-readable hint. */
  source: 'tailscale-serve' | 'tailscale-ip' | 'lan' | 'loopback';
}

function pickConnectionUrl(): ConnectionInfo {
  const { bindHost, tailscaleHostname, tailscaleServing, urlScheme } = runtimeState;

  // 1. tailscale serve fronting → HTTPS URL on standard 443, no port.
  if (tailscaleServing && tailscaleHostname) {
    return { url: `https://${tailscaleHostname}`, source: 'tailscale-serve' };
  }

  // 2. We acquired our own TLS cert → use the hostname so cert validates.
  if (urlScheme === 'https' && tailscaleHostname) {
    return { url: `https://${tailscaleHostname}:${config.port}`, source: 'tailscale-ip' };
  }

  // 3. Bridge bound directly to a Tailscale IP (100.x), no TLS.
  if (/^100\./.test(bindHost)) {
    return { url: `http://${bindHost}:${config.port}`, source: 'tailscale-ip' };
  }

  // 4. Bridge bound to all interfaces — prefer Tailscale hostname if Tailscale is up.
  if (bindHost === '0.0.0.0') {
    if (tailscaleHostname) {
      return { url: `http://${tailscaleHostname}:${config.port}`, source: 'tailscale-ip' };
    }
    return { url: `http://<your-LAN-IP>:${config.port}`, source: 'lan' };
  }

  // 5. Loopback only.
  return { url: `http://127.0.0.1:${config.port}`, source: 'loopback' };
}

export async function printConnectionQR(): Promise<void> {
  const info = pickConnectionUrl();
  const payload: Record<string, unknown> = { url: info.url };
  if (runtimeState.bearerToken) payload.token = runtimeState.bearerToken;
  const qrPayload = JSON.stringify(payload);

  // Universal deep link — tapping this on the phone (if the link is shared via
  // Messages / email / Notes) opens the Rove app at Settings with this URL/token
  // pre-filled. Modern terminals like iTerm / Terminal.app render it as clickable.
  const deepParams = new URLSearchParams({ url: info.url });
  if (runtimeState.bearerToken) deepParams.set('token', runtimeState.bearerToken);
  const deepLink = `rove://settings?${deepParams.toString()}`;

  // Web deep link — clicking opens the deployed web client with credentials
  // pre-filled via URL fragment (browsers never send fragments to the server,
  // so the token is not in GitHub Pages access logs). Only printed when the
  // operator has pointed at a deployed instance.
  const webBase = process.env.ROVE_WEB_CLIENT_URL?.replace(/\/+$/, '');
  const webLink = webBase
    ? `${webBase}/#connect=${Buffer.from(qrPayload, 'utf8').toString('base64url')}`
    : null;

  console.log('');
  console.log('━'.repeat(60));
  console.log(`Scan this QR in the mobile app's Settings to connect:`);
  console.log('');
  qrcode.generate(qrPayload, { small: true }, (qr) => {
    console.log(qr);
  });
  console.log(`URL:   ${info.url}`);
  if (runtimeState.bearerToken) console.log(`Token: ${runtimeState.bearerToken}`);
  console.log(`Link:  ${deepLink}`);
  if (webLink) console.log(`Web:   ${webLink}`);
  switch (info.source) {
    case 'tailscale-serve':
      console.log('Mode:  Tailscale serve (HTTPS, identity headers — no token needed)');
      break;
    case 'tailscale-ip':
      console.log(
        runtimeState.urlScheme === 'https'
          ? 'Mode:  Tailscale (HTTPS via Let\'s Encrypt cert, bearer token auth)'
          : 'Mode:  Tailscale (HTTP, bearer token auth)',
      );
      break;
    case 'lan':
      console.log('Mode:  LAN — Tailscale not running; replace <your-LAN-IP> with `ipconfig getifaddr en0`');
      break;
    case 'loopback':
      console.log('Mode:  Loopback only — phone cannot reach this. Start Tailscale, or set HOST=0.0.0.0.');
      break;
  }
  console.log('━'.repeat(60));
  console.log('');
}
