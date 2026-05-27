import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { Keyboard } from 'react-native';
import {
  ScreenshotCaptureError,
  type useScreenshotCapture,
} from '@/hooks/useScreenshotCapture';
import { SCREENSHOT_ERROR_REASON, type ClientToServer } from '@/lib/types';
import type { ChatPreviewPagerHandle } from '@/components/chat/ChatPreviewPager';
import type { WorkspacePaneHandle } from '@/components/WorkspacePane';
import type { PreviewFrameHandle } from '@/components/chat/PreviewFrame';
import {
  PAGER_SWAP_SETTLE_MS,
  TAKEOVER_DEBOUNCE_MS,
} from './constants';
import { validatePreviewPath } from './pathValidator';
import {
  reduce,
  type Direction,
  type PreviewDirectionEffect,
  type PreviewDirectionEvent,
  type PreviewDirectionState,
  type PriorState,
} from './previewDirectionMachine';

const CHAT_PAGER_INDEX = 0;
const PREVIEW_PAGER_INDEX = 1;

/**
 * Input the controller hands to the hook. The hook owns all refs +
 * timers + effect interpretation; the controller is just a thin
 * subscribe-to-WS-frames wrapper.
 */
export interface UseTakeoverInputs {
  pagerRef: React.RefObject<ChatPreviewPagerHandle | null>;
  workspaceRef: React.RefObject<WorkspacePaneHandle | null>;
  previewFrameRef: React.RefObject<PreviewFrameHandle | null>;
  screenshot: ReturnType<typeof useScreenshotCapture>;
  sendFrame: (msg: ClientToServer) => void;
}

export interface UseTakeoverApi {
  state: PreviewDirectionState;
  /** Dispatched by the controller when a `request_screenshot` WS frame
   *  arrives. The hook snapshots the current chrome before forwarding
   *  to the reducer. */
  requestScreenshot: (args: {
    direction: Direction;
    requestId: string;
    path?: string;
    waitMs?: number;
  }) => void;
  /** Dispatched when a `prepare_preview_request` WS frame arrives. */
  requestHandoff: (args: {
    requestId: string;
    instructions: string;
    suggestedPath?: string;
    timeoutSeconds?: number;
  }) => void;
  /** Wired to the Cancel button on the takeover indicator. */
  cancelTapped: () => void;
  /** Wired to "Open Preview" on the HandoffSheet. */
  openPreviewTapped: () => void;
  /** Wired to "Done" on the HandoffPill. */
  doneTapped: (args?: { finalUrl?: string }) => void;
  /** Wired to "Skip" on the HandoffSheet. */
  skipTapped: (args?: { note?: string }) => void;
  /** Called when the WS subscription tears down (chat unmount, app
   *  background, etc.). Cleans up timers but doesn't restore chrome —
   *  the screen is being torn down anyway. */
  wsClosed: () => void;
}

interface ReducerState {
  state: PreviewDirectionState;
}

type ReducerEvent = PreviewDirectionEvent;

interface ReducerOutput {
  state: ReducerState;
  effects: PreviewDirectionEffect[];
}

function reducerStep(
  state: ReducerState,
  event: ReducerEvent,
): ReducerOutput {
  const out = reduce(state.state, event);
  return { state: { state: out.state }, effects: out.effects };
}

/**
 * React hook that wraps the pure `previewDirectionMachine` reducer and
 * interprets every effect descriptor it produces. Owns the debounce
 * timer, the snapshot of prior chrome, and the ref-driven side effects.
 *
 * The hook deliberately doesn't subscribe to WS frames itself — that's
 * the controller's job. Keeping subscription out of the hook means a
 * test (when we add one with @testing-library) can drive `dispatch`
 * directly.
 */
