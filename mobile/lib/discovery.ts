import { useEffect } from 'react';
import { AppState } from 'react-native';
import { create } from 'zustand';
import { fetchHealth, fetchPeers } from './bridge';
import { bridgeToConfig, makeBridge, useBridges, useBridgesStore, type Bridge } from './bridges';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Anchor-based discovery: ask one bridge for the tailnet device list, then probe
 * each device's `/health` over the serve path (no token). Returns the devices
 * that are reachable, authorised bridges and not already configured.
 *
 * The two filters from the design both apply here: a device with no bridge (or
 * one that 401/403s our identity) fails the probe and is dropped, and `self` /
 * the phone never appear because they're not in `peers` / don't answer `/health`.
 */
export async function discoverBridges(anchor: Bridge, existing: Bridge[]): Promise<Bridge[]> {
  const { peers } = await fetchPeers(bridgeToConfig(anchor));
  const existingHosts = new Set(existing.map((b) => hostOf(b.baseUrl)));
  const existingIds = new Set(existing.map((b) => b.id));

  const results = await Promise.all(
    peers.map(async (p): Promise<Bridge | null> => {
      if (!p.dnsName || !p.online) return null;
      const baseUrl = `https://${p.dnsName}`;
      if (existingHosts.has(hostOf(baseUrl))) return null;
      try {
        // Serve path → no token. A non-bridge / unauthorised device throws here.
        const health = await fetchHealth({ baseUrl });
        if (!health.ok) return null;
        if (health.bridgeId && existingIds.has(health.bridgeId)) return null;
        return makeBridge({ id: health.bridgeId, name: p.hostname || p.dnsName, baseUrl });
      } catch {
        return null;
      }
    }),
  );

  // De-dupe by id in case two peer entries resolve to the same bridge.
  const seen = new Set<string>();
  const found: Bridge[] = [];
  for (const b of results) {
    if (!b || seen.has(b.id)) continue;
    seen.add(b.id);
    found.push(b);
  }
  return found;
}

// ─── Periodic re-discovery ───────────────────────────────────────────────────

/** Newly-seen tailnet bridges not yet added, surfaced as a home-screen banner. */
interface DiscoveryState {
  candidates: Bridge[];
  setCandidates(c: Bridge[]): void;
  clear(): void;
}

export const useDiscoveryStore = create<DiscoveryState>((set) => ({
  candidates: [],
  setCandidates: (candidates) => set({ candidates }),
  clear: () => set({ candidates: [] }),
}));

const REDISCOVER_INTERVAL_MS = 5 * 60 * 1000;

/**
 * While the app is foreground and at least one bridge is configured, re-probe
 * the tailnet every few minutes and stash any newly-seen bridges so the home
 * screen can offer them ("1 new machine on your tailnet"). Mount once at the
 * app root. Best-effort: failures are swallowed and retried next tick.
 */
export function usePeriodicDiscovery(): void {
  const bridges = useBridges();
  const setCandidates = useDiscoveryStore((s) => s.setCandidates);
  const hasBridges = bridges.length > 0;
  useEffect(() => {
    if (!hasBridges) return;
    let cancelled = false;
    const run = async () => {
      if (AppState.currentState !== 'active') return;
      const current = useBridgesStore.getState().bridges;
      const anchor = current[0];
      if (!anchor) return;
      try {
        const found = await discoverBridges(anchor, current);
        if (!cancelled && found.length > 0) setCandidates(found);
      } catch {
        // offline / not on serve path — try again next tick
      }
    };
    const timer = setInterval(run, REDISCOVER_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hasBridges, setCandidates]);
}
