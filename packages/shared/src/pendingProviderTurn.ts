import type {
  OrchestrationEvent,
  PendingProviderTurn,
  PendingProviderTurnSummary,
} from "@t3tools/contracts";

/** The same pending-state transitions drive durable and connected projections. */
export function pendingProviderTurnUpdate(
  event: OrchestrationEvent,
): PendingProviderTurn | null | undefined {
  switch (event.type) {
    case "thread.turn-queued":
      return event.payload.turn;
    case "thread.turn-start-requested":
      return event.payload.providerAvailabilityWait === true ? undefined : null;
    case "thread.session-set":
      // Only a session coming alive adopts the queued turn. "stopped" is a
      // consequence, not an intent: an idle provider exit or a crashed process
      // reports it, and clearing here would silently discard the saved prompt
      // (and prune its attachments) while the user still expects it to run.
      // Explicit stops clear through thread.session-stop-requested instead.
      return event.payload.session.status === "starting" ||
        event.payload.session.status === "running"
        ? null
        : undefined;
    case "thread.turn-interrupt-requested":
    case "thread.session-stop-requested":
    case "thread.archived":
    case "thread.deleted":
    case "thread.settled":
    case "thread.reverted":
      return null;
    default:
      return undefined;
  }
}

/** Shells carry only the wait's marker fields; the full prompt snapshot lives on the detail thread. */
export function pendingProviderTurnSummary(
  turn: PendingProviderTurn | null | undefined,
): PendingProviderTurnSummary | null {
  return turn == null ? null : { messageId: turn.message.messageId, createdAt: turn.createdAt };
}
