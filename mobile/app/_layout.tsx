import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';

import { useEnsurePendingPermissionsStream } from '@/lib/store';
import { useWebBootstrap } from '@/lib/web-bootstrap';
import { useTheme } from '@/theme';

// React Native Reanimated 4.x's web worklet runtime currently mishandles
// transform-style commits during Stack screen transitions, surfacing as
// "Failed to set an indexed property [0] on 'CSSStyleDeclaration'". Disabling
// Stack animations on web side-steps the buggy path entirely. Native gets the
// default animation as before.
const webScreenOptions = Platform.OS === 'web' ? ({ animation: 'none' } as const) : null;

export default function RootLayout() {
  const t = useTheme();
  const isDark = t.scheme === 'dark';
  useWebBootstrap();
  // Keep the bridge-wide events stream alive as long as the app is mounted, so
  // permission requests fired while the user is inside a chat are not lost.
  useEnsurePendingPermissionsStream();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={isDark ? DarkTheme : DefaultTheme}>
        <Stack
          screenOptions={{
            headerLargeTitle: false,
            contentStyle: { backgroundColor: t.surface.base },
            ...webScreenOptions,
          }}>
          <Stack.Screen name="index" options={{ title: 'Sessions' }} />
          <Stack.Screen
            name="settings"
            options={{
              title: 'Bridge settings',
              presentation: Platform.OS === 'web' ? 'card' : 'modal',
            }}
          />
          <Stack.Screen name="sessions/[agent]/[id]/index" options={{ title: 'Chat' }} />
          <Stack.Screen name="sessions/[agent]/[id]/file" options={{ title: 'File' }} />
          <Stack.Screen name="sessions/[agent]/[id]/diff" options={{ title: 'Diff' }} />
        </Stack>
        <StatusBar style={isDark ? 'light' : 'dark'} />
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
