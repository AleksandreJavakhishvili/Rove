import { useEffect } from 'react';
import { useSettings } from './store';

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  if (typeof atob === 'function') return atob(padded + pad);
  // Server-side prerender path (Expo static rendering runs in Node).
  return Buffer.from(padded + pad, 'base64').toString('binary');
}

interface ConnectPayload {
  url: string;
  token?: string;
}

function parseConnectFragment(hash: string): ConnectPayload | null {
  if (!hash) return null;
  const match = hash.match(/(?:^#|&)connect=([^&]+)/);
  if (!match) return null;
  try {
    const decoded = base64UrlDecode(decodeURIComponent(match[1]!));
    const parsed = JSON.parse(decoded) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as ConnectPayload).url === 'string'
    ) {
      const payload = parsed as ConnectPayload;
      return {
        url: payload.url,
        token: typeof payload.token === 'string' ? payload.token : undefined,
      };
    }
  } catch (err) {
    console.warn('[web-bootstrap] failed to decode #connect fragment', err);
  }
  return null;
}

/**
 * On web, consume a `#connect=<base64url(JSON{url,token})>` fragment exactly
 * once per page load: persist the URL + token into the settings store and
 * scrub the hash from the address bar so the token doesn't linger in browser
 * history. The token lives in the URL fragment specifically because browsers
 * never send fragments to the server — GitHub Pages access logs never see it.
 */
export function useWebBootstrap(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const payload = parseConnectFragment(window.location.hash);
    if (!payload) return;

    void (async () => {
      try {
        const { setBaseUrl, setToken } = useSettings.getState();
        await setBaseUrl(payload.url);
        await setToken(payload.token ?? '');
      } catch (err) {
        console.warn('[web-bootstrap] failed to apply #connect payload', err);
      } finally {
        // Strip the fragment regardless of success — leaving a bad payload in
        // the URL would re-trigger on every reload and confuse the user.
        try {
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
        } catch {
          /* very old browser — ignore */
        }
      }
    })();
  }, []);
}
