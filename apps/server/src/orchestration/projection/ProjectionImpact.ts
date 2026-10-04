import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";

export interface ProjectionImpact {
  readonly shellThreadIds: ReadonlySet<ThreadId>;
  readonly attachmentThreadIds: ReadonlySet<ThreadId>;
}

export const emptyProjectionImpact = (): ProjectionImpact => ({
  shellThreadIds: new Set(),
  attachmentThreadIds: new Set(),
});

export function mergeProjectionImpact(
  target: ProjectionImpact,
  source: ProjectionImpact,
): ProjectionImpact {
  return {
    shellThreadIds: new Set([...target.shellThreadIds, ...source.shellThreadIds]),
    attachmentThreadIds: new Set([...target.attachmentThreadIds, ...source.attachmentThreadIds]),
  };
}

export function isActionableApprovalRequest(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const request = payload as Record<string, unknown>;
  return (
    request.requestKind === "command" ||
    request.requestKind === "file-read" ||
    request.requestKind === "file-change" ||
    request.requestType === "command_execution_approval" ||
    request.requestType === "exec_command_approval" ||
    request.requestType === "dynamic_tool_call" ||
    request.requestType === "file_read_approval" ||
    request.requestType === "file_change_approval" ||
    request.requestType === "apply_patch_approval"
  );
}

/**
 * Whether an appended activity can change the thread's shell row. Shared by
 * the reconciler (which decides what to refresh) and the shell stream (which
 * decides what to re-read): filtering in only one place either wastes work
 * or starves the sidebar, so both must agree on the predicate.
 */
export function activityChangesShellSummary(
  activity: Extract<
    OrchestrationEvent,
    { type: "thread.activity-appended" }
  >["payload"]["activity"],
): boolean {
  if (
    activity.kind === "approval.resolved" ||
    activity.kind === "user-input.requested" ||
    activity.kind === "user-input.resolved"
  ) {
    return true;
  }
  if (activity.kind === "approval.requested") {
    return isActionableApprovalRequest(activity.payload);
  }
  if (
    activity.kind !== "provider.approval.respond.failed" &&
    activity.kind !== "provider.user-input.respond.failed"
  ) {
    return false;
  }
  const payload =
    typeof activity.payload === "object" && activity.payload !== null
      ? (activity.payload as Record<string, unknown>)
      : null;
  const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : "";
  return activity.kind === "provider.approval.respond.failed"
    ? detail.includes("stale pending approval request") ||
        detail.includes("unknown pending approval request") ||
        detail.includes("unknown pending permission request")
    : detail.includes("stale pending user-input request") ||
        detail.includes("unknown pending user-input request");
}

export function projectionImpactForEvent(event: OrchestrationEvent): ProjectionImpact {
  const shellThreadIds = new Set<ThreadId>();
  const attachmentThreadIds = new Set<ThreadId>();

  switch (event.type) {
    case "thread.activity-appended":
      if (activityChangesShellSummary(event.payload.activity)) {
        shellThreadIds.add(event.payload.threadId);
      }
      break;
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
    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
    case "thread.queued-turn-created":
    case "thread.queued-turn-updated":
    case "thread.queued-turn-deleted":
    case "thread.queued-turn-dispatched":
    case "thread.queued-turn-failed":
    case "thread.queued-turn-reordered":
    case "thread.queue-held":
    case "thread.queue-released":
    case "thread.session-set":
    case "thread.turn-diff-completed":
      shellThreadIds.add(event.payload.threadId);
      break;
    case "thread.reverted":
      shellThreadIds.add(event.payload.threadId);
      attachmentThreadIds.add(event.payload.threadId);
      break;
    case "thread.deleted":
      attachmentThreadIds.add(event.payload.threadId);
      break;
    default:
      break;
  }

  return { shellThreadIds, attachmentThreadIds };
}
