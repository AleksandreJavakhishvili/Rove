import { openEventsStream } from './bridge';
import {
  BRIDGE_AUTH_MODE,
  DEFAULT_BRIDGE_ID,
  bridgeToConfig,
  getActiveBridge,
  makeBridge,
  useBridgesStore,
  useHydratedBridges,
  type Bridge,
} from './bridges';
import KV from './kv';
import { useEffect } from 'react';
import { create } from 'zustand';
import type { AgentCapabilities, AgentKind } from './types';

interface Settings {
  baseUrl: string;
  token: string;
  hydrated: boolean;
  /**
   * Master switch for the visual-feedback feature (manual shutter +
   * agent-initiated `take_screenshot` + `prepare_preview`). Default
   * `false` so privacy-conscious users aren't surprised by the first
   * capture request. See `docs/sdd/2026-05-25-preview-takeover/`.
   */
  enableVisualFeedback: boolean;
  /**
   * Sub-option (only meaningful when `enableVisualFeedback === true`).
   * When `true`, the ApprovalSheet hides the "Always allow" button for
   * the visual-feedback tools so the user is prompted on every call.
   */
  alwaysAskBeforeCapture: boolean;
  /**
   * Whether the first-run hint has already been shown to this device.
   * Bumped once when the user first opens a chat session with
   * `enableVisualFeedback === false`.
   */
  visualFeedbackOnboardingShown: boolean;
}

interface SettingsActions {
  load(): Promise<void>;
  setBaseUrl(url: string): Promise<void>;
  setToken(token: string): Promise<void>;
  setEnableVisualFeedback(b: boolean): Promise<void>;
  setAlwaysAskBeforeCapture(b: boolean): Promise<void>;
  markVisualFeedbackOnboardingShown(): Promise<void>;
  reset(): Promise<void>;
}

type SettingsStore = Settings & SettingsActions;

const STORAGE_KEY = 'rove:settings:v1';

// Connection config (`baseUrl` / `token`) now lives in the Bridge[] store
// (`./bridges`); only the visual-feedback prefs persist under this key.
type PersistedSettings = Pick<
  Settings,
  | 'enableVisualFeedback'
  | 'alwaysAskBeforeCapture'
  | 'visualFeedbackOnboardingShown'
>;

async function persist(state: PersistedSettings): Promise<void> {
  await KV.setItemAsync(STORAGE_KEY, JSON.stringify(state));
}

export const useSettings = create<SettingsStore>((set, get) => ({
  baseUrl: '',
  token: '',
  hydrated: false,
  enableVisualFeedback: false,
  alwaysAskBeforeCapture: false,
  visualFeedbackOnboardingShown: false,
  async load() {
    // Connection config lives in the Bridge[] store now. Hydrate it first
    // (this also runs the one-time legacy `{ baseUrl, token }` → single-bridge
    // migration), then mirror the active bridge into `baseUrl`/`token` so every
    // existing `settings.baseUrl/token` reader keeps working unchanged.
    const bridges = useBridgesStore.getState();
    if (!bridges.hydrated) await bridges.load();
    const active = getActiveBridge();
    try {
      const raw = await KV.getItemAsync(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        set({
          baseUrl: active?.baseUrl ?? '',
          token: active?.token ?? '',
          enableVisualFeedback: Boolean(parsed.enableVisualFeedback ?? false),
          alwaysAskBeforeCapture: Boolean(parsed.alwaysAskBeforeCapture ?? false),
          visualFeedbackOnboardingShown: Boolean(
            parsed.visualFeedbackOnboardingShown ?? false,
          ),
          hydrated: true,
        });
        return;
      }
    } catch (err) {
      console.warn('settings load failed', err);
    }
    set({ baseUrl: active?.baseUrl ?? '', token: active?.token ?? '', hydrated: true });
  },
  async setBaseUrl(url) {
    // Mirror locally for immediate UI, and write through to the active bridge
    // (creating the single `default` bridge on first connect).
    set({ baseUrl: url });
    const bridges = useBridgesStore.getState();
    const active = getActiveBridge();
    const baseUrl = url.trim().replace(/\/+$/, '');
    if (active) await bridges.updateBridge(active.id, { baseUrl });
    else
      await bridges.addBridge(
        makeBridge({ id: DEFAULT_BRIDGE_ID, baseUrl, token: get().token || undefined }),
      );
  },
  async setToken(token) {
    set({ token });
    const bridges = useBridgesStore.getState();
    const active = getActiveBridge();
    const trimmed = token.trim() || undefined;
    const authMode = trimmed ? BRIDGE_AUTH_MODE.bearer : BRIDGE_AUTH_MODE.tailscale;
    if (active) await bridges.updateBridge(active.id, { token: trimmed, authMode });
    else
      await bridges.addBridge(
        makeBridge({ id: DEFAULT_BRIDGE_ID, baseUrl: get().baseUrl, token: trimmed }),
      );
  },
  async setEnableVisualFeedback(b) {
    set({ enableVisualFeedback: b });
    await persist(snapshot(get(), { enableVisualFeedback: b }));
  },
  async setAlwaysAskBeforeCapture(b) {
    set({ alwaysAskBeforeCapture: b });
    await persist(snapshot(get(), { alwaysAskBeforeCapture: b }));
  },
  async markVisualFeedbackOnboardingShown() {
    if (get().visualFeedbackOnboardingShown) return;
    set({ visualFeedbackOnboardingShown: true });
    await persist(snapshot(get(), { visualFeedbackOnboardingShown: true }));
  },
  async reset() {
    set({
      baseUrl: '',
      token: '',
      enableVisualFeedback: false,
      alwaysAskBeforeCapture: false,
      visualFeedbackOnboardingShown: false,
    });
    await KV.removeItemAsync(STORAGE_KEY);
    await useBridgesStore.getState().reset();
  },
}));

