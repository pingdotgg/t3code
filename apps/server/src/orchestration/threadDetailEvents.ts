import type { OrchestrationEvent } from "@t3tools/contracts";

export function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.session-set"
      | "thread.queued-turn-created"
      | "thread.queued-turn-updated"
      | "thread.queued-turn-deleted"
      | "thread.queued-turn-dispatched"
      | "thread.queued-turn-failed";
  }
> {
  switch (event.type) {
    case "thread.message-sent":
    case "thread.proposed-plan-upserted":
    case "thread.activity-appended":
    case "thread.turn-diff-completed":
    case "thread.reverted":
    case "thread.session-set":
    case "thread.queued-turn-created":
    case "thread.queued-turn-updated":
    case "thread.queued-turn-deleted":
    case "thread.queued-turn-dispatched":
    case "thread.queued-turn-failed":
      return true;
    default:
      return false;
  }
}
