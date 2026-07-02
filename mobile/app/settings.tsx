import { QRScanner, type ScannedConfig } from '@/components/QRScanner';
import { fetchHealth } from '@/lib/bridge';
import { getActiveBridge, useBridgesStore, type Bridge } from '@/lib/bridges';
import { discoverBridges } from '@/lib/discovery';
import { registerWithBridge } from '@/lib/push';
import { useHydratedSettings } from '@/lib/store';
import { useDefaultCollapsed } from '@/hooks/useDefaultCollapsed';
import { useExcludeSubagents } from '@/hooks/useExcludeSubagents';
import { useHistoryDays } from '@/hooks/useHistoryDays';
import { useRepoPath } from '@/hooks/useRepoPath';
import { useSessionImport } from '@/hooks/useSessionImport';
import { fontSize, radius, space, useTheme } from '@/theme';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

const WEB_SETUP_DOCS_URL =
  'https://github.com/aleksandrejavakhishvili/Rove/blob/main/docs/web-client-setup.md';

export default function SettingsScreen() {
  const t = useTheme();
  const settings = useHydratedSettings();
  // Deep-link params: rove://settings?url=...&token=...
  const params = useLocalSearchParams<{ url?: string; token?: string }>();
  const [baseUrl, setBaseUrlLocal] = useState(settings.baseUrl);
  const [token, setTokenLocal] = useState(settings.token);
  const [testing, setTesting] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const deepLinkAppliedRef = useRef(false);

  async function testAndSave(overrideUrl?: string, overrideToken?: string) {
    // Guard against concurrent calls (e.g., scanner firing multiple times).
    if (testing) return;
    const rawUrl = (overrideUrl ?? baseUrl).trim().replace(/\/+$/, '');
    const rawToken = (overrideToken ?? token).trim();
    if (!/^https?:\/\//.test(rawUrl)) {
      Alert.alert('Invalid URL', 'Bridge URL must start with http:// or https://');
      return;
    }
    setTesting(true);
    try {
      const health = await fetchHealth({ baseUrl: rawUrl, token: rawToken });
      if (!health.ok) throw new Error('bridge returned not-ok');
      await settings.setBaseUrl(rawUrl);
      await settings.setToken(rawToken);
      // Best-effort push registration. Currently stubbed (no-op) until we
      // re-enable expo-notifications with a paid Apple Developer account.
      void registerWithBridge({ baseUrl: rawUrl, token: rawToken });

      // Discovery magic moment: on the keyless serve path, ask this bridge for
      // the rest of the tailnet and offer to add them — so the user connects
      // ONE machine and the others appear. Best-effort; never blocks connect.
      let discovered: Bridge[] = [];
      if (health.tailscaleServe) {
        const anchor = getActiveBridge();
        if (anchor) {
          try {
            discovered = await discoverBridges(anchor, useBridgesStore.getState().bridges);
          } catch {
            // discovery is optional — a failure here doesn't fail the connect
          }
        }
      }
      if (discovered.length > 0) {
        Alert.alert(
          'Connected',
          `Authenticated as ${health.user ?? 'you'}. Found ${discovered.length} more machine${
            discovered.length === 1 ? '' : 's'
          } on your tailnet.`,
          [
            { text: 'Not now', style: 'cancel', onPress: () => router.back() },
            {
              text: 'Add all',
              onPress: async () => {
                for (const b of discovered) await useBridgesStore.getState().addBridge(b);
                router.back();
              },
            },
          ],
        );
      } else {
        Alert.alert('Connected', `Authenticated as ${health.user ?? 'unknown'}`, [
          { text: 'OK', onPress: () => router.back() },
        ]);
      }
    } catch (err) {
      Alert.alert('Could not connect', String((err as Error).message ?? err));
    } finally {
      setTesting(false);
    }
  }

  function onScan(cfg: ScannedConfig) {
    setScannerOpen(false);
    setBaseUrlLocal(cfg.url);
    setTokenLocal(cfg.token ?? '');
    void testAndSave(cfg.url, cfg.token ?? '');
  }

  // Apply a `rove://settings?url=...&token=...` deep link once on mount.
  useEffect(() => {
    if (deepLinkAppliedRef.current) return;
    const linkUrl = typeof params.url === 'string' ? params.url : undefined;
    if (!linkUrl) return;
    deepLinkAppliedRef.current = true;
    const linkToken = typeof params.token === 'string' ? params.token : '';
    setBaseUrlLocal(linkUrl);
    setTokenLocal(linkToken);
    void testAndSave(linkUrl, linkToken);
  }, [params.url, params.token]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1, backgroundColor: t.surface.base }}>
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled">
        <Pressable
          onPress={() => setScannerOpen(true)}
          style={({ pressed }) => [
            styles.scanButton,
            {
              backgroundColor: pressed ? t.surface.pressed : t.surface.raised,
              borderColor: t.border.subtle,
            },
          ]}>
          <Text style={[styles.scanIcon, { color: t.text.primary }]}>⌗</Text>
          <View style={{ flex: 1 }}>
            <Text style={[styles.scanTitle, { color: t.text.primary }]}>Scan QR from the bridge</Text>
            <Text style={[styles.scanHint, { color: t.text.secondary }]}>
              One-tap setup — point camera at the terminal where you ran the bridge.
            </Text>
          </View>
        </Pressable>

        <View style={styles.divider}>
          <View style={[styles.line, { backgroundColor: t.border.default }]} />
          <Text style={[styles.dividerText, { color: t.text.muted }]}>or enter manually</Text>
          <View style={[styles.line, { backgroundColor: t.border.default }]} />
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, { color: t.text.secondary }]}>Bridge URL</Text>
          <TextInput
            value={baseUrl}
            onChangeText={setBaseUrlLocal}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://desktop.tailnet.ts.net"
            placeholderTextColor={t.text.placeholder}
            style={[styles.input, { color: t.text.primary, borderColor: t.border.default }]}
          />
        </View>
        <View style={styles.field}>
          <Text style={[styles.label, { color: t.text.secondary }]}>Bearer token (optional)</Text>
          <TextInput
            value={token}
            onChangeText={setTokenLocal}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            placeholder="leave blank when using `tailscale serve`"
            placeholderTextColor={t.text.placeholder}
            style={[styles.input, { color: t.text.primary, borderColor: t.border.default }]}
          />
        </View>
        <Pressable
          onPress={() => testAndSave()}
          disabled={testing}
          style={({ pressed }) => [
            styles.button,
            {
              backgroundColor: pressed ? t.accent.pressed : t.accent.primary,
              opacity: testing ? 0.7 : 1,
            },
          ]}>
          {testing ? (
            <ActivityIndicator color={t.accent.fg} />
          ) : (
            <Text style={[styles.buttonLabel, { color: t.accent.fg }]}>Test & save</Text>
          )}
        </Pressable>
        <Text style={[styles.hint, { color: t.text.muted }]}>
          Make sure this device and the bridge are on the same Tailscale network. URL must be reachable from
          the browser/phone you&apos;re running this app on.
          {Platform.OS === 'web' ? ' Browsers require an HTTPS bridge URL.' : ''}
        </Text>
        <Pressable
          onPress={() => void Linking.openURL(WEB_SETUP_DOCS_URL)}
          hitSlop={8}
          style={({ pressed }) => [styles.docsLink, { opacity: pressed ? 0.6 : 1 }]}>
          <Text style={[styles.docsLinkLabel, { color: t.accent.primary }]}>
            Where do I get this URL? →
          </Text>
        </Pressable>

        <SessionHistorySection />
        <VisualFeedbackSection />
      </ScrollView>

      <QRScanner visible={scannerOpen} onClose={() => setScannerOpen(false)} onScan={onScan} />
    </KeyboardAvoidingView>
  );
}