/** Build the persisted snapshot from the live store state, applying any
 *  in-flight override. Keeps every `setX` action a one-liner. */
function snapshot(state: Settings, override: Partial<PersistedSettings>): PersistedSettings {
  return {
    enableVisualFeedback: state.enableVisualFeedback,
    alwaysAskBeforeCapture: state.alwaysAskBeforeCapture,
    visualFeedbackOnboardingShown: state.visualFeedbackOnboardingShown,
    ...override,
  };
}

/** Convenience hook: ensures settings are loaded once on mount. */
export function useHydratedSettings(): SettingsStore {
  const store = useSettings();
  useEffect(() => {
    if (!store.hydrated) void store.load();
  }, [store]);
  return store;
}

// ─── Preview prefs (per-session selected port + custom labels) ─────────────

interface PreviewPrefsState {
  hydrated: boolean;
  /** sessionId → port */
  selectedPort: Record<string, number>;
  /** sessionId → port → custom label */
  customLabels: Record<string, Record<number, string>>;
}

interface PreviewPrefsActions {
  load(): Promise<void>;
  setSelectedPort(sessionId: string, port: number): Promise<void>;
  setLabel(sessionId: string, port: number, label: string): Promise<void>;
  clearLabel(sessionId: string, port: number): Promise<void>;
}

type PreviewPrefsStore = PreviewPrefsState & PreviewPrefsActions;

const PREVIEW_PREFS_KEY = 'rove:preview-prefs:v1';

async function persistPreview(state: Pick<PreviewPrefsState, 'selectedPort' | 'customLabels'>): Promise<void> {
  await KV.setItemAsync(
    PREVIEW_PREFS_KEY,
    JSON.stringify({ selectedPort: state.selectedPort, customLabels: state.customLabels }),
  );
}

export const usePreviewPrefs = create<PreviewPrefsStore>((set, get) => ({
  hydrated: false,
  selectedPort: {},
  customLabels: {},
  async load() {
    try {
      const raw = await KV.getItemAsync(PREVIEW_PREFS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        set({
          selectedPort: parsed.selectedPort ?? {},
          customLabels: parsed.customLabels ?? {},
          hydrated: true,
        });
        return;
      }
    } catch (err) {
      console.warn('preview prefs load failed', err);
    }
    set({ hydrated: true });
  },
  async setSelectedPort(sessionId, port) {
    const selectedPort = { ...get().selectedPort, [sessionId]: port };
    set({ selectedPort });
    await persistPreview({ selectedPort, customLabels: get().customLabels });
  },
  async setLabel(sessionId, port, label) {
    const trimmed = label.trim().slice(0, 60);
    if (!trimmed) return get().clearLabel(sessionId, port);
    const per = { ...(get().customLabels[sessionId] ?? {}), [port]: trimmed };
    const customLabels = { ...get().customLabels, [sessionId]: per };
    set({ customLabels });
    await persistPreview({ selectedPort: get().selectedPort, customLabels });
  },
  async clearLabel(sessionId, port) {
    const existing = get().customLabels[sessionId];
    if (!existing || !(port in existing)) return;
    const per = { ...existing };
    delete per[port];
    const customLabels = { ...get().customLabels };
    if (Object.keys(per).length === 0) delete customLabels[sessionId];
    else customLabels[sessionId] = per;
    set({ customLabels });
    await persistPreview({ selectedPort: get().selectedPort, customLabels });
  },
}));

