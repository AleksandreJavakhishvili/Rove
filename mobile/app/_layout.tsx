import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import * as Notifications from 'expo-notifications';
import { router, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import 'react-native-reanimated';

import { useTheme } from '@/theme';

export default function RootLayout() {
  const t = useTheme();
  const isDark = t.scheme === 'dark';

  // Tap-to-route: when a push notification carrying {agent, sessionId} is tapped,
  // open the corresponding chat screen.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as { agent?: string; sessionId?: string };
      if (data?.agent && data?.sessionId) {
        router.push(`/sessions/${data.agent}/${data.sessionId}`);
      }
    });
    return () => sub.remove();
  }, []);

  return (
    <ThemeProvider value={isDark ? DarkTheme : DefaultTheme}>
      <Stack
        screenOptions={{
          headerLargeTitle: false,
          contentStyle: { backgroundColor: t.surface.base },
        }}>
        <Stack.Screen name="index" options={{ title: 'Sessions' }} />
        <Stack.Screen name="settings" options={{ title: 'Bridge settings', presentation: 'modal' }} />
        <Stack.Screen name="sessions/[agent]/[id]/index" options={{ title: 'Chat' }} />
        <Stack.Screen name="sessions/[agent]/[id]/file" options={{ title: 'File' }} />
        <Stack.Screen name="sessions/[agent]/[id]/diff" options={{ title: 'Diff' }} />
      </Stack>
      <StatusBar style={isDark ? 'light' : 'dark'} />
    </ThemeProvider>
  );
}
