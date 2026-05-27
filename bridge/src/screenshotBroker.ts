import { randomUUID } from 'node:crypto';
import {
  SCREENSHOT_ERROR_REASON,
  SCREENSHOT_REQUEST_TIMEOUT_MS,
  SCREENSHOT_WAIT_MS_CAP,
  type ScreenshotErrorReason,
} from './agents/types.ts';

/**
 * Bridge ↔ mobile screenshot round-trip arbiter for Phase 2 of the
 * visual-feedback-loop SDD.
 *
 * Flow:
 *   1. The `take_screenshot` MCP tool calls `requestScreenshot()`.
 *   2. The broker allocates a fresh `requestId`, registers a Promise,
 *      arms a timeout, and invokes the supplied `dispatch` callback so
 *      the WS handler can send the `request_screenshot` frame to the
 *      attached mobile client.
 *   3. The phone replies with `screenshot_result`; the WS handler routes
 *      the payload to `resolveScreenshot(requestId, …)`.
 *   4. The Promise resolves, the tool returns the upload to the SDK.
 *   5. If the phone never replies, the timeout fires and the Promise
 *      resolves with a `timeout` outcome — never a rejection.
 *
 * The broker is process-global so the SDK driver, the WS handler, and
 * disconnect cleanup all coordinate through one map.
 */

export type ScreenshotOutcome =
  | {
      ok: true;
      requestId: string;
      uploadId: string;
      /** Preview-takeover Phase 2 — phone's best-effort current URL
       *  after capture. Surfaced to the agent as a `resolved_url:` text
       *  block alongside the image so redirects (auth, 404) are
       *  observable without parsing pixels. */
      resolvedUrl?: string;
    }
  | { ok: false; requestId: string; reason: ScreenshotErrorReason };

interface RequestOptions {
  path?: string;
  waitMs?: number;
  /** Hard ceiling on the bridge↔phone↔bridge round-trip. */
  timeoutMs?: number;
}

interface DispatchArgs {
  requestId: string;
  path?: string;
  waitMs?: number;
}

type Dispatch = (args: DispatchArgs) => void;

interface PendingEntry {
  sessionId: string;
  resolve: (outcome: ScreenshotOutcome) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingEntry>();


/**
 * Allocate a request, hand it off to the WS handler, and return a
 * Promise that resolves when the phone replies (or the timeout fires,
 * or the session disconnects). Never rejects — all error paths resolve
 * with `ok: false` so the MCP tool wrapper can convert directly to a
 * text content block.
 *
 * `dispatch` should not throw; if it does, we resolve immediately with
 * `no_client` so the caller doesn't hang.
 */
export function requestScreenshot(
  sessionId: string,
  options: RequestOptions,
  dispatch: Dispatch,
): Promise<ScreenshotOutcome> {
  const requestId = randomUUID();
  const waitMs = clampWaitMs(options.waitMs);
  const timeoutMs = options.timeoutMs ?? SCREENSHOT_REQUEST_TIMEOUT_MS;
  return new Promise<ScreenshotOutcome>((resolve) => {
    const timer = setTimeout(() => {
      const entry = pending.get(requestId);
      if (!entry) return;
      pending.delete(requestId);
      resolve({ ok: false, requestId, reason: SCREENSHOT_ERROR_REASON.timeout });
    }, timeoutMs);
    // `unref()` so a stuck request doesn't keep the bridge process alive
    // past its other shutdown signals.
    timer.unref?.();
    pending.set(requestId, { sessionId, resolve, timer });
    try {
      dispatch({ requestId, path: options.path, waitMs });
    } catch (err) {
      // Couldn't even send the request — usually means the WS isn't
      // attached. Resolve immediately with `no_client` and clean up.
      const entry = pending.get(requestId);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(requestId);
      }
      console.warn('[screenshot-broker] dispatch threw', err);
      resolve({ ok: false, requestId, reason: SCREENSHOT_ERROR_REASON.no_client });
    }
  });
}

/**
 * Route a `screenshot_result` frame from the phone to the in-flight
 * Promise. Unknown / late `requestId`s are dropped silently — they
 * represent timed-out or duplicate replies and don't matter.
 */
