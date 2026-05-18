// Push-notification registration. Temporarily stubbed: `expo-notifications`
// pulls in the iOS `aps-environment` entitlement via autolinking, which
// requires a paid Apple Developer Program account with Push Notifications
// enabled on the App ID. Until we have that, this module is a no-op so the
// build succeeds. The bridge-side endpoint (POST /devices) is untouched.
//
// To re-enable:
//   1. `pnpm add expo-notifications expo-device` in mobile/
//   2. Add the `expo-notifications` plugin back to app.json
//   3. Enable Push Notifications on the App ID in Apple Developer portal
//   4. Restore this file from git history (commit before this change)

interface BridgeConfig {
  baseUrl: string;
  token?: string;
}

export async function getExpoPushToken(): Promise<string | null> {
  return null;
}

/** Stub: pretends to register but does nothing. Replace when push is re-enabled. */
export async function registerWithBridge(_cfg: BridgeConfig): Promise<boolean> {
  return false;
}
