import { create } from 'zustand';
import { BridgeError, fetchSessions } from './bridge';
import { bridgeToConfig, useBridgesStore } from './bridges';
import type { SessionListItem } from './types';

/** Per-host fan-out budget. A bridge slower than this is treated as offline so
 *  one asleep machine never blocks the rest of the inbox. */
const PER_HOST_TIMEOUT_MS = 5000;

export type BridgeConnState = 'connecting' | 'open' | 'offline' | 'unauthorised';

/** A session tagged with the bridge it came from. The wire `SessionListItem`
 *  has no bridgeId — the aggregator stamps it on merge so the bridge stays
 *  agnostic of the name/id the client gave it. */
export type TaggedSession = SessionListItem & { bridgeId: string };

interface AggregatorState {
  /** bridgeId → its (tagged) sessions. Last-known rows are kept when a bridge
   *  goes offline so they stay visible rather than vanishing. */
  byBridge: Record<string, TaggedSession[]>;
  /** bridgeId → connection state, drives the per-row offline / re-auth UI. */
  connState: Record<string, BridgeConnState>;
  refreshing: boolean;
}

interface AggregatorActions {
  /** Fan out `/sessions` to every configured bridge in parallel. */
  refresh(): Promise<void>;
  /** Refresh a single bridge (pull-to-refresh on a row, tap-to-retry). */
  refreshBridge(bridgeId: string): Promise<void>;
  /** Drop a bridge's cached rows + state (called when a bridge is removed). */
  forget(bridgeId: string): void;
}

type AggregatorStore = AggregatorState & AggregatorActions;

/** Reject after `ms` so a wedged host can't hold the fan-out open. The
 *  underlying fetch may still settle later; we ignore it. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new BridgeError('timeout', `bridge fan-out exceeded ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export const useAggregator = create<AggregatorStore>((set, get) => ({
  byBridge: {},
  connState: {},
  refreshing: false,

  async refresh() {
    const bridges = useBridgesStore.getState().bridges;
    set({ refreshing: true });
    // Parallel fan-out; each bridge writes its own slice as it lands so a fast
    // host renders immediately and a slow/asleep one never blocks it.
    await Promise.all(bridges.map((b) => get().refreshBridge(b.id)));
    set({ refreshing: false });
  },

  async refreshBridge(bridgeId) {
    const bridge = useBridgesStore.getState().bridges.find((b) => b.id === bridgeId);
    if (!bridge) return;
    set((s) => ({ connState: { ...s.connState, [bridgeId]: 'connecting' } }));
    try {
      const list = await withTimeout(fetchSessions(bridgeToConfig(bridge)), PER_HOST_TIMEOUT_MS);
      const tagged: TaggedSession[] = list.map((item) => ({ ...item, bridgeId }));
      set((s) => ({
        byBridge: { ...s.byBridge, [bridgeId]: tagged },
        connState: { ...s.connState, [bridgeId]: 'open' },
      }));
      void useBridgesStore.getState().markSeen(bridgeId, Date.now());
    } catch (err) {
      // A 401/403 means "re-auth this bridge", anything else means "offline".
      // Either way we keep the last-known rows so they degrade rather than vanish.
      const kind = err instanceof BridgeError ? err.kind : 'network';
      const next: BridgeConnState =
        kind === 'auth' || kind === 'forbidden' ? 'unauthorised' : 'offline';
      set((s) => ({ connState: { ...s.connState, [bridgeId]: next } }));
    }
  },

  forget(bridgeId) {
    set((s) => {
      const byBridge = { ...s.byBridge };
      delete byBridge[bridgeId];
      const connState = { ...s.connState };
      delete connState[bridgeId];
      return { byBridge, connState };
    });
  },
}));

/** Flatten every bridge's sessions into one recency-sorted list. The screen
 *  layers the needs-me priority (pending approvals) on top, since it holds the
 *  pending map. Call inside `useMemo(() => mergeSessions(byBridge), [byBridge])`
 *  so the sort doesn't re-run on unrelated renders. */
export function mergeSessions(byBridge: Record<string, TaggedSession[]>): TaggedSession[] {
  return Object.values(byBridge)
    .flat()
    .sort((a, b) => b.lastModified - a.lastModified);
}
