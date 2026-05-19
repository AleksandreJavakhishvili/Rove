import { fontSize, radius, space, useTheme } from '@/theme';
import { Pressable, StyleSheet, Text, View } from 'react-native';

interface Props {
  url: string;
  backgroundColor: string;
}

export function PreviewFrame({ url, backgroundColor }: Props) {
  const t = useTheme();
  return (
    <View style={[styles.root, { backgroundColor }]}>
      <iframe
        src={url}
        style={{
          flex: 1,
          width: '100%',
          height: '100%',
          border: 'none',
          backgroundColor,
        }}
        // Sandbox the embedded site so a hostile dev server can't navigate the
        // top frame or read storage. `allow-scripts` is needed for almost any
        // modern dev page; `allow-forms` is harmless and useful for sign-in
        // flows. We deliberately omit `allow-same-origin` — meaning embedded
        // pages can't read OUR cookies/storage, which is the property we want.
        sandbox="allow-scripts allow-forms allow-popups"
        referrerPolicy="no-referrer"
      />
      <View pointerEvents="box-none" style={styles.escape}>
        <Pressable
          onPress={() => window.open(url, '_blank', 'noopener,noreferrer')}
          style={({ pressed }) => [
            styles.escapeBtn,
            {
              backgroundColor: pressed ? t.surface.pressed : t.surface.raised,
              borderColor: t.border.subtle,
            },
          ]}>
          <Text style={[styles.escapeLabel, { color: t.text.primary }]}>Open in new tab ↗</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, position: 'relative' },
  escape: {
    position: 'absolute',
    top: space[2],
    right: space[2],
  },
  escapeBtn: {
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  escapeLabel: { fontSize: fontSize.xs, fontWeight: '600' },
});