export function resolveScreenshot(
  requestId: string,
  payload:
    | { ok: true; uploadId: string; resolvedUrl?: string }
    | { ok: false; reason: ScreenshotErrorReason },
): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  clearTimeout(entry.timer);
  if (payload.ok) {
    entry.resolve({
      ok: true,
      requestId,
      uploadId: payload.uploadId,
      ...(payload.resolvedUrl !== undefined ? { resolvedUrl: payload.resolvedUrl } : {}),
    });
  } else {
    entry.resolve({ ok: false, requestId, reason: payload.reason });
  }
}

/**
 * Drain every pending request for a session with the given reason.
 * Call on WS disconnect / session teardown so the SDK doesn't hang
 * waiting on a phone that's no longer there.
 */
export function cancelPendingForSession(sessionId: string, reason: ScreenshotErrorReason): void {
  for (const [requestId, entry] of pending) {
    if (entry.sessionId !== sessionId) continue;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve({ ok: false, requestId, reason });
  }
}

/** Used by tests / debug surfaces. */
export function pendingCount(): number {
  return pending.size;
}

/** -------------------------------------------------------------------
 *  Dispatch registry — populated by the WS handler when a session WS
 *  is attached. The SDK tool calls `getDispatch(sessionId)` to find
 *  the right socket to push the `request_screenshot` frame onto. A
 *  session with no attached client gets a `no_client` outcome before
 *  the broker even creates a pending entry.
 *  ------------------------------------------------------------------ */

type Dispatcher = (args: DispatchArgs) => void;

const dispatchers = new Map<string, Dispatcher>();

export function registerDispatch(sessionId: string, dispatcher: Dispatcher): void {
  dispatchers.set(sessionId, dispatcher);
}

export function unregisterDispatch(sessionId: string, dispatcher: Dispatcher): void {
  // Idempotent + double-unregister-safe — only clear if the entry still
  // points at the dispatcher we were given. Prevents a stale unmount
  // racing past a fresh reconnect.
  if (dispatchers.get(sessionId) === dispatcher) {
    dispatchers.delete(sessionId);
  }
}

export function getDispatch(sessionId: string): Dispatcher | undefined {
  return dispatchers.get(sessionId);
}

/** -------------------------------------------------------------------
 *  Per-session allow toggle. Defaults to `true` — the canUseTool
 *  permission prompt is the *real* security gate. This toggle is the
 *  user's quick kill switch from the chat header menu so they can
 *  disable autonomous captures without revoking the always-allow rule.
 *  ------------------------------------------------------------------ */

const allowToggles = new Map<string, boolean>();

export function isScreenshotAllowed(sessionId: string): boolean {
  return allowToggles.get(sessionId) ?? true;
}

export function setScreenshotAllowed(sessionId: string, allow: boolean): void {
  allowToggles.set(sessionId, allow);
}

export function clearScreenshotState(sessionId: string): void {
  allowToggles.delete(sessionId);
  visualFeedbackEnabled.delete(sessionId);
}

/** -------------------------------------------------------------------
 *  Per-session mirror of the mobile client's global
 *  `enableVisualFeedback` setting. Default `false` — matches the
 *  mobile-side default, so a session with no client attached (or a
 *  client that hasn't sent its mirror frame yet) short-circuits cleanly.
 *  Preview-takeover Phase 0.
 *  ------------------------------------------------------------------ */

const visualFeedbackEnabled = new Map<string, boolean>();

export function isVisualFeedbackEnabled(sessionId: string): boolean {
  return visualFeedbackEnabled.get(sessionId) ?? false;
}

export function setVisualFeedbackEnabled(sessionId: string, enabled: boolean): void {
  visualFeedbackEnabled.set(sessionId, enabled);
}

function clampWaitMs(input: number | undefined): number | undefined {
  if (input === undefined) return undefined;
  if (!Number.isFinite(input)) return 0;
  return Math.max(0, Math.min(SCREENSHOT_WAIT_MS_CAP, Math.floor(input)));
}
