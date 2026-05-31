import {
  fetchPendingPermissions,
  openEventsStream,
  type PendingPermissionSnapshot,
} from './bridge';
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

type PersistedSettings = Pick<
  Settings,
  | 'baseUrl'
  | 'token'
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
    try {
      const raw = await KV.getItemAsync(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        set({
          baseUrl: parsed.baseUrl ?? '',
          token: parsed.token ?? '',
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
    set({ hydrated: true });
  },
  async setBaseUrl(url) {
    set({ baseUrl: url });
    await persist(snapshot(get(), { baseUrl: url }));
  },
  async setToken(token) {
    set({ token });
    await persist(snapshot(get(), { token }));
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
  },
}));

/** Build the persisted snapshot from the live store state, applying any
 *  in-flight override. Keeps every `setX` action a one-liner. */
function snapshot(state: Settings, override: Partial<PersistedSettings>): PersistedSettings {
  return {
    baseUrl: state.baseUrl,
    token: state.token,
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

// `PendingMap` and the focused-session selector live in a KV-free module so the
// pure selector is unit-testable without dragging in native deps; re-exported
// here so existing call sites keep importing from `@/lib/store`.
import { selectOthersPending, type PendingMap } from './pendingSelectors';
export { selectOthersPending };
export type { PendingMap };

interface PendingPermissionsState {
  byKey: PendingMap;
  connected: boolean;
}

interface PendingPermissionsActions {
  /** Open the bridge-wide events stream. Idempotent — repeated calls with the
   *  same connection key are no-ops. Restarts when baseUrl/token change. */
  ensureStreaming(baseUrl: string, token: string): void;
  /** Close the stream — called when the user signs out / changes bridge. */
  disconnect(): void;
  /** Optimistically drop a request the user just decided on, so the UI updates
   *  before the bridge's `permission_resolved` echo arrives. */
  removeOne(agent: string, sessionId: string, toolUseId: string): void;
}

type PendingPermissionsStore = PendingPermissionsState & PendingPermissionsActions;

function pendingKey(agent: string, sessionId: string): string {
  return `${agent}:${sessionId}`;
}

let currentStream: { close(): void } | null = null;
let currentConnectionKey: string | null = null;

export const usePendingPermissions = create<PendingPermissionsStore>((set, get) => ({
  byKey: {},
  connected: false,

  ensureStreaming(baseUrl: string, token: string) {
    if (!baseUrl) return;
    const connKey = `${baseUrl}::${token}`;
    if (currentConnectionKey === connKey && currentStream) return;
    // Settings changed — tear down the previous stream before opening a new one.
    if (currentStream) {
      currentStream.close();
      currentStream = null;
    }
    currentConnectionKey = connKey;
    set({ byKey: {}, connected: false });

    // Hydrate via HTTP first; the snapshot frame from /events will then
    // overwrite this with the authoritative server-side view.
    fetchPendingPermissions({ baseUrl, token })
      .then((list) => {
        if (currentConnectionKey !== connKey) return; // settings changed mid-fetch
        const next: PendingMap = {};
        for (const p of list) {
          const k = pendingKey(p.agent, p.sessionId);
          (next[k] ??= []).push(p);
        }
        set({ byKey: next });
      })
      .catch((err) => console.warn('[pending] hydrate failed', err));

    currentStream = openEventsStream({ baseUrl, token }, (msg) => {
      if (currentConnectionKey !== connKey) return;
      if (msg.type === 'permissions_snapshot') {
        const next: PendingMap = {};
        for (const p of msg.pending) {
          const k = pendingKey(p.agent, p.sessionId);
          (next[k] ??= []).push(p);
        }
        set({ byKey: next, connected: true });
      } else if (msg.type === 'permission_added') {
        const k = pendingKey(msg.pending.agent, msg.pending.sessionId);
        set((s) => ({
          byKey: { ...s.byKey, [k]: [...(s.byKey[k] ?? []), msg.pending] },
        }));
      } else if (msg.type === 'permission_resolved') {
        get().removeOne(msg.agent, msg.sessionId, msg.toolUseId);
      }
    });
  },

  disconnect() {
    if (currentStream) {
      currentStream.close();
      currentStream = null;
    }
    currentConnectionKey = null;
    set({ byKey: {}, connected: false });
  },

  removeOne(agent: string, sessionId: string, toolUseId: string) {
    const k = pendingKey(agent, sessionId);
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
  const settings = useHydratedSettings();
  const ensure = usePendingPermissions((s) => s.ensureStreaming);
  const disconnect = usePendingPermissions((s) => s.disconnect);
  useEffect(() => {
    if (!settings.hydrated) return;
    if (!settings.baseUrl) {
      disconnect();
      return;
    }
    ensure(settings.baseUrl, settings.token);
  }, [settings.hydrated, settings.baseUrl, settings.token, ensure, disconnect]);
}
