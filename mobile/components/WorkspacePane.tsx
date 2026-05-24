import { fontSize, radius, space, useTheme } from '@/theme';
import * as Haptics from 'expo-haptics';
import { useState, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

type WorkspaceMode = 'files' | 'preview';

interface WorkspacePaneProps {
  /** Whether this page is currently the visible pager page. Forwarded into
   *  the active mode's renderer so it can decide whether to poll / fetch. */
  active: boolean;
  /** Renderer for the Files mode. Receives `active` = (pageActive AND
   *  mode === 'files'). */
  files: (active: boolean) => ReactNode;
  /** Renderer for the Preview mode. Receives `active` = (pageActive AND
   *  mode === 'preview'). */
  preview: (active: boolean) => ReactNode;
}

/**
 * Right-side pager page that hosts both the file browser/diff explorer
 * and the dev-server preview behind a segmented header control. Both
 * child trees stay mounted — toggling between modes only flips
 * `display`, so the WebView keeps its loaded URL and the FilesPane
 * keeps its scroll position when the user switches back.
 *
 * Replaces the pre-existing 3-page layout (Chat | Files | Preview) so
 * the user only needs one swipe to reach either workspace mode.
 */
export function WorkspacePane({ active, files, preview }: WorkspacePaneProps) {
  const t = useTheme();
  const [mode, setMode] = useState<WorkspaceMode>('files');

  const onSelect = (next: WorkspaceMode) => {
    if (next === mode) return;
    if (Platform.OS !== 'web') {
      Haptics.selectionAsync().catch(() => undefined);
    }
    setMode(next);
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.surface.base }}>
      <View style={[styles.header, { borderBottomColor: t.border.subtle }]}>
        <View style={[styles.segment, { backgroundColor: t.surface.sunken }]}>
          {(['files', 'preview'] as const).map((m) => {
            const selected = mode === m;
            return (
              <Pressable
                key={m}
                onPress={() => onSelect(m)}
                style={[
                  styles.segmentItem,
                  selected
                    ? { backgroundColor: t.surface.raised, borderColor: t.border.default }
                    : { borderColor: 'transparent' },
                ]}>
                <Text
                  style={[
                    styles.segmentLabel,
                    {
                      color: selected ? t.text.primary : t.text.secondary,
                      fontWeight: selected ? '700' : '500',
                    },
                  ]}>
                  {m === 'files' ? 'Files' : 'Preview'}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      <View style={{ flex: 1 }}>
        <View style={[styles.pane, mode === 'files' ? null : styles.hidden]}>
          {files(active && mode === 'files')}
        </View>
        <View style={[styles.pane, mode === 'preview' ? null : styles.hidden]}>
          {preview(active && mode === 'preview')}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  segment: {
    flexDirection: 'row',
    borderRadius: radius.lg,
    padding: 3,
    alignSelf: 'center',
  },
  segmentItem: {
    paddingHorizontal: space[5],
    paddingVertical: space[1] + 2,
    borderRadius: radius.md + 2,
    borderWidth: StyleSheet.hairlineWidth,
  },
  segmentLabel: { fontSize: fontSize.sm },
  pane: { ...StyleSheet.absoluteFillObject },
  hidden: { display: 'none' },
});
