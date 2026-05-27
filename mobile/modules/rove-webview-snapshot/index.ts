import { requireNativeModule } from 'expo-modules-core';
import { findNodeHandle, Platform, type View } from 'react-native';
import { captureRef } from 'react-native-view-shot';

/**
 * Native module surface. Only the iOS impl is registered (see
 * `expo-module.config.json` — `platforms: ['ios']`). Calling
 * `snapshotByTag` on any other platform will throw at `requireNativeModule`
 * time, so we gate access through `snapshotWebView` below which
 * routes per-platform.
 */
interface RoveWebViewSnapshotNative {
  /** Returns a base64-encoded PNG of the WKWebView identified by
   *  `viewTag`. Looks up the view via Expo's app context, walks the
   *  subtree to find the WKWebView, then calls Apple's
   *  `WKWebView.takeSnapshot` API. */
  snapshotByTag(viewTag: number): Promise<string>;
}

/** Lazily resolved so importing this module on Android / web doesn't
 *  throw at evaluation time. */
let nativeModule: RoveWebViewSnapshotNative | null = null;
function getNativeModule(): RoveWebViewSnapshotNative {
  if (!nativeModule) {
    nativeModule = requireNativeModule<RoveWebViewSnapshotNative>('RoveWebViewSnapshot');
  }
  return nativeModule;
}

/** Anything `findNodeHandle` accepts — a ref-bearing object, a numeric
 *  reactTag, or a view instance. */
type WebViewRefLike = Parameters<typeof findNodeHandle>[0];

/** Optional fallback view ref the caller can hand us for non-iOS
 *  platforms. The fallback path captures *that* view's subtree via
 *  view-shot — typically the wrapper `<View>` around the WebView. */
interface SnapshotOptions {
  /** Used only on Android (and as the iOS error fallback). Should
   *  point at the wrapper View that contains the WebView. */
  fallbackRef?: React.RefObject<View | null>;
}

/**
 * Capture the live content of a WKWebView/WebView and return a
 * base64-encoded PNG.
 *
 * iOS path: routes through the native `takeSnapshot` API so the
 * snapshot is pixel-accurate even when the WebView has been
 * offscreen / `display:none` for a while. Eliminates the stale-
 * compositor-cache bug that `react-native-view-shot` suffers from on
 * iOS.
 *
 * Android path: WebView is in-process, so `react-native-view-shot`
 * works correctly. We use that against the caller-supplied
 * `fallbackRef` (typically the wrapper View around the WebView).
 *
 * Web path: not supported. The hook layer above us already gates on
 * `Platform.OS === 'ios' || 'android'`.
 */
export async function snapshotWebView(
  webViewRef: WebViewRefLike,
  options: SnapshotOptions = {},
): Promise<string> {
  if (Platform.OS === 'ios') {
    const tag = findNodeHandle(webViewRef);
    if (tag === null) {
      throw new Error('snapshotWebView: webViewRef is not attached to a mounted view');
    }
    return getNativeModule().snapshotByTag(tag);
  }
  if (Platform.OS === 'android') {
    if (!options.fallbackRef?.current) {
      throw new Error(
        'snapshotWebView: Android requires a fallbackRef pointing at the wrapper View',
      );
    }
    return captureRef(options.fallbackRef.current, {
      format: 'png',
      quality: 1,
      result: 'base64',
    });
  }
  throw new Error(`snapshotWebView: unsupported platform ${Platform.OS}`);
}
