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
