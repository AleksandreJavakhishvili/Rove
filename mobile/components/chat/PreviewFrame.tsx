import { forwardRef, useImperativeHandle, useRef } from 'react';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import {
  PAINT_MESSAGE_KIND,
  READY_MESSAGE_KIND,
  WAIT_FOR_PAINT_TIMEOUT_MS,
  WAIT_FOR_READY_TIMEOUT_MS,
  WEBVIEW_LOAD_CUSHION_MS,
  WEBVIEW_NAV_TIMEOUT_MS,
} from '@/components/takeover/constants';

interface Props {
  url: string;
  backgroundColor: string;
}

/**
 * Imperative handle the takeover controller uses to drive the WebView
 * during agent capture.
 *
 *  - `navigate(targetUrl)` injects `location.assign()` (rather than
 *    rebuilding the `source` prop) so the dev-server's HMR + SPA
 *    router handle the change in-page instead of triggering a full
 *    document reload.
 *  - `currentUrl()` echoes the URL the WebView reported via its
 *    `onNavigationStateChange` callback — best-effort, may lag SPA
 *    navigation by a tick.
 *  - `waitForPaint()` injects a double-`requestAnimationFrame` probe
 *    that posts back over `onMessage` after the *next* committed paint.
 *    Replaces the old fixed-cushion sleeps. Resolves on the paint
 *    signal or after a safety timeout — never rejects, so the capture
 *    pipeline can `await` it unconditionally.
 *
 * See `docs/sdd/2026-05-25-preview-takeover/`.
 */
export interface PreviewFrameHandle {
  /** Inject `location.assign(<url>)` and resolve on the next
   *  `onLoadEnd` (or after `WEBVIEW_NAV_TIMEOUT_MS` as a safety net). */
  navigate: (targetUrl: string) => Promise<void>;
  /** Reload the current page. */
  reload: () => void;
  /** Best-effort current URL — derived from
   *  `onNavigationStateChange.url`. May be `undefined` until the first
   *  load completes. */
  currentUrl: () => string | undefined;
  /**
   * Wait for the WebView to commit a paint after this call was made.
   * Works by injecting two nested `requestAnimationFrame` callbacks
   * and waiting for the inner one to post back over the message
   * channel. The first rAF schedules the next paint; the second
   * confirms it actually landed. Falls back to
   * `WAIT_FOR_PAINT_TIMEOUT_MS` if the page can't run JS (CSP, crash,
   * etc.) so the capture pipeline can't hang.
   */
  waitForPaint: () => Promise<void>;
  /**
   * Wait for the page to be visually ready: `document.readyState ===
   * 'complete'` (load event has fired) → `requestIdleCallback`
   * (browser thinks main thread settled, with a 50ms setTimeout
   * fallback for browsers that don't support rIC) → two
   * `requestAnimationFrame`s (paint commits).
   *
   * Use this instead of `waitForPaint` when the WebView may still be
   * loading — e.g., right after `navigate()` or when the page was
   * offscreen long enough that WebKit may have suspended rendering.
   *
   * Resolves when the page is ready OR after `timeoutMs` (or
   * `WAIT_FOR_READY_TIMEOUT_MS` if unspecified) — never rejects.
   */
  waitForReady: (timeoutMs?: number) => Promise<void>;
  /**
   * Returns the underlying `react-native-webview` ref so callers can
   * pass it to the native snapshot module (`rove-webview-snapshot`).
   * The native module uses `findNodeHandle` on this ref to locate the
   * embedded WKWebView and call Apple's `takeSnapshot` API directly.
   *
   * Prefer this over the wrapper-View capture path on iOS — view-shot
   * captures the host compositor's cached layer, which goes stale
   * when the WebView has been offscreen. takeSnapshot is sourced from
   * the WebKit content process, so it's always current.
   */
  getNativeRef: () => unknown;
}

/** Internal — message payload structure the injected probes post back.
 *  Two probe kinds share the same channel; the `kind` field selects
 *  the matching resolver map. */
type ProbeKind = typeof PAINT_MESSAGE_KIND | typeof READY_MESSAGE_KIND;
interface ProbeMessage {
  kind: ProbeKind;
  nonce: string;
}

function isProbeMessage(value: unknown): value is ProbeMessage {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.nonce !== 'string') return false;
  return obj.kind === PAINT_MESSAGE_KIND || obj.kind === READY_MESSAGE_KIND;
}

