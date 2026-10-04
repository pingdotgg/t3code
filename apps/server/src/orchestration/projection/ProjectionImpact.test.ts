import {
  EventId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationEventType,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { isActionableApprovalRequest, projectionImpactForEvent } from "./ProjectionImpact.ts";

const threadId = ThreadId.make("thread-impact");
const now = "2026-08-24T22:00:00.000Z";

const event = (
  type: OrchestrationEventType,
  payload: Record<string, unknown> = { threadId },
): OrchestrationEvent => ({ type, payload }) as OrchestrationEvent;

const activityEvent = (kind: string, payload: unknown = {}) =>
  event("thread.activity-appended", {
    threadId,
    activity: {
      id: EventId.make(`activity-${kind}`),
      tone: "info",
      kind,
      summary: kind,
      payload,
      turnId: null,
      createdAt: now,
    },
  });

describe("projectionImpactForEvent", () => {
  it.each([
    ["thread.message-sent", event("thread.message-sent", { threadId, role: "user" }), false, false],
    ["thread.review-result-set", event("thread.review-result-set"), true, false],
    ["thread.proposed-plan-upserted", event("thread.proposed-plan-upserted"), true, false],
    [
      "thread.approval-response-requested",
      event("thread.approval-response-requested"),
      true,
      false,
    ],
    [
      "thread.user-input-response-requested",
      event("thread.user-input-response-requested"),
      true,
      false,
    ],
    // Queue presence is read directly from committed queue rows; none of the
    // reconciled approval/input/plan/message summary fields change here.
    ["thread.queued-turn-created", event("thread.queued-turn-created"), false, false],
    ["thread.queued-turn-updated", event("thread.queued-turn-updated"), false, false],
    ["thread.queued-turn-deleted", event("thread.queued-turn-deleted"), false, false],
    ["thread.queued-turn-dispatched", event("thread.queued-turn-dispatched"), false, false],
    ["thread.queued-turn-failed", event("thread.queued-turn-failed"), false, false],
    ["thread.queued-turn-reordered", event("thread.queued-turn-reordered"), false, false],
    ["thread.queue-held", event("thread.queue-held"), false, false],
    ["thread.queue-released", event("thread.queue-released"), false, false],
    ["thread.session-set", event("thread.session-set"), true, false],
    ["thread.turn-diff-completed", event("thread.turn-diff-completed"), true, false],
    ["thread.reverted", event("thread.reverted"), true, true],
    ["thread.deleted", event("thread.deleted"), false, true],
    ["user-input requested", activityEvent("user-input.requested"), true, false],
    ["user-input resolved", activityEvent("user-input.resolved"), true, false],
    ["approval resolved", activityEvent("approval.resolved"), true, false],
    [
      "actionable approval requested",
      activityEvent("approval.requested", { requestType: "dynamic_tool_call" }),
      true,
      false,
    ],
    [
      "stale approval failure",
      activityEvent("provider.approval.respond.failed", {
        detail: "Unknown pending approval request",
      }),
      true,
      false,
    ],
    [
      "stale user-input failure",
      activityEvent("provider.user-input.respond.failed", {
        detail: "Stale pending user-input request",
      }),
      true,
      false,
    ],
    [
      "assistant message",
      event("thread.message-sent", { threadId, role: "assistant" }),
      false,
      false,
    ],
    ["routine activity", activityEvent("task.started"), false, false],
  ] satisfies ReadonlyArray<readonly [string, OrchestrationEvent, boolean, boolean]>)(
    "%s routes the expected reconciliation impact",
    (_name, input, shell, attachments) => {
      const impact = projectionImpactForEvent(input);

      expect(impact.shellThreadIds.has(threadId)).toBe(shell);
      expect(impact.attachmentThreadIds.has(threadId)).toBe(attachments);
    },
  );

  it("shares the actionable approval predicate with pending-approval projection", () => {
    expect(isActionableApprovalRequest({ requestKind: "file-change" })).toBe(true);
    expect(isActionableApprovalRequest({ requestType: "apply_patch_approval" })).toBe(true);
    expect(isActionableApprovalRequest({ requestType: "user_input" })).toBe(false);
  });
});
