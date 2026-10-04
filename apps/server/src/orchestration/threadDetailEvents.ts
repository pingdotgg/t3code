import type { OrchestrationEvent } from "@t3tools/contracts";

export function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.review-result-set"
      | "thread.validation-requested"
      | "thread.validation-request-failed"
      | "thread.validation-run-planned"
      | "thread.validation-lifecycle-updated"
      | "thread.validation-lease-claimed"
      | "thread.validation-lease-released"
      | "thread.validation-result-recorded"
      | "thread.validation-gate-updated"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.child-lifecycle-notified"
      | "thread.cross-thread-send-recorded"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.session-set"
      | "thread.queued-turn-created"
      | "thread.queued-turn-updated"
      | "thread.queued-turn-deleted"
      | "thread.queued-turn-dispatched"
      | "thread.queued-turn-failed"
      | "thread.queued-turn-reordered"
      | "thread.queue-held"
      | "thread.queue-released";
  }
> {
  switch (event.type) {
    case "thread.message-sent":
    case "thread.review-result-set":
    case "thread.validation-requested":
    case "thread.validation-request-failed":
    case "thread.validation-run-planned":
    case "thread.validation-lifecycle-updated":
    case "thread.validation-lease-claimed":
    case "thread.validation-lease-released":
    case "thread.validation-result-recorded":
    case "thread.validation-gate-updated":
    case "thread.proposed-plan-upserted":
    case "thread.activity-appended":
    case "thread.child-lifecycle-notified":
    case "thread.cross-thread-send-recorded":
    case "thread.turn-diff-completed":
    case "thread.reverted":
    case "thread.session-set":
    case "thread.queued-turn-created":
    case "thread.queued-turn-updated":
    case "thread.queued-turn-deleted":
    case "thread.queued-turn-dispatched":
    case "thread.queued-turn-failed":
    case "thread.queued-turn-reordered":
    case "thread.queue-held":
    case "thread.queue-released":
      return true;
    default:
      return false;
  }
}