export const PreviewFrame = forwardRef<PreviewFrameHandle, Props>(function PreviewFrame(
  { url, backgroundColor },
  ref,
) {
  const webViewRef = useRef<WebView | null>(null);
  /** Latest URL the WebView reported. Tracked so the takeover controller
   *  can echo it back to the agent as `resolvedUrl`. */
  const currentUrlRef = useRef<string | undefined>(undefined);
  /** Resolvers waiting on the next `onLoadEnd`. Each `navigate()` call
   *  pushes one; the first onLoadEnd after the call drains them all. */
  const loadEndResolvers = useRef<Array<() => void>>([]);
  /** Pending probe resolvers, keyed by nonce. A unique nonce per
   *  `waitForPaint()` / `waitForReady()` call means we can have
   *  multiple in flight (rare, but possible if the takeover
   *  controller is chaining captures) and resolve them in order
   *  without aliasing. Both probe kinds share this map — the message
   *  parser doesn't need to distinguish since the nonce is unique. */
  const probeResolvers = useRef<Map<string, () => void>>(new Map());

  useImperativeHandle(ref, () => ({
    navigate: (targetUrl) =>
      new Promise<void>((resolve) => {
        const webView = webViewRef.current;
        if (!webView) {
          resolve();
          return;
        }
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          currentUrlRef.current = targetUrl;
          resolve();
        };
        loadEndResolvers.current.push(finish);
        setTimeout(finish, WEBVIEW_NAV_TIMEOUT_MS);
        webView.injectJavaScript(
          `window.location.assign(${JSON.stringify(targetUrl)}); true;`,
        );
      }),
    reload: () => {
      webViewRef.current?.reload();
    },
    currentUrl: () => currentUrlRef.current,
    getNativeRef: () => webViewRef.current,
    waitForReady: (timeoutMs) =>
      new Promise<void>((resolve) => {
        const webView = webViewRef.current;
        if (!webView) {
          resolve();
          return;
        }
        const nonce = randomNonce();
        const deadline = timeoutMs ?? WAIT_FOR_READY_TIMEOUT_MS;
        let settled = false;
        const safetyTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          probeResolvers.current.delete(nonce);
          resolve();
        }, deadline);
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(safetyTimer);
          probeResolvers.current.delete(nonce);
          resolve();
        };
        probeResolvers.current.set(nonce, finish);
        // Inject the readiness probe. The script handles three cases:
        //   1. Document is already complete → schedule the idle + paint
        //      check immediately.
        //   2. Document is still loading → wait for the load event
        //      first, THEN schedule.
        //   3. requestIdleCallback unavailable (older WebKit) → fall
        //      back to a small setTimeout so the chain still completes.
        const script = `
          (function () {
            try {
              var KIND = ${JSON.stringify(READY_MESSAGE_KIND)};
              var NONCE = ${JSON.stringify(nonce)};
              function postBack() {
                if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
                  window.ReactNativeWebView.postMessage(JSON.stringify({
                    kind: KIND,
                    nonce: NONCE,
                  }));
                }
              }
              function afterIdle() {
                requestAnimationFrame(function () {
                  requestAnimationFrame(postBack);
                });
              }
              function onReady() {
                var idleFn = window.requestIdleCallback || function (cb) { setTimeout(cb, 50); };
                idleFn(afterIdle);
              }
              if (document.readyState === 'complete') {
                onReady();
              } else {
                window.addEventListener('load', onReady, { once: true });
              }
            } catch (e) {
              // Safety timeout will drain the resolver.
            }
          })();
          true;
        `;
        webView.injectJavaScript(script);
      }),
    waitForPaint: () =>
      new Promise<void>((resolve) => {
        const webView = webViewRef.current;
        if (!webView) {
          resolve();
          return;
        }
        // Crypto-strength is overkill; collision risk across two
        // concurrent waitForPaint calls is what we're guarding against.
        // The chance of a 16-char random hex collision is ~2^-64 per
        // pair, which is fine for our use-case.
        const nonce = randomNonce();

        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          probeResolvers.current.delete(nonce);
          resolve();
        };

        probeResolvers.current.set(nonce, finish);
        const safetyTimer = setTimeout(finish, WAIT_FOR_PAINT_TIMEOUT_MS);
        // Cancel the timer when finish() runs from the real signal —
        // we re-wrap finish to clear the timer first. Done here rather
        // than at declaration to keep the timer reference in scope.
        const realFinish = finish;
        const wrapped = () => {
          clearTimeout(safetyTimer);
          realFinish();
        };
        probeResolvers.current.set(nonce, wrapped);

        // Inject two-rAF probe. The inner rAF posts back after the
        // committed paint following this call. Stringifying the nonce
        // protects against accidental quote injection (we control
        // the nonce, but defense in depth is cheap).
        const script = `
          (function () {
            try {
              requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                  if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
                    window.ReactNativeWebView.postMessage(JSON.stringify({
                      kind: ${JSON.stringify(PAINT_MESSAGE_KIND)},
                      nonce: ${JSON.stringify(nonce)},
                    }));
                  }
                });
              });
            } catch (e) {
              // Ignore — safety timeout will drain the resolver.
            }
          })();
          true;
        `;
        webView.injectJavaScript(script);
      }),
  }));

  const onMessage = (e: WebViewMessageEvent) => {
    const raw = e.nativeEvent.data;
    // Fast-path: ignore anything that doesn't start with `{`. Most
    // postMessage traffic from dev-server pages won't be JSON shaped
    // exactly like ours and we don't want to JSON.parse arbitrary
    // strings on every message.
    if (typeof raw !== 'string' || raw.length === 0 || raw[0] !== '{') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isProbeMessage(parsed)) return;
    const resolver = probeResolvers.current.get(parsed.nonce);
    if (resolver) resolver();
  };

  return (
    <WebView
      ref={(w) => {
        webViewRef.current = w;
      }}
      source={{ uri: url }}
      style={{ flex: 1, backgroundColor }}
      startInLoadingState
      originWhitelist={['http://*', 'https://*']}
      onNavigationStateChange={(navState) => {
        if (navState.url) currentUrlRef.current = navState.url;
      }}
      onLoadEnd={() => {
        const queued = loadEndResolvers.current;
        loadEndResolvers.current = [];
        for (const fn of queued) fn();
      }}
      onMessage={onMessage}
    />
  );
});

function randomNonce(): string {
  // 16 hex chars from two Math.random() draws. Sufficient for in-
  // process uniqueness; not used for any security boundary.
  const head = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  const tail = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  return head + tail;
}

/** Re-exported so callers don't need to import the constant directly
 *  if they just want the magic-number-free cushion value. */
export { WEBVIEW_LOAD_CUSHION_MS };
