/**
 * Timing constants for the preview-takeover state machine + controller.
 * Pulled out so the reducer + interpreter + indicator + tests can
 * reference one source of truth instead of sprinkling magic numbers.
 *
 * See `docs/sdd/2026-05-25-preview-takeover/`.
 */

/** Default time the controller stays in `active` after a successful
 *  capture, waiting to see if the agent chains another. Resets on every
 *  new request. */
export const TAKEOVER_DEBOUNCE_MS = 3_000;

/** Cross-fade duration on the `<TakeoverIndicator>` mount / unmount. */
export const INDICATOR_FADE_MS = 250;

/** Time the pager animation needs to finish before we capture. Matches
 *  the pager's `withTiming({ duration: 220 })` plus a small cushion. */
export const PAGER_SWAP_SETTLE_MS = 240;

/** Extra cushion after `onLoadEnd` before captureRef fires. iOS WKWebView
 *  occasionally returns blank pixels if the snapshot races a still-
 *  painting frame; this small wait dodges it cheaply. */
export const WEBVIEW_LOAD_CUSHION_MS = 50;

/** Upper bound on how long we wait for a path navigation to settle
 *  (onLoadEnd) before falling back to a fixed-wait capture. Matches the
 *  bridge-side `SCREENSHOT_WAIT_MS_CAP`. */
export const WEBVIEW_NAV_TIMEOUT_MS = 2_000;

/** Safety timeout on `PreviewFrameHandle.waitForPaint`. Page-script
 *  errors, CSP that blocks injectJavaScript, or a frozen content
 *  process all funnel through this: if the paint-complete signal
 *  doesn't come back in this window we capture anyway. */
export const WAIT_FOR_PAINT_TIMEOUT_MS = 1_500;

/** Safety timeout on `PreviewFrameHandle.waitForReady`. Matches the
 *  bridge-side `SCREENSHOT_WAIT_MS_CAP` so a hard-stuck page can't
 *  outlive the broker's request timeout. The agent's `waitMs`
 *  parameter overrides this on a per-call basis. */
export const WAIT_FOR_READY_TIMEOUT_MS = 15_000;

/** Namespace prefix on the `__rove_paint` postMessage signal so we
 *  don't collide with a dev-server page that uses
 *  `window.ReactNativeWebView.postMessage` for its own purposes. */
export const PAINT_MESSAGE_KIND = '__rove_paint';
/** Same convention for the broader ready-state probe (load event +
 *  rIC + paint commit). Distinct kind so the two probes don't
 *  cross-resolve each other. */
export const READY_MESSAGE_KIND = '__rove_ready';
