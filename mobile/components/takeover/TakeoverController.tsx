import { useEffect } from 'react';
import type { ClientToServer, ServerToClient } from '@/lib/types';
import type { ChatPreviewPagerHandle } from '@/components/chat/ChatPreviewPager';
import type { WorkspacePaneHandle } from '@/components/WorkspacePane';
import type { PreviewFrameHandle } from '@/components/chat/PreviewFrame';
import { HandoffPill } from '@/components/handoff/HandoffPill';
import { HandoffSheet } from '@/components/handoff/HandoffSheet';
import { useScreenshotCapture } from '@/hooks/useScreenshotCapture';
import { TakeoverIndicator } from './TakeoverIndicator';
import { useTakeover, type UseTakeoverInputs } from './useTakeover';

/**
 * Predicate the chat screen's WS message switch hands to the
 * controller. Returns true when the frame was consumed by the
 * controller (so the switch should `break` without further routing).
 */
export interface TakeoverFrameHandler {
  (msg: ServerToClient): boolean;
}

interface Props {
  pagerRef: UseTakeoverInputs['pagerRef'];
  workspaceRef: UseTakeoverInputs['workspaceRef'];
  previewFrameRef: UseTakeoverInputs['previewFrameRef'];
  screenshot: ReturnType<typeof useScreenshotCapture>;
  sendFrame: (msg: ClientToServer) => void;
  /** Returns the controller's frame consumer to the parent so the WS
   *  switch can forward `request_screenshot` (and, in the handoff SDD,
   *  `prepare_preview_request`) to the state machine. */
  registerFrameHandler: (handler: TakeoverFrameHandler) => void;
  /** Fires whenever the controller decides whether the manual shutter
   *  should be disabled — true during a user-direction handoff so a
   *  manual capture doesn't race the agent's request. The chat screen
   *  forwards this into `<PreviewShutter disabled={...} />`. */
  onManualShutterAvailability?: (disabled: boolean) => void;
}

/**
 * Orchestrator the chat screen mounts. Subscribes to WS frames via
 * the parent (`registerFrameHandler`) and drives the takeover state
 * machine in `useTakeover`. Renders the `<TakeoverIndicator>` whenever
 * the mode is non-idle.
 *
 * Doesn't touch the WS itself — the chat screen's existing
 * `openStream(...)` call owns the socket; the controller is just a
 * subscriber.
 */
export function TakeoverController({
  pagerRef,
  workspaceRef,
  previewFrameRef,
  screenshot,
  sendFrame,
  registerFrameHandler,
  onManualShutterAvailability,
}: Props) {
  const takeover = useTakeover({
    pagerRef,
    workspaceRef,
    previewFrameRef,
    screenshot,
    sendFrame,
  });

  useEffect(() => {
    const handler: TakeoverFrameHandler = (msg) => {
      if (msg.type === 'request_screenshot') {
        takeover.requestScreenshot({
          direction: 'agent',
          requestId: msg.requestId,
          ...(msg.path !== undefined ? { path: msg.path } : {}),
          ...(msg.waitMs !== undefined ? { waitMs: msg.waitMs } : {}),
        });
        return true;
      }
      if (msg.type === 'prepare_preview_request') {
        takeover.requestHandoff({
          requestId: msg.requestId,
          instructions: msg.instructions,
          ...(msg.suggestedPath !== undefined ? { suggestedPath: msg.suggestedPath } : {}),
          ...(msg.timeoutSeconds !== undefined ? { timeoutSeconds: msg.timeoutSeconds } : {}),
        });
        return true;
      }
      return false;
    };
    registerFrameHandler(handler);
    return () => {
      // Clear the handler on unmount so the chat screen doesn't try
      // calling into a stale closure.
      registerFrameHandler(() => false);
    };
  }, [registerFrameHandler, takeover]);

  // Tear down the state machine + timers if the chat screen unmounts
  // with a non-idle state (e.g. user navigated away mid-burst).
  useEffect(
    () => () => {
      takeover.wsClosed();
    },
    // Only on full unmount; intentionally don't depend on `takeover`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const { state } = takeover;

  // Manual-shutter coordination — disable the floating shutter while
  // a user-direction handoff is on screen so a tap doesn't race the
  // agent's request.
  const shutterDisabled =
    state.kind !== 'idle' &&
    state.kind !== 'exiting' &&
    state.kind !== 'requesting' &&
    state.direction === 'user';
  useEffect(() => {
    onManualShutterAvailability?.(shutterDisabled);
  }, [shutterDisabled, onManualShutterAvailability]);

  // Agent-direction indicator pill — same as Phase 1. We display the
  // pill whenever we're in a non-idle agent-direction state. `modal`
  // / user-direction states are handled by the HandoffSheet /
  // HandoffPill below.
  const agentVisible =
    state.kind === 'requesting' ||
    ((state.kind === 'engaging' ||
      state.kind === 'active' ||
      state.kind === 'exiting') &&
      state.direction === 'agent');
  const agentLabel =
    state.kind === 'exiting' || state.kind === 'idle' ? 'Done' : 'Verifying';
  const agentDetail =
    state.kind === 'requesting' || state.kind === 'engaging' || state.kind === 'active'
      ? state.path ?? 'current view'
      : undefined;
  const agentOnCancel =
    (state.kind === 'engaging' || state.kind === 'active') && state.direction === 'agent'
      ? () => takeover.cancelTapped()
      : null;

  // User-direction sheet / pill.
  const showSheet = state.kind === 'modal';
  const showPill =
    (state.kind === 'engaging' || state.kind === 'active') && state.direction === 'user';
  const handoffInstructions =
    state.kind === 'modal'
      ? state.handoff.instructions
      : (state.kind === 'engaging' || state.kind === 'active') && state.handoff
        ? state.handoff.instructions
        : '';
  const handoffSuggestedPath =
    state.kind === 'modal' ? state.handoff.suggestedPath : undefined;

  return (
    <>
      <TakeoverIndicator
        visible={agentVisible}
        label={agentLabel}
        {...(agentDetail !== undefined ? { detail: agentDetail } : {})}
        onCancel={agentOnCancel}
      />
      <HandoffSheet
        visible={showSheet}
        instructions={handoffInstructions}
        {...(handoffSuggestedPath !== undefined
          ? { suggestedPath: handoffSuggestedPath }
          : {})}
        onOpenPreview={() => takeover.openPreviewTapped()}
        onSkip={(args) => takeover.skipTapped(args)}
        onCancel={() => takeover.cancelTapped()}
      />
      <HandoffPill
        visible={showPill}
        instructions={handoffInstructions}
        onDone={() => takeover.doneTapped()}
        onCancel={() => takeover.cancelTapped()}
      />
    </>
  );
}