export function useHydratedPreviewPrefs(): PreviewPrefsStore {
  const store = usePreviewPrefs();
  useEffect(() => {
    if (!store.hydrated) void store.load();
  }, [store]);
  return store;
}

// ─── Pending permissions (cross-session) ──────────────────────────────────
//
// Lives at the app level (not per-screen) so the WebSocket stays connected as
// the user navigates between chats. Without this, /events disconnects every
// time the sessions list unmounts and any `permission_added` event fired while
// the user is inside a chat is lost — exactly the bug we're fixing.

// `PendingMap` / `PendingItem` and the focused-session selector live in a
// KV-free module so the pure selector is unit-testable without native deps;
// re-exported here so existing call sites keep importing from `@/lib/store`.
import {
  pendingKey,
  selectOthersPending,
  type PendingItem,
  type PendingMap,
} from './pendingSelectors';
export { selectOthersPending };
export type { PendingItem, PendingMap };

interface PendingPermissionsState {
  byKey: PendingMap;
  /** True once any bridge's stream has delivered a snapshot. */
  connected: boolean;
}

interface PendingPermissionsActions {
  /** Open/refresh one `/events` stream per bridge; close streams for bridges
   *  that were removed or whose URL/token changed. Idempotent. */
  syncStreams(bridges: Bridge[]): void;
  /** Close every stream and clear state. */
  disconnectAll(): void;
  /** Optimistically drop a request the user just decided on, before the
   *  bridge's `permission_resolved` echo arrives. */
  removeOne(bridgeId: string, agent: string, sessionId: string, toolUseId: string): void;
}

type PendingPermissionsStore = PendingPermissionsState & PendingPermissionsActions;

/** Drop every entry that came from `bridgeId` (filters by `item.bridgeId`, so
 *  it's robust regardless of how the key string is composed). */
function withoutBridge(byKey: PendingMap, bridgeId: string): PendingMap {
  const out: PendingMap = {};
  for (const [k, list] of Object.entries(byKey)) {
    const kept = list.filter((p) => p.bridgeId !== bridgeId);
    if (kept.length > 0) out[k] = kept;
  }
  return out;
}

// One live `/events` stream per bridge, keyed by bridgeId. `connKey` guards
// against reopening a stream when nothing actually changed.
const streams = new Map<string, { connKey: string; close(): void }>();

export const usePendingPermissions = create<PendingPermissionsStore>((set, get) => ({
  byKey: {},
  connected: false,

  syncStreams(bridges: Bridge[]) {
    const wanted = new Map(bridges.map((b) => [b.id, b]));
    // Close streams for bridges that vanished or whose connection changed.
    for (const [bridgeId, s] of [...streams]) {
      const b = wanted.get(bridgeId);
      const connKey = b ? `${b.baseUrl}::${b.token ?? ''}` : '';
      if (!b || s.connKey !== connKey) {
        s.close();
        streams.delete(bridgeId);
        set((st) => ({ byKey: withoutBridge(st.byKey, bridgeId) }));
      }
    }
    // Open streams for new / changed bridges. Each frame is tagged with the
    // bridge it came from so the map stays partitioned by machine.
    for (const b of bridges) {
      if (streams.has(b.id)) continue;
      const connKey = `${b.baseUrl}::${b.token ?? ''}`;
      const handle = openEventsStream(
        bridgeToConfig(b),
        (msg) => {
          if (streams.get(b.id)?.connKey !== connKey) return; // stale stream
          if (msg.type === 'permissions_snapshot') {
            set((st) => {
              const byKey = withoutBridge(st.byKey, b.id);
              for (const p of msg.pending) {
                const k = pendingKey(b.id, p.agent, p.sessionId);
                (byKey[k] ??= []).push({ ...p, bridgeId: b.id });
              }
              return { byKey, connected: true };
            });
          } else if (msg.type === 'permission_added') {
            const k = pendingKey(b.id, msg.pending.agent, msg.pending.sessionId);
            set((st) => ({
              byKey: {
                ...st.byKey,
                [k]: [...(st.byKey[k] ?? []), { ...msg.pending, bridgeId: b.id }],
              },
            }));
          } else if (msg.type === 'permission_resolved') {
            get().removeOne(b.id, msg.agent, msg.sessionId, msg.toolUseId);
          }
        },
        (connected) => {
          if (connected) set({ connected: true });
        },
      );
      streams.set(b.id, { connKey, close: handle.close });
    }
  },

  disconnectAll() {
    for (const [, s] of streams) s.close();
    streams.clear();
    set({ byKey: {}, connected: false });
  },

  removeOne(bridgeId: string, agent: string, sessionId: string, toolUseId: string) {
    const k = pendingKey(bridgeId, agent, sessionId);
    set((s) => {
      const list = (s.byKey[k] ?? []).filter((p) => p.toolUseId !== toolUseId);
      const byKey = { ...s.byKey };
      if (list.length === 0) delete byKey[k];
      else byKey[k] = list;
      return { byKey };
    });
  },
}));

