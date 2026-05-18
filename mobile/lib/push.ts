import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

interface BridgeConfig {
  baseUrl: string;
  token?: string;
}

let cachedToken: string | null = null;

// Foreground behavior: when a push arrives while the app is open, show banner +
// play sound so the user is still notified.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Acquire an Expo push token. Returns null if the device can't receive pushes
 * (simulator, permission denied, missing config). Safe to call repeatedly —
 * caches the token after the first success.
 */
export async function getExpoPushToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  if (!Device.isDevice) {
    console.log('[push] simulator/emulator — skipping push registration');
    return null;
  }

  const existing = await Notifications.getPermissionsAsync();
  let granted = existing.granted || existing.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
  if (!granted) {
    const req = await Notifications.requestPermissionsAsync();
    granted = req.granted;
  }
  if (!granted) {
    console.log('[push] permission denied');
    return null;
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Default',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  try {
    const projectId =
      (Constants.expoConfig?.extra as any)?.eas?.projectId ??
      (Constants.easConfig as any)?.projectId;
    const t = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    cachedToken = t.data;
    console.log(`[push] expo token: ${cachedToken.slice(0, 24)}…`);
    return cachedToken;
  } catch (err) {
    console.log('[push] getExpoPushTokenAsync failed:', (err as Error).message);
    return null;
  }
}

/** Register this device's push token with the bridge. No-op on failure. */
export async function registerWithBridge(cfg: BridgeConfig): Promise<boolean> {
  if (!cfg.baseUrl) return false;
  const token = await getExpoPushToken();
  if (!token) return false;
  try {
    const res = await fetch(`${cfg.baseUrl}/devices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
      },
      body: JSON.stringify({ token, platform: Platform.OS }),
    });
    if (!res.ok) {
      console.log(`[push] bridge register → ${res.status}`);
      return false;
    }
    console.log('[push] registered with bridge');
    return true;
  } catch (err) {
    console.log('[push] bridge register failed:', (err as Error).message);
    return false;
  }
}
