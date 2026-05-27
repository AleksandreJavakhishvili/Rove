/**
 * Dispatch registry for the preview-handoff WS frames. Mirrors the
 * pattern in `screenshotBroker.ts` (`registerDispatch` / `getDispatch` /
 * `unregisterDispatch`) but for `prepare_preview_request` payloads.
 *
 * Kept in its own module so the screenshot + handoff dispatchers don't
 * have to share a generic-typed map — the two payload shapes are
 * different enough that the parallel modules are cleaner than a
 * polymorphic registry.
 */

interface HandoffDispatchArgs {
  requestId: string;
  instructions: string;
  suggestedPath?: string;
  timeoutSeconds?: number;
}

type HandoffDispatcher = (args: HandoffDispatchArgs) => void;

const dispatchers = new Map<string, HandoffDispatcher>();

export function registerHandoffDispatch(sessionId: string, dispatcher: HandoffDispatcher): void {
  dispatchers.set(sessionId, dispatcher);
}

export function unregisterHandoffDispatch(
  sessionId: string,
  dispatcher: HandoffDispatcher,
): void {
  // Idempotent + safe against a stale unmount racing past a fresh
  // reconnect — only clear if the entry still points at the dispatcher
  // we were given.
  if (dispatchers.get(sessionId) === dispatcher) {
    dispatchers.delete(sessionId);
  }
}

export function getHandoffDispatch(sessionId: string): HandoffDispatcher | undefined {
  return dispatchers.get(sessionId);
}