function SessionHistorySection() {
  const t = useTheme();
  const { historyDays, load, setHistoryDays } = useHistoryDays();
  const { defaultCollapsed, load: loadDefaultCollapsed, setDefaultCollapsed } = useDefaultCollapsed();
  const { excludeSubagents, load: loadExcludeSubagents, setExcludeSubagents } = useExcludeSubagents();
  const { repoPath, load: loadRepoPath, setRepoPath } = useRepoPath();
  const runImport = useSessionImport((s) => s.runImport);
  const importStatus = useSessionImport((s) => s.status);
  const [localDays, setLocalDays] = useState(String(historyDays));
  const [localRepoPath, setLocalRepoPath] = useState(repoPath);

  useEffect(() => { void load(); void loadDefaultCollapsed(); void loadExcludeSubagents(); void loadRepoPath(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setLocalRepoPath(repoPath); }, [repoPath]);
  useEffect(() => { setLocalDays(String(historyDays)); }, [historyDays]);

  function commitDays() {
    const n = parseInt(localDays, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 365) setHistoryDays(n);
    else setLocalDays(String(historyDays));
  }

  function resync() {
    const bridges = useBridgesStore.getState().bridges;
    for (const b of bridges) void runImport(b, { force: true });
  }

  return (
    <View style={styles.section}>
      <View style={[styles.sectionDivider, { backgroundColor: t.border.default }]} />
      <Text style={[styles.sectionTitle, { color: t.text.primary }]}>Session history</Text>
      <Text style={[styles.sectionBody, { color: t.text.secondary }]}>
        How many days of session history to import and cache locally. Default is 30.
      </Text>
      <View style={[styles.toggleRow, { backgroundColor: t.surface.raised, borderColor: t.border.subtle }]}>
        <Text style={[styles.toggleLabel, { color: t.text.primary }]}>Days of history</Text>
        <TextInput
          value={localDays}
          onChangeText={setLocalDays}
          onBlur={commitDays}
          onSubmitEditing={commitDays}
          keyboardType="number-pad"
          maxLength={3}
          style={[styles.input, { color: t.text.primary, borderColor: t.border.default, width: 64, textAlign: 'center' }]}
        />
      </View>
      <View style={[styles.toggleRow, { backgroundColor: t.surface.raised, borderColor: t.border.subtle, flexDirection: 'column', alignItems: 'stretch', gap: 6 }]}>
        <Text style={[styles.toggleLabel, { color: t.text.primary }]}>Repo root path</Text>
        <Text style={[styles.toggleHint, { color: t.text.secondary }]}>
          Only sessions whose working directory starts with this path are shown. Leave empty to show all.
        </Text>
        <TextInput
          value={localRepoPath}
          onChangeText={setLocalRepoPath}
          onBlur={() => setRepoPath(localRepoPath)}
          onSubmitEditing={() => setRepoPath(localRepoPath)}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="/home/you/repos"
          placeholderTextColor={t.text.muted}
          style={[styles.input, { color: t.text.primary, borderColor: t.border.default, flex: undefined, width: '100%' }]}
        />
      </View>
      <View style={[styles.toggleRow, { backgroundColor: t.surface.raised, borderColor: t.border.subtle }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.toggleLabel, { color: t.text.primary }]}>Collapse repos by default</Text>
          <Text style={[styles.toggleHint, { color: t.text.secondary }]}>
            Repos start folded — tap the triangle to expand them.
          </Text>
        </View>
        <Switch
          value={defaultCollapsed}
          onValueChange={setDefaultCollapsed}
          trackColor={{ true: t.accent.primary }}
        />
      </View>
      <View style={[styles.toggleRow, { backgroundColor: t.surface.raised, borderColor: t.border.subtle }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.toggleLabel, { color: t.text.primary }]}>Hide subagent sessions</Text>
          <Text style={[styles.toggleHint, { color: t.text.secondary }]}>
            Hides subagents (UUID/hash-named worktrees) and system sessions (.claude-mem observer sessions).
          </Text>
        </View>
        <Switch
          value={excludeSubagents}
          onValueChange={setExcludeSubagents}
          trackColor={{ true: t.accent.primary }}
        />
      </View>
      <Pressable
        onPress={resync}
        disabled={importStatus === 'running'}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: pressed ? t.accent.pressed : t.accent.primary, opacity: importStatus === 'running' ? 0.6 : 1 },
        ]}>
        <Text style={[styles.buttonLabel, { color: t.accent.fg }]}>
          {importStatus === 'running' ? 'Syncing…' : 'Re-sync now'}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * "Visual feedback" Settings section. Master switch + sub-switch, plus a
 * brief explanation of what enabling it means. The master switch is the
 * outermost gate before driver capability / canUseTool / per-session
 * toggle (see `docs/sdd/2026-05-25-preview-takeover/`).
 */
