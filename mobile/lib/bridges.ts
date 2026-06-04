import { useEffect } from 'react';
import { create } from 'zustand';
import KV from './kv';

// ─── Types ─────────────────────────────────────────────────────────────────

export const BRIDGE_AUTH_MODE = {
  /** No token on the wire — identity comes from `tailscale serve`. */
  tailscale: 'tailscale',
  /** Bearer token in the Authorization header / `?token=` — off-tailnet path. */
  bearer: 'bearer',
} as const;

export type BridgeAuthMode = (typeof BRIDGE_AUTH_MODE)[keyof typeof BRIDGE_AUTH_MODE];

/** One machine the phone talks to. The aggregator (client-side) holds a
 *  `Bridge[]`; there is no central/primary bridge. */
export interface Bridge {
  /** Stable id. The migrated legacy bridge is `DEFAULT_BRIDGE_ID`; discovered
   *  bridges use the server's `/health` `bridgeId`; manual adds get a local id. */
  id: string;
  /** User-visible label; defaults to the host name. */
  name: string;
  /** Includes scheme + (optional) port, e.g. `https://imac.tailnet.ts.net`. */
  baseUrl: string;
  /** Present iff `authMode === 'bearer'`. */
  token?: string;
  authMode: BridgeAuthMode;
  /** Last successful health-check timestamp. Drives offline UI. */
  lastSeenMs?: number;
}

/** The id given to the single bridge migrated from the legacy
 *  `{ baseUrl, token }` settings, and the target of the backward-compat
 *  route redirect. */
export const DEFAULT_BRIDGE_ID = 'default';

/** Shape the existing `bridge.ts` helpers accept. Keeping a `Bridge` reducible
 *  to this lets every helper / call site stay unchanged while the rest of the
 *  refactor lands. */
export interface BridgeConfig {
  baseUrl: string;
  token?: string;
}

export function bridgeToConfig(b: Bridge): BridgeConfig {
  return { baseUrl: b.baseUrl, token: b.token || undefined };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip the scheme so a bridge's default label is just the host
 *  (`imac.tail1234.ts.net`) rather than the full `https://…` URL. */
function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
}

/** Compact display label for a machine. A bridge's `name` defaults to its full
 *  MagicDNS host (`mini.tail1234.ts.net`), which is far too long for a chip or
 *  a row tag — strip the tailnet domain so we show just the machine (`mini`).
 *  Custom names (anything not ending in `.ts.net`) are left untouched. */
export function shortBridgeName(b: Pick<Bridge, 'name'>): string {
  const name = (b.name ?? '').trim();
  if (/\.ts\.net$/i.test(name)) {
    const first = name.split('.')[0];
    if (first) return first;
  }
  return name;
}

/** Local id for manually-added bridges (discovered ones prefer the server's
 *  `/health` bridgeId). Not security-sensitive — just needs to be unique on
 *  this device. */
