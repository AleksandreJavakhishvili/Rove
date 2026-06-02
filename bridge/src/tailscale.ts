import { exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execP = promisify(exec);

export interface TailscaleInfo {
  /** Fully-qualified .ts.net hostname (no trailing dot), or null if not on a tailnet. */
  hostname: string | null;
  /** Tailscale 100.x.x.x IPv4 address, or null. */
  ip: string | null;
  /** Login email of the user owning this device on the tailnet. */
  user: string | null;
  online: boolean;
}

export async function getTailscaleInfo(): Promise<TailscaleInfo> {
  try {
    const { stdout } = await execP('tailscale status --json', { timeout: 2000 });
    const j: any = JSON.parse(stdout);
    const self = j?.Self;
    if (!self) return { hostname: null, ip: null, user: null, online: false };
    const dns: string = (self.DNSName ?? '').replace(/\.$/, '');
    const ip = Array.isArray(self.TailscaleIPs) && self.TailscaleIPs.length > 0 ? self.TailscaleIPs[0] : null;
    const online = j?.BackendState === 'Running';
    let user: string | null = null;
    if (j?.User && self?.UserID && j.User[self.UserID]?.LoginName) {
      user = String(j.User[self.UserID].LoginName);
    }
    return { hostname: dns || null, ip, user, online };
  } catch {
    return { hostname: null, ip: null, user: null, online: false };
  }
}

/** One device on the tailnet, as surfaced to the mobile discovery flow. */
export interface PeerInfo {
  /** Short host name, e.g. "mac-studio". */
  hostname: string;
  /** Fully-qualified MagicDNS name (no trailing dot), e.g. "mac-studio.<tailnet>.ts.net". */
  dnsName: string;
  /** Tailscale 100.x addresses for this device. */
  tailscaleIPs: string[];
  online: boolean;
  os: string;
}

export interface PeersResponse {
  /** This bridge's own device. */
  self: PeerInfo;
  /** Every other device on the tailnet (bridge or not — the mobile client
   *  probes /health to filter down to actual bridges). */
  peers: PeerInfo[];
  /** MagicDNS suffix for the tailnet, e.g. "<tailnet>.ts.net". */
  tailnet: string;
}

function toPeerInfo(node: any): PeerInfo {
  return {
    hostname: String(node?.HostName ?? ''),
    dnsName: String(node?.DNSName ?? '').replace(/\.$/, ''),
    tailscaleIPs: Array.isArray(node?.TailscaleIPs) ? node.TailscaleIPs.map(String) : [],
    online: Boolean(node?.Online),
    os: String(node?.OS ?? ''),
  };
}

/**
 * Enumerate every device on the tailnet from `tailscale status --json`.
 * Returns null if Tailscale isn't running / reachable (the caller maps that
 * to a clean 503). 3s timeout so a wedged daemon can't hang the request.
 */
export async function listTailnetDevices(): Promise<PeersResponse | null> {
  try {
    const { stdout } = await execP('tailscale status --json', { timeout: 3000 });
    const j: any = JSON.parse(stdout);
    if (!j?.Self) return null;
    const peers =
      j.Peer && typeof j.Peer === 'object' ? Object.values(j.Peer).map(toPeerInfo) : [];
    return {
      self: toPeerInfo(j.Self),
      peers,
      tailnet: String(j?.MagicDNSSuffix ?? j?.CurrentTailnet?.Name ?? ''),
    };
  } catch {
    return null;
  }
}

export interface TailscaleCert {
  cert: Buffer;
  key: Buffer;
}

/**
 * Request a Let's Encrypt cert for the given .ts.net hostname via `tailscale cert`.
 * Tailscale caches issued certs (90-day validity), so re-invocations are fast.
 *
 * Requires the tailnet admin to have enabled HTTPS Certificates at
 *   https://login.tailscale.com/admin/dns
 * If disabled or any other failure, returns null and the bridge falls back to HTTP.
 */
export async function getTailscaleCert(hostname: string): Promise<TailscaleCert | null> {
  const safeName = hostname.replace(/[^A-Za-z0-9._-]/g, '_');
  const certPath = join(tmpdir(), `rove-${safeName}.cert.pem`);
  const keyPath = join(tmpdir(), `rove-${safeName}.key.pem`);
  try {
    await execP(
      `tailscale cert --cert-file=${JSON.stringify(certPath)} --key-file=${JSON.stringify(keyPath)} ${JSON.stringify(hostname)}`,
      { timeout: 45000 },
    );
    const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
    return { cert, key };
  } catch (err: any) {
    const stderr = String(err?.stderr ?? err?.message ?? '');
    if (/HTTPS is disabled|https certificates are disabled/i.test(stderr)) {
      console.error('[tls] HTTPS certificates are disabled for your tailnet.');
      console.error('[tls] Enable them at https://login.tailscale.com/admin/dns and restart.');
    } else if (stderr) {
      console.error(`[tls] tailscale cert failed: ${stderr.split('\n')[0]?.slice(0, 200)}`);
    } else {
      console.error('[tls] tailscale cert failed for an unknown reason');
    }
    return null;
  }
}

/** True if `tailscale serve` is currently fronting an HTTPS handler at `/`. */
export async function isTailscaleServeRunning(): Promise<boolean> {
  try {
    const { stdout } = await execP('tailscale serve status --json', { timeout: 2000 });
    const j: any = JSON.parse(stdout);
    if (!j?.Web) return false;
    for (const host of Object.values(j.Web)) {
      const handlers = (host as any)?.Handlers;
      if (handlers && Object.keys(handlers).length > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}
