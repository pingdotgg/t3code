import {
  ChildThreadLifecycleNotification,
  type ChildThreadLifecycle,
  CrossThreadSendRecord,
  type EventId,
  type OrchestrationThreadActivity,
  type TurnId,
} from "@t3tools/contracts";
import { Schema } from "effect";

const TURN_LIFECYCLE_INSIGHT_KINDS: ReadonlySet<string> = new Set([
  "insights.turn.started",
  "insights.turn.completed",
  "insights.turn.aborted",
]);

const CHILD_LIFECYCLE_ACTIVITY_PRESENTATION = {
  started: { summarySuffix: "started", tone: "info" },
  blocked: { summarySuffix: "is blocked", tone: "error" },
  "approval-required": { summarySuffix: "needs approval", tone: "approval" },
  "input-required": { summarySuffix: "needs input", tone: "approval" },
  failed: { summarySuffix: "failed", tone: "error" },
  completed: { summarySuffix: "completed", tone: "info" },
  "pr-created": { summarySuffix: "created a pull request", tone: "info" },
  reported: { summarySuffix: "sent an update", tone: "info" },
} as const satisfies Record<
  ChildThreadLifecycle,
  {
    readonly summarySuffix: string;
    readonly tone: "info" | "approval" | "error";
  }
>;

export type ChildLifecycleThreadActivity = Omit<OrchestrationThreadActivity, "kind" | "payload"> & {
  readonly kind: `child.lifecycle.${ChildThreadLifecycle}`;
  readonly payload: ChildThreadLifecycleNotification;
};

const isChildThreadLifecycleNotification = Schema.is(ChildThreadLifecycleNotification);

export function childLifecycleNotificationToActivity(input: {
  readonly eventId: EventId;
  readonly payload: ChildThreadLifecycleNotification;
  readonly sequence?: number;
}): ChildLifecycleThreadActivity {
  const presentation = CHILD_LIFECYCLE_ACTIVITY_PRESENTATION[input.payload.lifecycle];
  return {
    id: input.eventId,
    tone: presentation.tone,
    kind: `child.lifecycle.${input.payload.lifecycle}`,
    summary: input.payload.report
      ? `${input.payload.childTitle}: ${input.payload.report.summary}`
      : `${input.payload.childTitle} ${presentation.summarySuffix}`,
    payload: input.payload,
    turnId: null,
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
    createdAt: input.payload.createdAt,
  };
}

export function isChildLifecycleThreadActivity(
  activity: OrchestrationThreadActivity,
): activity is ChildLifecycleThreadActivity {
  return (
    isChildThreadLifecycleNotification(activity.payload) &&
    activity.kind === `child.lifecycle.${activity.payload.lifecycle}`
  );
}

export function isTurnLifecycleInsightActivity(activity: OrchestrationThreadActivity): boolean {
  return TURN_LIFECYCLE_INSIGHT_KINDS.has(activity.kind);
}

export const CROSS_THREAD_SEND_ACTIVITY_KIND = "cross-thread.send";

export type CrossThreadSendActivity = Omit<OrchestrationThreadActivity, "kind" | "payload"> & {
  readonly kind: typeof CROSS_THREAD_SEND_ACTIVITY_KIND;
  readonly payload: CrossThreadSendRecord;
};

const isCrossThreadSendRecord = Schema.is(CrossThreadSendRecord);

export function crossThreadSendRecordToActivity(input: {
  readonly eventId: EventId;
  readonly payload: CrossThreadSendRecord;
  readonly turnId: TurnId | null;
  readonly sequence?: number;
}): CrossThreadSendActivity {
  return {
    id: input.eventId,
    tone: "info",
    kind: CROSS_THREAD_SEND_ACTIVITY_KIND,
    summary: `Sent a message to ${input.payload.destinationThreadTitle}`,
    payload: input.payload,
    turnId: input.turnId,
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
    createdAt: input.payload.createdAt,
  };
}

export function isCrossThreadSendActivity(
  activity: OrchestrationThreadActivity,
): activity is CrossThreadSendActivity {
  return (
    activity.kind === CROSS_THREAD_SEND_ACTIVITY_KIND && isCrossThreadSendRecord(activity.payload)
  );
}