export function newLocalBridgeId(): string {
  return `b-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** Categorical palette of visually-distinct colours (Tableau-10 style). Picked
 *  so adjacent entries never read as "muddy similar" the way two hashed hues
 *  can. */
const MACHINE_PALETTE = [
  '#4e79a7', // blue
  '#f28e2b', // orange
  '#59a14f', // green
  '#e15759', // red
  '#b07aa1', // purple
  '#76b7b2', // teal
  '#edc948', // yellow
  '#ff9da7', // pink
  '#9c755f', // brown
  '#8cd17d', // light green
] as const;

function hashIndex(seed: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % mod;
}

/** A visually-distinct colour per machine. Assigned by the bridge's position in
 *  the configured list, so two machines are ALWAYS different colours (and it's
 *  stable across renames). Falls back to a host hash for bridges not yet in the
 *  store — e.g. discovery candidates being previewed. Used identically on inbox
 *  rows, filter chips, the chat header pill and the switcher. */
export function bridgeColor(b: Pick<Bridge, 'baseUrl' | 'id'>): string {
  const idx = useBridgesStore.getState().bridges.findIndex((x) => x.id === b.id);
  if (idx >= 0) return MACHINE_PALETTE[idx % MACHINE_PALETTE.length];
  let seed: string;
  try {
    seed = new URL(b.baseUrl).host;
  } catch {
    seed = b.baseUrl || b.id;
  }
  return MACHINE_PALETTE[hashIndex(seed, MACHINE_PALETTE.length)];
}

/** Build a Bridge from a connect payload (QR / URL / deep link). A token marks
 *  it as the bearer fallback path; its absence means the serve identity path. */
export function makeBridge(opts: {
  id?: string;
  name?: string;
  baseUrl: string;
  token?: string;
}): Bridge {
  const token = opts.token?.trim() || undefined;
  return {
    id: opts.id ?? newLocalBridgeId(),
    name: opts.name?.trim() || hostLabel(opts.baseUrl),
    baseUrl: opts.baseUrl.trim().replace(/\/+$/, ''),
    token,
    authMode: token ? BRIDGE_AUTH_MODE.bearer : BRIDGE_AUTH_MODE.tailscale,
  };
}

// ─── Store ─────────────────────────────────────────────────────────────────

interface BridgesState {
  bridges: Bridge[];
  /** Which bridge the (still single-bridge) UI currently points at. */
  activeBridgeId: string | null;
  hydrated: boolean;
}

interface BridgesActions {
  load(): Promise<void>;
  addBridge(b: Bridge): Promise<void>;
  updateBridge(id: string, patch: Partial<Omit<Bridge, 'id'>>): Promise<void>;
  removeBridge(id: string): Promise<void>;
  setActiveBridge(id: string): Promise<void>;
  /** Stamp a successful health check; drives the offline/lastSeen UI. */
  markSeen(id: string, when: number): Promise<void>;
  reset(): Promise<void>;
}

type BridgesStore = BridgesState & BridgesActions;

const STORAGE_KEY = 'rove:bridges:v1';
/** The pre-multi-bridge settings blob we migrate from on first load. */
const LEGACY_SETTINGS_KEY = 'rove:settings:v1';

interface PersistedBridges {
  bridges: Bridge[];
  activeBridgeId: string | null;
}

async function persist(state: PersistedBridges): Promise<void> {
  await KV.setItemAsync(STORAGE_KEY, JSON.stringify(state));
}

/** One-time migration of the legacy `{ baseUrl, token }` settings into a single
 *  `Bridge`. Returns null when there's nothing to migrate (fresh install). */
async function migrateLegacy(): Promise<PersistedBridges | null> {
  try {
    const raw = await KV.getItemAsync(LEGACY_SETTINGS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const baseUrl = typeof parsed?.baseUrl === 'string' ? parsed.baseUrl.trim() : '';
    if (!baseUrl) return null;
    const token = typeof parsed?.token === 'string' ? parsed.token.trim() : '';
    const bridge = makeBridge({ id: DEFAULT_BRIDGE_ID, baseUrl, token: token || undefined });
    return { bridges: [bridge], activeBridgeId: bridge.id };
  } catch (err) {
    console.warn('[bridges] legacy migration skipped:', (err as Error).message);
    return null;
  }
}

export const useBridgesStore = create<BridgesStore>((set, get) => ({
  bridges: [],
  activeBridgeId: null,
  hydrated: false,

  async load() {
    try {
      const raw = await KV.getItemAsync(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedBridges;
        const bridges = Array.isArray(parsed?.bridges) ? parsed.bridges : [];
        set({
          bridges,
          activeBridgeId: parsed?.activeBridgeId ?? bridges[0]?.id ?? null,
          hydrated: true,
        });
        return;
      }
      // No multi-bridge config yet — migrate the legacy single-bridge settings.
      const migrated = await migrateLegacy();
      if (migrated) {
        await persist(migrated);
        set({ ...migrated, hydrated: true });
        return;
      }
    } catch (err) {
      console.warn('[bridges] load failed', err);
    }
    set({ hydrated: true });
  },

  async addBridge(b) {
    // De-dupe by id: an existing entry is replaced (e.g. re-adding a discovered
    // bridge whose token rotated) so we never end up with two rows per machine.
    const rest = get().bridges.filter((x) => x.id !== b.id);
    const bridges = [...rest, b];
    const activeBridgeId = get().activeBridgeId ?? b.id;
    set({ bridges, activeBridgeId });
    await persist({ bridges, activeBridgeId });
  },

  async updateBridge(id, patch) {
    const bridges = get().bridges.map((b) => (b.id === id ? { ...b, ...patch } : b));
    set({ bridges });
    await persist({ bridges, activeBridgeId: get().activeBridgeId });
  },

  async removeBridge(id) {
    const bridges = get().bridges.filter((b) => b.id !== id);
    const activeBridgeId =
      get().activeBridgeId === id ? (bridges[0]?.id ?? null) : get().activeBridgeId;
    set({ bridges, activeBridgeId });
    await persist({ bridges, activeBridgeId });
  },

  async setActiveBridge(id) {
    if (!get().bridges.some((b) => b.id === id)) return;
    set({ activeBridgeId: id });
    await persist({ bridges: get().bridges, activeBridgeId: id });
  },

  async markSeen(id, when) {
    // No persist for liveness churn beyond the field itself; cheap enough and
    // useful across restarts to show "last seen" without a probe.
    const bridges = get().bridges.map((b) => (b.id === id ? { ...b, lastSeenMs: when } : b));
    set({ bridges });
    await persist({ bridges, activeBridgeId: get().activeBridgeId });
  },

  async reset() {
    set({ bridges: [], activeBridgeId: null });
    await KV.removeItemAsync(STORAGE_KEY);
  },
}));

// ─── Hooks / selectors ───────────────────────────────────────────────────────

/** Ensures the bridge list is hydrated once on mount. */
export function useHydratedBridges(): BridgesStore {
  const store = useBridgesStore();
  useEffect(() => {
    if (!store.hydrated) void store.load();
  }, [store]);
  return store;
}

/** Non-hook active-bridge accessor for use outside React (stores, helpers). */
export function getActiveBridge(): Bridge | null {
  const s = useBridgesStore.getState();
  return s.bridges.find((b) => b.id === s.activeBridgeId) ?? s.bridges[0] ?? null;
}

export function useBridges(): Bridge[] {
  return useBridgesStore((s) => s.bridges);
}

export function useBridge(id: string | null | undefined): Bridge | null {
  return useBridgesStore((s) => s.bridges.find((b) => b.id === id) ?? null);
}

/** The bridge the single-bridge UI currently points at (active, else first). */
export function useActiveBridge(): Bridge | null {
  return useBridgesStore(
    (s) => s.bridges.find((b) => b.id === s.activeBridgeId) ?? s.bridges[0] ?? null,
  );
}

/** Bridges seen within `withinMs` (default 60s). Until a health check has run
 *  a bridge has no `lastSeenMs` and is treated as not-yet-reachable. */
export function useReachableBridges(withinMs = 60_000): Bridge[] {
  return useBridgesStore((s) =>
    s.bridges.filter((b) => b.lastSeenMs != null && Date.now() - b.lastSeenMs <= withinMs),
  );
}