function VisualFeedbackSection() {
  const t = useTheme();
  const settings = useHydratedSettings();
  const enabled = settings.enableVisualFeedback;
  const alwaysAsk = settings.alwaysAskBeforeCapture;

  return (
    <View style={styles.section}>
      <View style={[styles.sectionDivider, { backgroundColor: t.border.default }]} />
      <Text style={[styles.sectionTitle, { color: t.text.primary }]}>Visual feedback</Text>
      <Text style={[styles.sectionBody, { color: t.text.secondary }]}>
        Let Claude verify changes by capturing your live preview. You&apos;ll still be
        asked before each new tool the first time.
      </Text>
      <View
        style={[
          styles.toggleRow,
          { backgroundColor: t.surface.raised, borderColor: t.border.subtle },
        ]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.toggleLabel, { color: t.text.primary }]}>Enable visual feedback</Text>
          <Text style={[styles.toggleHint, { color: t.text.muted }]}>
            Off by default. When on, the manual shutter appears on the preview pane and
            Claude can request captures via tools you approve.
          </Text>
        </View>
        <Switch
          value={enabled}
          onValueChange={(b) => void settings.setEnableVisualFeedback(b)}
        />
      </View>
      {enabled ? (
        <View
          style={[
            styles.toggleRow,
            { backgroundColor: t.surface.raised, borderColor: t.border.subtle },
          ]}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.toggleLabel, { color: t.text.primary }]}>
              Always ask before each capture
            </Text>
            <Text style={[styles.toggleHint, { color: t.text.muted }]}>
              Hides the &ldquo;Always allow&rdquo; button so you decide every time.
            </Text>
          </View>
          <Switch
            value={alwaysAsk}
            onValueChange={(b) => void settings.setAlwaysAskBeforeCapture(b)}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: space[5], gap: space[4] },
  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    padding: space[3] + 2,
    borderRadius: radius.xl,
    borderWidth: 1,
  },
  scanIcon: { fontSize: fontSize['4xl'], fontWeight: '700' },
  scanTitle: { fontSize: fontSize.lg, fontWeight: '600' },
  scanHint: { fontSize: fontSize.sm, marginTop: 2 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  line: { flex: 1, height: StyleSheet.hairlineWidth },
  dividerText: { fontSize: fontSize.xs },
  field: { gap: space[1.5] },
  label: { fontSize: fontSize.base, fontWeight: '500' },
  input: {
    fontSize: fontSize.xl,
    borderWidth: 1,
    borderRadius: radius.lg + 2,
    paddingHorizontal: space[3],
    paddingVertical: space[3],
  },
  button: {
    paddingVertical: space[3] + 2,
    borderRadius: radius.lg + 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  buttonLabel: { fontWeight: '600', fontSize: fontSize.xl },
  hint: { fontSize: fontSize.sm, lineHeight: 18, marginTop: space[2] },
  docsLink: { alignSelf: 'flex-start', marginTop: 2 },
  docsLinkLabel: { fontSize: fontSize.sm, fontWeight: '600' },
  section: { gap: space[3], marginTop: space[3] },
  sectionDivider: { height: StyleSheet.hairlineWidth, marginBottom: space[2] },
  sectionTitle: { fontSize: fontSize.xl, fontWeight: '700' },
  sectionBody: { fontSize: fontSize.sm, lineHeight: 20 },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    padding: space[3],
    borderRadius: radius.lg + 2,
    borderWidth: 1,
  },
  toggleLabel: { fontSize: fontSize.base, fontWeight: '600' },
  toggleHint: { fontSize: fontSize.xs, marginTop: 2, lineHeight: 16 },
});
