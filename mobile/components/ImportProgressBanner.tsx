import { useSessionImport } from '@/hooks/useSessionImport';
import { useTheme } from '@/theme';
import { useEffect, useRef } from 'react';
import { Animated, ActivityIndicator, StyleSheet, Text, View } from 'react-native';

export function ImportProgressBanner() {
  const { status, loaded, total } = useSessionImport();
  const t = useTheme();
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (status === 'running') {
      opacity.setValue(1);
    } else if (status === 'done') {
      Animated.timing(opacity, {
        toValue: 0,
        duration: 600,
        useNativeDriver: true,
      }).start();
    }
  }, [status, opacity]);

  if (status === 'idle') return null;

  const scanning = status === 'running' && total === 0;
  const label = status === 'done'
    ? 'Sync complete'
    : scanning
    ? 'Scanning sessions…'
    : `Syncing sessions… ${loaded} / ${total}`;

  return (
    <Animated.View style={[styles.strip, { backgroundColor: t.surface.raised, opacity }]}>
      {scanning ? <ActivityIndicator size="small" color={t.text.secondary} style={styles.spinner} /> : null}
      <Text style={[styles.label, { color: t.text.secondary }]}>{label}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  strip: {
    height: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  spinner: { marginRight: 2 },
  label: {
    fontSize: 12,
  },
});
