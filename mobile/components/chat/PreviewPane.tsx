import { fetchPreview } from '@/lib/bridge';
import { useHydratedPreviewPrefs, useHydratedSettings } from '@/lib/store';
import type { AgentKind, DevServerCandidate, PreviewResponse } from '@/lib/types';
import { fontFamily, fontSize, radius, space, useTheme, type Theme } from '@/theme';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { PreviewFrame, type PreviewFrameHandle } from './PreviewFrame';

const POLL_MS = 3000;

interface Props {
  agent: AgentKind;
  id: string;
  /** When false (offscreen), polling pauses to save battery. */
  active: boolean;
  /** Attached to the View wrapping the WebView so external code
   *  (useScreenshotCapture) can capture exactly the dev-server frame —
   *  not the candidate picker, not the empty-state cards. Phase 1 of
   *  the visual-feedback-loop SDD. */
  captureRef?: React.RefObject<View | null>;
  /** Handle the takeover controller uses to drive the WebView during
   *  agent capture (path navigation, currentUrl echo). */
  previewFrameRef?: React.RefObject<PreviewFrameHandle | null>;
}

export function PreviewPane({ agent, id, active, captureRef, previewFrameRef }: Props) {
  const t = useTheme();
  const settings = useHydratedSettings();
  const prefs = useHydratedPreviewPrefs();

  const [data, setData] = useState<PreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<DevServerCandidate | null>(null);

  // Poll while active.
  useEffect(() => {
    if (!active || !settings.baseUrl) {
      if (!active) console.log(`[preview] ${id.slice(0, 8)} pane inactive — polling paused`);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let prevSummary = '';
    console.log(`[preview] ${id.slice(0, 8)} polling start (every ${POLL_MS}ms)`);

    const tick = async () => {
      try {
        const res = await fetchPreview({ baseUrl: settings.baseUrl, token: settings.token }, agent, id);
        if (cancelled) return;
        // Log only when the candidate set changes — avoids spamming the console every 3s.
        const summary = res.candidates
          .map((c) => `${c.framework ?? '?'}:${c.port}${c.reachable ? '' : '(loopback)'}`)
          .join(', ');
        if (summary !== prevSummary) {
          if (res.candidates.length === 0) {
            console.log(`[preview] ${id.slice(0, 8)} no dev servers detected (hostname=${res.hostname})`);
          } else {
            console.log(
              `[preview] ${id.slice(0, 8)} ${res.candidates.length} candidate(s): ${summary} → first url=${res.candidates[0]?.url ?? 'none'}`,
            );
          }
          prevSummary = summary;
        }
        setData(res);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        const msg = (err as Error).message;
        console.log(`[preview] ${id.slice(0, 8)} fetch failed: ${msg}`);
        setError(msg);
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(tick, POLL_MS);
        }
      }
    };

    setLoading(true);
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      console.log(`[preview] ${id.slice(0, 8)} polling stopped`);
    };
  }, [active, agent, id, settings.baseUrl, settings.token]);

  const candidates = data?.candidates ?? [];
  const sessionKey = `${agent}::${id}`;
  const customLabelsForSession = prefs.customLabels[sessionKey] ?? {};
  const savedPort = prefs.selectedPort[sessionKey];

  // Selection logic: saved port if still present, else first candidate.
  const selected = useMemo<DevServerCandidate | null>(() => {
    if (candidates.length === 0) return null;
    const saved = candidates.find((c) => c.port === savedPort);
    if (saved) return saved;
    return candidates[0] ?? null;
  }, [candidates, savedPort]);

  // Persist auto-selection so the WebView stays on the same one next time.
  useEffect(() => {
    if (selected && selected.port !== savedPort) {
      void prefs.setSelectedPort(sessionKey, selected.port);
    }
  }, [selected, savedPort, sessionKey, prefs]);

  const styles = useStyles(t);

  if (loading && !data) {
    return (
      <View style={[styles.root, styles.centered]}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {candidates.length > 0 ? (
        <CandidatePicker
          candidates={candidates}
          selectedPort={selected?.port}
          customLabels={customLabelsForSession}
          onSelect={(c) => void prefs.setSelectedPort(sessionKey, c.port)}
          onEdit={(c) => setRenameTarget(c)}
        />
      ) : null}

      <View ref={captureRef} style={styles.body} collapsable={false}>
        {selected ? (
          selected.reachable && selected.url ? (
            selected.framework === 'expo' ? (
              <ExpoPanel url={selected.url} theme={t} />
            ) : (
              <PreviewFrame
                ref={previewFrameRef}
                url={selected.url}
                backgroundColor={t.surface.base}
              />
            )
          ) : (
            <LocalhostWarning candidate={selected} theme={t} />
          )
        ) : error ? (
          <EmptyState
            theme={t}
            title="Could not check for dev servers"
            body={error}
          />
        ) : (
          <EmptyState
            theme={t}
            title="No dev server detected"
            body={`Start one in the project (e.g., \`pnpm dev\`), bind it to 0.0.0.0, and it will appear here within a few seconds.`}
          />
        )}
      </View>

      <RenameModal
        target={renameTarget}
        existingLabel={renameTarget ? customLabelsForSession[renameTarget.port] : undefined}
        onClose={() => setRenameTarget(null)}
        onSave={async (label) => {
          if (!renameTarget) return;
          await prefs.setLabel(sessionKey, renameTarget.port, label);
          setRenameTarget(null);
        }}
        onReset={async () => {
          if (!renameTarget) return;
          await prefs.clearLabel(sessionKey, renameTarget.port);
          setRenameTarget(null);
        }}
        theme={t}
      />
    </View>
  );
}

