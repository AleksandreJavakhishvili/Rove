import type { Context, MiddlewareHandler } from 'hono';
import { config, runtimeState } from './config.ts';
import { getTailscaleInfo } from './tailscale.ts';

let cachedAllowed: string[] | null = null;
async function effectiveAllowedUsers(): Promise<string[]> {
  if (config.allowedUsers.length > 0) return config.allowedUsers;
  if (cachedAllowed) return cachedAllowed;
  const ts = await getTailscaleInfo();
  cachedAllowed = ts.user ? [ts.user] : [];
  if (cachedAllowed.length > 0) {
    console.log(`[auth] auto-allowing tailnet owner: ${cachedAllowed[0]} (override with ALLOWED_USERS)`);
  }
  return cachedAllowed;
}

export interface AuthInfo {
  user: string;
  source: 'tailscale' | 'bearer' | 'loopback-dev';
}

export const authMiddleware: MiddlewareHandler<{ Variables: { auth: AuthInfo } }> = async (c, next) => {
  const info = identify(c);
  if (!info) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  // Loopback-dev and bearer auth bypass the Tailscale allowlist (developer affordance).
  if (info.source === 'tailscale') {
    const allowed = await effectiveAllowedUsers();
    if (allowed.length > 0 && !allowed.includes(info.user)) {
      return c.json({ error: 'forbidden', user: info.user }, 403);
    }
  }
  c.set('auth', info);
  await next();
};

export function identify(c: Context): AuthInfo | null {
  // 1. Tailscale identity header (set when fronting via `tailscale serve` or by us forwarding it).
  const tsLogin = c.req.header('Tailscale-User-Login');
  if (tsLogin) return { user: tsLogin, source: 'tailscale' };

  // 2. Static bearer token via Authorization header.
  const auth = c.req.header('authorization');
  if (auth?.startsWith('Bearer ') && runtimeState.bearerToken && auth.slice(7) === runtimeState.bearerToken) {
    return { user: 'bearer-user', source: 'bearer' };
  }

  // 3. Same bearer token via ?token=... query string. Required for WebSocket
  // upgrades from browser/RN, which can't attach custom headers.
  const qToken = c.req.query('token');
  if (qToken && runtimeState.bearerToken && qToken === runtimeState.bearerToken) {
    return { user: 'bearer-user', source: 'bearer' };
  }

  // 4. Dev escape hatch: only when truly loopback-only (no Tailscale serve in front).
  if (runtimeState.loopbackDevAllowed) {
    return { user: 'local-dev', source: 'loopback-dev' };
  }

  return null;
}

export function identifyForWs(req: { headers: NodeJS.Dict<string | string[]> }): AuthInfo | null {
  const get = (name: string): string | undefined => {
    const raw = req.headers[name.toLowerCase()];
    if (Array.isArray(raw)) return raw[0];
    return raw;
  };
  const tsLogin = get('Tailscale-User-Login');
  if (tsLogin) return { user: tsLogin, source: 'tailscale' };
  const auth = get('authorization');
  if (auth?.startsWith('Bearer ') && runtimeState.bearerToken && auth.slice(7) === runtimeState.bearerToken) {
    return { user: 'bearer-user', source: 'bearer' };
  }
  if (runtimeState.loopbackDevAllowed) return { user: 'local-dev', source: 'loopback-dev' };
  return null;
}
