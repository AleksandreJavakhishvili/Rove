import { fontSize, radius, space, useTheme } from '@/theme';
import * as Haptics from 'expo-haptics';
import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

export type WorkspaceMode = 'files' | 'preview';

/**
 * Imperative handle exposed by `<WorkspacePane>`. The takeover
 * controller calls `setMode('preview')` + `setLocked(true)` on engage
 * and the inverses on exit. `getMode()` is used to snapshot the user's
 * prior mode so we restore it after the agent's burst.
 */
export interface WorkspacePaneHandle {
  setMode: (mode: WorkspaceMode) => void;
  setLocked: (locked: boolean) => void;
  getMode: () => WorkspaceMode;
}

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
  /** Overlay rendered absolutely on top of the preview pane (and only the
   *  preview pane). Used by the visual-feedback-loop SDD Phase 1 to mount
   *  the screenshot shutter button. Hidden when the user is on the Files
   *  mode so the shutter is contextual to "I'm looking at the preview." */
  previewOverlay?: ReactNode;
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
export const WorkspacePane = forwardRef<WorkspacePaneHandle, WorkspacePaneProps>(
  function WorkspacePane({ active, files, preview, previewOverlay }, ref) {
    const t = useTheme();
    const [mode, setMode] = useState<WorkspaceMode>('files');
    const [locked, setLocked] = useState(false);
    const modeRef = useRef<WorkspaceMode>('files');
    modeRef.current = mode;

    useImperativeHandle(ref, () => ({
      setMode: (next) => setMode(next),
      setLocked: (next) => setLocked(next),
      getMode: () => modeRef.current,
    }));

    const onSelect = (next: WorkspaceMode) => {
      if (locked) return;
      if (next === mode) return;
      if (Platform.OS !== 'web') {
        Haptics.selectionAsync().catch(() => undefined);
      }
      setMode(next);
    };

    return (
      <View style={{ flex: 1, backgroundColor: t.surface.base }}>
        <View style={[styles.header, { borderBottomColor: t.border.subtle }]}>
          <View
            style={[
              styles.segment,
              { backgroundColor: t.surface.sunken, opacity: locked ? 0.5 : 1 },
            ]}>
            {(['files', 'preview'] as const).map((m) => {
              const selected = mode === m;
              return (
                <Pressable
                  key={m}
                  onPress={() => onSelect(m)}
                  disabled={locked}
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
            {/* Overlay (e.g. screenshot shutter) is rendered above the
                WebView only when Preview mode is currently active so the
                affordance reads as "capture what I'm looking at." */}
            {previewOverlay && mode === 'preview' && active ? previewOverlay : null}
          </View>
        </View>
      </View>
    );
  },
);

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