export function useTakeover(inputs: UseTakeoverInputs): UseTakeoverApi {
  const { pagerRef, workspaceRef, previewFrameRef, screenshot, sendFrame } = inputs;

  // useReducer would be the natural fit but we need to run the effects
  // returned alongside the next state — vanilla useReducer doesn't
  // expose that handoff. Roll a small dispatch wrapper that tracks
  // both halves and runs effects via useEffect-style flushing.
  const [composite, dispatchRaw] = useReducer(
    (acc: ReducerOutput, event: ReducerEvent) => reducerStep(acc.state, event),
    { state: { state: { kind: 'idle' } }, effects: [] },
  );

  // Refs the interpreter reads — kept in refs so the dispatch callback
  // is stable and doesn't re-create on every state change.
  const stateRef = useRef<PreviewDirectionState>({ kind: 'idle' });
  stateRef.current = composite.state.state;

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Handoff-side mirror of the bridge's user-reply timeout. Armed on
   *  `arm_handoff_timeout`; cleared on every user action. */
  const handoffTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** requestIds the user has explicitly cancelled. The capture
   *  interpreter checks this before sending `screenshot_result` so a
   *  stale capture from a cancelled burst doesn't double-resolve. */
  const cancelledRequestsRef = useRef<Set<string>>(new Set());

  const dispatch = useCallback((event: ReducerEvent) => {
    dispatchRaw(event);
  }, []);

  const clearDebounce = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const armDebounce = useCallback(() => {
    clearDebounce();
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      dispatch({ kind: 'debounce_expired' });
    }, TAKEOVER_DEBOUNCE_MS);
  }, [clearDebounce, dispatch]);

  const clearHandoffTimeout = useCallback(() => {
    if (handoffTimeoutRef.current) {
      clearTimeout(handoffTimeoutRef.current);
      handoffTimeoutRef.current = null;
    }
  }, []);

  const armHandoffTimeout = useCallback(
    (timeoutSeconds?: number) => {
      clearHandoffTimeout();
      if (!timeoutSeconds || timeoutSeconds <= 0) return;
      handoffTimeoutRef.current = setTimeout(() => {
        handoffTimeoutRef.current = null;
        dispatch({ kind: 'timeout_fired' });
      }, timeoutSeconds * 1000);
    },
    [clearHandoffTimeout, dispatch],
  );

  // Effect interpreter. Walks every effect descriptor produced by the
  // most recent reducer step and translates each into the matching
  // imperative call. Effects must be processed in order (e.g. the
  // chained-request path emits cancel_in_flight → clear_debounce →
  // capture — we want the cancel before the new capture so any in-
  // flight reply for the prior id is suppressed).
  useEffect(() => {
    if (composite.effects.length === 0) return;
    for (const effect of composite.effects) {
      runEffect(effect);
    }
    // Run-once per dispatch — composite is a fresh reference per step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composite]);

  function runEffect(effect: PreviewDirectionEffect): void {
    switch (effect.kind) {
      case 'engage': {
        // Dismiss any open keyboard so the indicator + Preview pane
        // are unobstructed during capture. Cheap no-op when no input
        // has focus.
        Keyboard.dismiss();
        // Force preview tab + lock pan + lock segment toggle.
        workspaceRef.current?.setMode('preview');
        workspaceRef.current?.setLocked(true);
        pagerRef.current?.setLocked(true);
        pagerRef.current?.setIndex(PREVIEW_PAGER_INDEX);
        // For user-direction engagements with a suggestedPath, the
        // user expects the WebView to land on that path so they can
        // start their setup work. Run the navigation in parallel with
        // the pager animation so the WebView is at the right URL by
        // the time the user sees Preview.
        if (effect.suggestedPath !== undefined) {
          const validation = validatePreviewPath(effect.suggestedPath);
          if (validation.ok && validation.path !== '') {
            const previewFrame = previewFrameRef.current;
            if (previewFrame) {
              const current = previewFrame.currentUrl();
              let target = validation.path;
              if (current) {
                try {
                  target = new URL(validation.path, current).toString();
                } catch {
                  // ignore — fall through to relative assign
                }
              }
              void previewFrame.navigate(target);
            }
          }
        }
        // After the pager swap animation settles, transition to active.
        setTimeout(() => dispatch({ kind: 'engaged' }), PAGER_SWAP_SETTLE_MS);
        return;
      }
      case 'capture': {
        void runCapture(effect);
        return;
      }
      case 'cancel_in_flight': {
        cancelledRequestsRef.current.add(effect.requestId);
        return;
      }
      case 'arm_debounce': {
        armDebounce();
        return;
      }
      case 'clear_debounce': {
        clearDebounce();
        return;
      }
      case 'restore': {
        // The reducer already advanced state to `exiting`. Drive the
        // pager + workspace back to the snapshot, then fire
        // exit_complete so the reducer lands in idle. When a grace
        // window is requested (handoff → screenshot bridge), hold
        // the chrome state for that long so a follow-up
        // `take_screenshot` can re-enter without flicker.
        const snap: PriorState = effect.snapshot;
        const exitDelay =
          effect.gracePeriodMs !== undefined && effect.gracePeriodMs > 0
            ? effect.gracePeriodMs
            : PAGER_SWAP_SETTLE_MS;
        // Restore the pager + workspace AFTER the grace window so a
        // chain-into-screenshot keeps the WebView visible the whole
        // time. (The screenshot reducer will issue its own engage
        // before this restore lands if it arrives in time.)
        setTimeout(() => {
          // If the reducer has already moved past `exiting` (a new
          // request came in), don't undo the new state's chrome.
          if (stateRef.current.kind !== 'exiting') {
            dispatch({ kind: 'exit_complete' });
            return;
          }
          workspaceRef.current?.setLocked(false);
          workspaceRef.current?.setMode(snap.workspaceMode);
          pagerRef.current?.setLocked(false);
          pagerRef.current?.setIndex(snap.pagerIndex);
          setTimeout(() => dispatch({ kind: 'exit_complete' }), PAGER_SWAP_SETTLE_MS);
        }, exitDelay);
        return;
      }
      case 'reply_denied': {
        sendFrame({
          type: 'screenshot_result',
          requestId: effect.requestId,
          ok: false,
          reason: SCREENSHOT_ERROR_REASON.permission_denied,
        });
        return;
      }
      case 'reply_cancelled': {
        cancelledRequestsRef.current.add(effect.requestId);
        sendFrame({
          type: 'screenshot_result',
          requestId: effect.requestId,
          ok: false,
          reason: SCREENSHOT_ERROR_REASON.cancelled,
        });
        return;
      }
      case 'show_handoff_modal': {
        // Dismiss the keyboard so the sheet animates over a clean
        // chat list. Otherwise iOS leaves the keyboard up and the
        // sheet ends up squashed above it.
        Keyboard.dismiss();
        // The rest is pure presentation — `state.kind === 'modal'`
        // tells the controller to mount <HandoffSheet>.
        return;
      }
      case 'morph_to_pill': {
        // Sheet → pill cross-fade is animation-only; <HandoffSheet>
        // unmounts when `state.kind` flips away from 'modal'.
        return;
      }
      case 'reply_handoff': {
        sendFrame({
          type: 'prepare_preview_result',
          requestId: effect.requestId,
          status: effect.status,
          ...(effect.finalUrl !== undefined ? { finalUrl: effect.finalUrl } : {}),
          ...(effect.note !== undefined ? { note: effect.note } : {}),
        });
        return;
      }
      case 'arm_handoff_timeout': {
        armHandoffTimeout(effect.timeoutSeconds);
        return;
      }
      case 'clear_handoff_timeout': {
        clearHandoffTimeout();
        return;
      }
    }
  }

  async function runCapture(effect: {
    requestId: string;
    path?: string;
    waitMs?: number;
  }): Promise<void> {
    const { requestId } = effect;

    // Validate the path before doing anything else — invalid paths
    // skip navigation entirely and reply `capture_failed` so the
    // agent gets a structured reason it can pattern-match on.
    const validation = validatePreviewPath(effect.path);
    if (!validation.ok) {
      sendFrame({
        type: 'screenshot_result',
        requestId,
        ok: false,
        reason: SCREENSHOT_ERROR_REASON.capture_failed,
      });
      // Treat as a finished attempt so the debounce-exit timer arms
      // and the burst tidies itself up.
      dispatch({ kind: 'capture_complete' });
      return;
    }

    try {
      const targetPath = validation.path;
      const previewFrame = previewFrameRef.current;
      if (targetPath !== '' && previewFrame) {
        // Resolve `/foo` against the WebView's current origin. We can't
        // ask the WebView what its origin is synchronously, so derive
        // from `currentUrl()` (the URL it last reported). Falls back
        // to passing the path literally — react-native-webview's
        // location.assign call will resolve it as a relative URL even
        // without an explicit origin.
        const current = previewFrame.currentUrl();
        let target = targetPath;
        if (current) {
          try {
            const u = new URL(targetPath, current);
            target = u.toString();
          } catch {
            // ignore — fall through to relative assign
          }
        }
        await previewFrame.navigate(target);
      }
      // Wait for the page to be visually ready — `document.readyState
      // === 'complete'` + browser idle + paint commit. The agent's
      // `waitMs` parameter becomes the *cap* (max time to wait); a
      // fast page resolves earlier. This replaces the old "sleep
      // waitMs then capture" behavior, which captured loading
      // spinners on slow dev servers.
      if (previewFrame) {
        await previewFrame.waitForReady(effect.waitMs);
      } else if (effect.waitMs && effect.waitMs > 0) {
        // Edge case — no PreviewFrame ref (no dev server detected).
        // Fall back to a fixed sleep so the agent's waitMs still
        // gets honored. captureRef will then fall back to the
        // wrapper-View capture, which is what we want here.
        await new Promise<void>((r) => setTimeout(r, effect.waitMs));
      }
      const { upload } = await screenshot.captureAndUpload();
      // If the user (or a chained request) cancelled this requestId
      // while we were capturing, drop the reply on the floor so we
      // don't override the cancel reply.
      if (cancelledRequestsRef.current.has(requestId)) {
        cancelledRequestsRef.current.delete(requestId);
        return;
      }
      // Phase 2 — echo the WebView's final URL so the agent can spot
      // redirects (auth, 404) without parsing the screenshot.
      const resolvedUrl = previewFrameRef.current?.currentUrl();
      sendFrame({
        type: 'screenshot_result',
        requestId,
        ok: true,
        uploadId: upload.path,
        ...(resolvedUrl !== undefined ? { resolvedUrl } : {}),
      });
      dispatch({ kind: 'capture_complete' });
    } catch (err) {
      if (cancelledRequestsRef.current.has(requestId)) {
        cancelledRequestsRef.current.delete(requestId);
        return;
      }
      const reason =
        err instanceof ScreenshotCaptureError
          ? err.reason
          : SCREENSHOT_ERROR_REASON.capture_failed;
      sendFrame({
        type: 'screenshot_result',
        requestId,
        ok: false,
        reason,
      });
      // Treat a failed capture the same way as a successful one for the
      // purposes of arming the debounce timer — we want the burst to
      // exit cleanly even if the photo never lands.
      dispatch({ kind: 'capture_complete' });
    }
  }

  // Public dispatch wrappers — keep the reducer types out of the
  // controller's vocabulary.
  const requestScreenshot = useCallback<UseTakeoverApi['requestScreenshot']>(
    ({ direction, requestId, path, waitMs }) => {
      const snapshot: PriorState = {
        pagerIndex: pagerRef.current?.getIndex() ?? CHAT_PAGER_INDEX,
        workspaceMode: workspaceRef.current?.getMode() ?? 'files',
      };
      dispatch({
        kind: 'request',
        direction,
        requestId,
        snapshot,
        ...(path !== undefined ? { path } : {}),
        ...(waitMs !== undefined ? { waitMs } : {}),
      });
      // canUseTool runs in the bridge as a separate gate; for the
      // agent-direction path we treat receipt of the WS frame as
      // implicit permission_granted (the user already approved the
      // tool via the ApprovalSheet that fired before the bridge sent
      // the frame). Fire the granted event immediately so the reducer
      // advances to `engaging`.
      dispatch({ kind: 'permission_granted' });
    },
    [dispatch, pagerRef, workspaceRef],
  );

  const cancelTapped = useCallback(() => {
    dispatch({ kind: 'cancel_tapped' });
  }, [dispatch]);

  const requestHandoff = useCallback<UseTakeoverApi['requestHandoff']>(
    ({ requestId, instructions, suggestedPath, timeoutSeconds }) => {
      const snapshot: PriorState = {
        pagerIndex: pagerRef.current?.getIndex() ?? CHAT_PAGER_INDEX,
        workspaceMode: workspaceRef.current?.getMode() ?? 'files',
      };
      dispatch({
        kind: 'handoff_request',
        requestId,
        snapshot,
        handoff: {
          instructions,
          ...(suggestedPath !== undefined ? { suggestedPath } : {}),
          ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
        },
      });
    },
    [dispatch, pagerRef, workspaceRef],
  );

  const openPreviewTapped = useCallback(() => {
    dispatch({ kind: 'open_preview_tapped' });
  }, [dispatch]);

  const doneTapped = useCallback<UseTakeoverApi['doneTapped']>(
    (args) => {
      // Best-effort final URL — read the WebView ref at the moment
      // the user taps Done. The agent can use this to confirm the
      // user really did navigate to the requested route.
      const finalUrl = args?.finalUrl ?? previewFrameRef.current?.currentUrl();
      dispatch({
        kind: 'done_tapped',
        ...(finalUrl !== undefined ? { finalUrl } : {}),
      });
    },
    [dispatch, previewFrameRef],
  );

  const skipTapped = useCallback<UseTakeoverApi['skipTapped']>(
    (args) => {
      dispatch({
        kind: 'skip_tapped',
        ...(args?.note !== undefined ? { note: args.note } : {}),
      });
    },
    [dispatch],
  );

  const wsClosed = useCallback(() => {
    clearDebounce();
    clearHandoffTimeout();
    cancelledRequestsRef.current.clear();
    dispatch({ kind: 'ws_closed' });
  }, [clearDebounce, clearHandoffTimeout, dispatch]);

  // Clean up the timers on unmount even if no explicit teardown fired.
  useEffect(
    () => () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (handoffTimeoutRef.current) clearTimeout(handoffTimeoutRef.current);
    },
    [],
  );

  return useMemo<UseTakeoverApi>(
    () => ({
      state: composite.state.state,
      requestScreenshot,
      requestHandoff,
      cancelTapped,
      openPreviewTapped,
      doneTapped,
      skipTapped,
      wsClosed,
    }),
    [
      composite.state.state,
      requestScreenshot,
      requestHandoff,
      cancelTapped,
      openPreviewTapped,
      doneTapped,
      skipTapped,
      wsClosed,
    ],
  );
}