// ─── Badge position (persisted UI pref for the cross-session approval badge) ──
//
// The floating "N waiting" badge is draggable and snaps to a screen edge. It's
// transient — it only exists while background requests are pending — so its
// position must persist outside the component, otherwise it would reset to the
// default every time it reappeared. We store the dropped {side, y}; the badge
// clamps `y` into the safe band (below header, above composer) at render time,
// so a stored value from a taller screen degrades gracefully.

export type BadgeSide = 'left' | 'right';

interface BadgePositionState {
  hydrated: boolean;
  side: BadgeSide;
  /** Vertical offset (px) from the top of the message area where it was dropped. */
  y: number;
}

interface BadgePositionActions {
  load(): Promise<void>;
  setPosition(side: BadgeSide, y: number): Promise<void>;
}

type BadgePositionStore = BadgePositionState & BadgePositionActions;

const BADGE_POSITION_KEY = 'rove:badge-position:v1';

export const useBadgePosition = create<BadgePositionStore>((set, get) => ({
  hydrated: false,
  side: 'right',
  y: 0,
  async load() {
    try {
      const raw = await KV.getItemAsync(BADGE_POSITION_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        set({
          side: parsed.side === 'left' ? 'left' : 'right',
          y: typeof parsed.y === 'number' ? parsed.y : 0,
          hydrated: true,
        });
        return;
      }
    } catch (err) {
      console.warn('badge position load failed', err);
    }
    set({ hydrated: true });
  },
  async setPosition(side, y) {
    set({ side, y });
    try {
      await KV.setItemAsync(BADGE_POSITION_KEY, JSON.stringify({ side, y }));
    } catch (err) {
      console.warn('badge position persist failed', err);
    }
  },
}));

/** Starts hydration on first use; mirrors `useHydratedPreviewPrefs`. */
export function useHydratedBadgePosition(): BadgePositionStore {
  const store = useBadgePosition();
  useEffect(() => {
    if (!store.hydrated) void store.load();
  }, [store]);
  return store;
}

// ─── Session capabilities (per-session, populated from WS `capabilities` frames) ─

interface CapabilitiesState {
  byKey: Record<string, AgentCapabilities>;
}

interface CapabilitiesActions {
  set(agent: AgentKind, sessionId: string, caps: AgentCapabilities): void;
  clear(agent: AgentKind, sessionId: string): void;
}

type CapabilitiesStore = CapabilitiesState & CapabilitiesActions;

function capsKey(agent: string, sessionId: string): string {
  return `${agent}:${sessionId}`;
}

export const useSessionCapabilitiesStore = create<CapabilitiesStore>((set) => ({
  byKey: {},
  set(agent, sessionId, caps) {
    set((s) => ({ byKey: { ...s.byKey, [capsKey(agent, sessionId)]: caps } }));
  },
  clear(agent, sessionId) {
    set((s) => {
      const next = { ...s.byKey };
      delete next[capsKey(agent, sessionId)];
      return { byKey: next };
    });
  },
}));

/** Read-only convenience hook for the current per-session capabilities snapshot.
 *  Returns `null` until the bridge has sent its first `capabilities` frame; the
 *  caller hides every capability-gated control while null to avoid a flicker. */
export function useSessionCapabilities(
  agent: AgentKind,
  sessionId: string,
): AgentCapabilities | null {
  return useSessionCapabilitiesStore((s) => s.byKey[capsKey(agent, sessionId)] ?? null);
}

/** Hook that starts the stream once settings are hydrated. Mount this once at
 *  the app root so the connection survives navigation. */
export function useEnsurePendingPermissionsStream(): void {
  const { bridges, hydrated } = useHydratedBridges();
  const sync = usePendingPermissions((s) => s.syncStreams);
  // String key so the effect re-runs only when a bridge's id/url/token changes.
  const key = bridges.map((b) => `${b.id}|${b.baseUrl}|${b.token ?? ''}`).join('§');
  useEffect(() => {
    if (!hydrated) return;
    // Streams persist across navigation; syncStreams diffs and closes only what
    // actually went away, so no teardown on dependency change.
    sync(bridges);
  }, [hydrated, key, sync]); // eslint-disable-line react-hooks/exhaustive-deps
}
