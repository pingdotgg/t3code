import type { OrchestrationEvent, PendingProviderTurn } from "@t3tools/contracts";

/** The same pending-state transitions drive durable and connected projections. */
export function pendingProviderTurnUpdate(
  event: OrchestrationEvent,
): PendingProviderTurn | null | undefined {
  switch (event.type) {
    case "thread.turn-queued":
      return event.payload.turn;
    case "thread.turn-start-requested":
      return null;
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
