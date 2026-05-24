import { fontSize, radius, space, useTheme } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef } from 'react';
import {
  Alert,
  Animated,
  Dimensions,
  Easing,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

export interface BubbleAction {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  destructive?: boolean;
  onPress: () => void;
}

export interface BubbleMenuAnchor {
  x: number;
  y: number;
}

interface BubbleActionMenuProps {
  visible: boolean;
  anchor: BubbleMenuAnchor | null;
  actions: BubbleAction[];
  onClose: () => void;
}

const MENU_WIDTH = 220;
const MENU_PADDING = 12;
const ITEM_HEIGHT = 44;
const SCREEN_EDGE = 12;

export function BubbleActionMenu({ visible, anchor, actions, onClose }: BubbleActionMenuProps) {
  const t = useTheme();
  const scale = useRef(new Animated.Value(0.85)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) return;
    scale.setValue(0.85);
    opacity.setValue(0);
    Animated.parallel([
      Animated.spring(scale, {
        toValue: 1,
        useNativeDriver: true,
        speed: 22,
        bounciness: 8,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: 140,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [visible, scale, opacity]);

  const close = () => {
    Animated.parallel([
      Animated.timing(scale, {
        toValue: 0.9,
        duration: 110,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 110,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (finished) onClose();
    });
  };

  const { x, y } = anchor ?? { x: 0, y: 0 };
  const win = Dimensions.get('window');
  const estimatedHeight = MENU_PADDING * 2 + actions.length * ITEM_HEIGHT;
  const left = Math.min(Math.max(SCREEN_EDGE, x - MENU_WIDTH / 2), win.width - MENU_WIDTH - SCREEN_EDGE);
  const showAbove = y > win.height - estimatedHeight - 80;
  const top = showAbove ? Math.max(SCREEN_EDGE, y - estimatedHeight - 8) : Math.min(y + 8, win.height - estimatedHeight - SCREEN_EDGE);

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={close} statusBarTranslucent>
      <Pressable style={styles.scrim} onPress={close}>
        <Animated.View
          style={[
            styles.menu,
            {
              top,
              left,
              width: MENU_WIDTH,
              opacity,
              transform: [{ scale }],
              backgroundColor: t.surface.raised,
              borderColor: t.border.subtle,
              shadowColor: '#000',
            },
          ]}>
          {actions.map((a, i) => (
            <Pressable
              key={a.key}
              onPress={() => {
                Haptics.selectionAsync().catch(() => undefined);
                close();
                setTimeout(a.onPress, 120);
              }}
              style={({ pressed }) => [
                styles.item,
                {
                  backgroundColor: pressed ? t.surface.pressed : 'transparent',
                  borderTopColor: t.border.subtle,
                  borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
                },
              ]}>
              <Text
                style={[
                  styles.label,
                  { color: a.destructive ? t.status.danger : t.text.primary },
                ]}>
                {a.label}
              </Text>
              <Ionicons
                name={a.icon}
                size={fontSize.xl}
                color={a.destructive ? t.status.danger : t.text.primary}
              />
            </Pressable>
          ))}
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

/**
 * Shared helper: build a Copy action for a message bubble. Fires medium
 * impact haptic on success, surfaces failure as an Alert.
 */
export function copyAction(text: string): BubbleAction {
  return {
    key: 'copy',
    label: 'Copy',
    icon: 'copy-outline',
    onPress: async () => {
      try {
        await Clipboard.setStringAsync(text.trim());
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (err) {
        Alert.alert('Copy failed', String((err as Error).message ?? err));
      }
    },
  };
}

export function rewindAction(messageId: string, onRewind: (id: string) => void): BubbleAction {
  return {
    key: 'rewind',
    label: 'Rewind to here',
    icon: 'arrow-undo-outline',
    destructive: true,
    onPress: () => onRewind(messageId),
  };
}

/** Call from the press handler's `onLongPress` to play the open haptic. */
export function triggerOpenHaptic() {
  if (Platform.OS === 'web') return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.25)' },
  menu: {
    position: 'absolute',
    borderRadius: radius.lg + 4,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 6,
    shadowOpacity: 0.25,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
    overflow: 'hidden',
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space[4],
    height: ITEM_HEIGHT,
  },
  label: { fontSize: fontSize.lg, fontWeight: '500' },
});