function labelForCandidate(
  c: DevServerCandidate,
  customLabels: Record<number, string>,
): string {
  const custom = customLabels[c.port];
  if (custom) return custom;
  if (c.framework) return capitalize(c.framework);
  return `Port ${c.port}`;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function CandidatePicker({
  candidates,
  selectedPort,
  customLabels,
  onSelect,
  onEdit,
}: {
  candidates: DevServerCandidate[];
  selectedPort: number | undefined;
  customLabels: Record<number, string>;
  onSelect: (c: DevServerCandidate) => void;
  onEdit: (c: DevServerCandidate) => void;
}) {
  const t = useTheme();
  const styles = useStyles(t);
  if (candidates.length < 1) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[styles.pickerRow, { borderBottomColor: t.border.subtle }]}
      contentContainerStyle={{ paddingHorizontal: space[2] + 2, gap: space[2], alignItems: 'center' }}>
      {candidates.map((c) => {
        const isSelected = c.port === selectedPort;
        const label = labelForCandidate(c, customLabels);
        return (
          <View key={`${c.pid}:${c.port}`} style={styles.pickerEntry}>
            <Pressable
              onPress={() => onSelect(c)}
              style={({ pressed }) => [
                styles.pickerChip,
                {
                  backgroundColor: isSelected
                    ? t.accent.primary
                    : pressed
                      ? t.surface.pressed
                      : t.surface.raised,
                  borderColor: isSelected ? t.accent.primary : t.border.subtle,
                },
              ]}>
              <Text
                numberOfLines={1}
                style={[
                  styles.pickerLabel,
                  { color: isSelected ? t.accent.fg : t.text.primary },
                ]}>
                {label}
              </Text>
              <Text
                numberOfLines={1}
                style={[
                  styles.pickerPort,
                  { color: isSelected ? t.accent.fg : t.text.muted },
                ]}>
                :{c.port}
                {!c.reachable ? ' · localhost' : ''}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => onEdit(c)}
              hitSlop={8}
              style={({ pressed }) => [
                styles.editButton,
                { backgroundColor: pressed ? t.surface.pressed : t.surface.raised, borderColor: t.border.subtle },
              ]}>
              <Text style={[styles.editGlyph, { color: t.text.secondary }]}>✎</Text>
            </Pressable>
          </View>
        );
      })}
    </ScrollView>
  );
}

function ExpoPanel({ url, theme }: { url: string; theme: Theme }) {
  const styles = useStyles(theme);
  const expUrl = url.replace(/^https?:\/\//, 'exp://');
  const [copied, setCopied] = useState(false);

  const openInExpoGo = () => {
    Linking.openURL(expUrl).catch(() => undefined);
  };
  const copyUrl = async () => {
    const Clipboard = await import('expo-clipboard');
    await Clipboard.setStringAsync(expUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <View style={styles.expoPanel}>
      <View
        style={[
          styles.expoCard,
          { backgroundColor: theme.surface.raised, borderColor: theme.border.subtle },
        ]}>
        <Text style={[styles.expoTitle, { color: theme.text.primary }]}>Expo dev server</Text>
        <Text style={[styles.expoSubtitle, { color: theme.text.secondary }]}>
          Metro is running but doesn’t serve a web page. Open the project in Expo Go (or your
          development client) on this device.
        </Text>

        <Pressable
          onPress={copyUrl}
          style={({ pressed }) => [
            styles.expoUrlRow,
            {
              backgroundColor: pressed ? theme.surface.pressed : theme.surface.base,
              borderColor: theme.border.subtle,
            },
          ]}>
          <Text style={[styles.expoUrl, { color: theme.text.primary }]} numberOfLines={1}>
            {expUrl}
          </Text>
          <Text style={[styles.expoCopyHint, { color: theme.text.muted }]}>
            {copied ? 'copied' : 'tap to copy'}
          </Text>
        </Pressable>

        <Pressable
          onPress={openInExpoGo}
          style={({ pressed }) => [
            styles.expoPrimary,
            { backgroundColor: pressed ? theme.accent.pressed : theme.accent.primary },
          ]}>
          <Text style={[styles.expoPrimaryLabel, { color: theme.accent.fg }]}>Open in Expo Go</Text>
        </Pressable>

        <Text style={[styles.expoFootnote, { color: theme.text.muted }]}>
          If you use a custom dev client, replace the scheme manually or scan the QR in the
          terminal.
        </Text>
      </View>
    </View>
  );
}

function LocalhostWarning({ candidate, theme }: { candidate: DevServerCandidate; theme: Theme }) {
  const styles = useStyles(theme);
  return (
    <View style={[styles.warningCard, { backgroundColor: theme.surface.raised, borderColor: theme.border.subtle }]}>
      <Text style={[styles.warningTitle, { color: theme.text.primary }]}>Bound to localhost</Text>
      <Text style={[styles.warningBody, { color: theme.text.secondary }]}>
        {candidate.note ?? 'Re-bind to 0.0.0.0 to reach this server from your phone.'}
      </Text>
      <Text style={[styles.warningMeta, { color: theme.text.muted }]}>
        Detected as {candidate.framework ?? 'unknown'} on port {candidate.port} (bind {candidate.bindAddress})
      </Text>
    </View>
  );
}

function EmptyState({ theme, title, body }: { theme: Theme; title: string; body: string }) {
  const styles = useStyles(theme);
  return (
    <View style={[styles.emptyState]}>
      <Text style={[styles.emptyTitle, { color: theme.text.primary }]}>{title}</Text>
      <Text style={[styles.emptyBody, { color: theme.text.secondary }]}>{body}</Text>
    </View>
  );
}

function RenameModal({
  target,
  existingLabel,
  onClose,
  onSave,
  onReset,
  theme,
}: {
  target: DevServerCandidate | null;
  existingLabel: string | undefined;
  onClose: () => void;
  onSave: (label: string) => Promise<void>;
  onReset: () => Promise<void>;
  theme: Theme;
}) {
  const styles = useStyles(theme);
  const [value, setValue] = useState(existingLabel ?? '');
  const inputRef = useRef<TextInput | null>(null);

  useEffect(() => {
    if (target) {
      setValue(existingLabel ?? '');
      // tiny delay so the modal mounts before focusing
      const t = setTimeout(() => inputRef.current?.focus(), 80);
      return () => clearTimeout(t);
    }
  }, [target, existingLabel]);

  if (!target) return null;
  const auto = target.framework ? capitalize(target.framework) : `Port ${target.port}`;

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose} visible>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable
          style={[styles.modalCard, { backgroundColor: theme.surface.raised, borderColor: theme.border.subtle }]}
          onPress={(e) => e.stopPropagation()}>
          <Text style={[styles.modalTitle, { color: theme.text.primary }]}>Name this dev server</Text>
          <Text style={[styles.modalSubtitle, { color: theme.text.secondary }]}>
            Port {target.port} · auto-detected: {auto}
          </Text>
          <TextInput
            ref={inputRef}
            value={value}
            onChangeText={setValue}
            placeholder={auto}
            placeholderTextColor={theme.text.placeholder}
            style={[
              styles.modalInput,
              { color: theme.text.primary, backgroundColor: theme.surface.base, borderColor: theme.border.subtle },
            ]}
            maxLength={60}
            returnKeyType="done"
            onSubmitEditing={() => value.trim() && void onSave(value.trim())}
          />
          <View style={styles.modalActions}>
            {existingLabel ? (
              <Pressable
                onPress={() => void onReset()}
                style={({ pressed }) => [
                  styles.modalButton,
                  { backgroundColor: pressed ? theme.surface.pressed : 'transparent' },
                ]}>
                <Text style={[styles.modalButtonLabel, { color: theme.status.danger }]}>Reset to auto</Text>
              </Pressable>
            ) : (
              <View style={{ flex: 1 }} />
            )}
            <View style={{ flexDirection: 'row', gap: space[2] }}>
              <Pressable
                onPress={onClose}
                style={({ pressed }) => [
                  styles.modalButton,
                  { backgroundColor: pressed ? theme.surface.pressed : 'transparent' },
                ]}>
                <Text style={[styles.modalButtonLabel, { color: theme.text.secondary }]}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => value.trim() && void onSave(value.trim())}
                disabled={!value.trim()}
                style={({ pressed }) => [
                  styles.modalButton,
                  {
                    backgroundColor: value.trim()
                      ? pressed
                        ? theme.surface.pressed
                        : theme.accent.primary
                      : theme.surface.pressed,
                  },
                ]}>
                <Text
                  style={[
                    styles.modalButtonLabel,
                    { color: value.trim() ? theme.accent.fg : theme.text.muted, fontWeight: '600' },
                  ]}>
                  Save
                </Text>
              </Pressable>
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function useStyles(t: Theme) {
  return useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1, backgroundColor: t.surface.base },
        centered: { alignItems: 'center', justifyContent: 'center' },
        pickerRow: {
          maxHeight: 56,
          borderBottomWidth: StyleSheet.hairlineWidth,
        },
        pickerEntry: { flexDirection: 'row', alignItems: 'center', gap: 4 },
        pickerChip: {
          paddingHorizontal: space[3],
          paddingVertical: space[2],
          borderRadius: radius.pill,
          borderWidth: 1,
          flexDirection: 'row',
          alignItems: 'center',
          gap: space[2],
          maxWidth: 240,
        },
        pickerLabel: { fontFamily: fontFamily.sans, fontSize: fontSize.sm, fontWeight: '600' },
        pickerPort: { fontFamily: fontFamily.mono, fontSize: fontSize.xs },
        editButton: {
          width: 28,
          height: 28,
          borderRadius: radius.pill,
          borderWidth: 1,
          alignItems: 'center',
          justifyContent: 'center',
        },
        editGlyph: { fontSize: fontSize.sm },
        body: { flex: 1 },
        expoPanel: {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: space[4],
        },
        expoCard: {
          width: '100%',
          maxWidth: 480,
          padding: space[4],
          borderRadius: radius.lg,
          borderWidth: 1,
          gap: space[3],
        },
        expoTitle: { fontFamily: fontFamily.sans, fontSize: fontSize.lg, fontWeight: '700' },
        expoSubtitle: { fontFamily: fontFamily.sans, fontSize: fontSize.sm, lineHeight: 20 },
        expoUrlRow: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: space[3],
          paddingVertical: space[3],
          borderRadius: radius.md,
          borderWidth: 1,
          gap: space[2],
        },
        expoUrl: { fontFamily: fontFamily.mono, fontSize: fontSize.sm, flexShrink: 1 },
        expoCopyHint: { fontFamily: fontFamily.sans, fontSize: fontSize.xs },
        expoPrimary: {
          paddingVertical: space[3],
          borderRadius: radius.lg,
          alignItems: 'center',
        },
        expoPrimaryLabel: { fontFamily: fontFamily.sans, fontSize: fontSize.base, fontWeight: '700' },
        expoFootnote: { fontFamily: fontFamily.sans, fontSize: fontSize.xs, lineHeight: 18 },
        emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space[5], gap: space[2] },
        emptyTitle: { fontFamily: fontFamily.sans, fontSize: fontSize.lg, fontWeight: '600' },
        emptyBody: { fontFamily: fontFamily.sans, fontSize: fontSize.sm, textAlign: 'center', lineHeight: 20 },
        warningCard: {
          margin: space[4],
          padding: space[4],
          borderRadius: radius.md,
          borderWidth: 1,
          gap: space[2],
        },
        warningTitle: { fontFamily: fontFamily.sans, fontSize: fontSize.md, fontWeight: '700' },
        warningBody: { fontFamily: fontFamily.sans, fontSize: fontSize.sm, lineHeight: 20 },
        warningMeta: { fontFamily: fontFamily.mono, fontSize: fontSize.xs, marginTop: space[2] },
        modalBackdrop: {
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.4)',
          alignItems: 'center',
          justifyContent: 'center',
          padding: space[4],
        },
        modalCard: {
          width: '100%',
          maxWidth: 420,
          padding: space[4],
          borderRadius: radius.lg,
          borderWidth: 1,
          gap: space[3],
        },
        modalTitle: { fontFamily: fontFamily.sans, fontSize: fontSize.lg, fontWeight: '700' },
        modalSubtitle: { fontFamily: fontFamily.mono, fontSize: fontSize.xs },
        modalInput: {
          fontFamily: fontFamily.sans,
          fontSize: fontSize.md,
          borderWidth: 1,
          borderRadius: radius.md,
          paddingHorizontal: space[3],
          paddingVertical: space[3],
        },
        modalActions: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: space[2],
        },
        modalButton: {
          paddingHorizontal: space[3],
          paddingVertical: space[2] + 2,
          borderRadius: radius.md,
        },
        modalButtonLabel: { fontFamily: fontFamily.sans, fontSize: fontSize.sm },
      }),
    [t],
  );
}
