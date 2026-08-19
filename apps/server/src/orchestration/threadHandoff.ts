import {
  ThreadHandoff,
  ThreadHandoffRequest,
  ThreadHandoffResolution,
  ThreadHandoffSource,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ThreadHandoff as ThreadHandoffRecord,
  type ThreadHandoffId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeRequest = Schema.decodeUnknownOption(ThreadHandoffRequest);
const decodeResolution = Schema.decodeUnknownOption(ThreadHandoffResolution);
const decodeSource = Schema.decodeUnknownOption(ThreadHandoffSource);

function orderedActivities(activities: ReadonlyArray<OrchestrationThreadActivity>) {
  return [...activities].toSorted((left, right) => {
    if (
      left.sequence !== undefined &&
      right.sequence !== undefined &&
      left.sequence !== right.sequence
    ) {
      return left.sequence - right.sequence;
    }
    return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  });
}

function updateState(
  handoffs: Map<string, ThreadHandoffRecord>,
  payload: unknown,
  state: ThreadHandoffRecord["state"],
) {
  const decoded = decodeResolution(payload);
  if (Option.isNone(decoded)) return;
  const current = handoffs.get(decoded.value.handoffId);
  if (!current) return;
  if (state === "available" && current.state !== "pending") return;
  if (state !== "available" && current.state !== "pending" && current.state !== "available") {
    return;
  }
  handoffs.set(decoded.value.handoffId, {
    ...current,
    state,
    targetThreadId: decoded.value.targetThreadId ?? current.targetThreadId,
    resolvedAt: decoded.value.resolvedAt,
  });
}

export function findThreadHandoffs(
  thread: Pick<OrchestrationThread, "id" | "activities">,
): ReadonlyArray<ThreadHandoffRecord> {
  const handoffs = new Map<string, ThreadHandoffRecord>();
  const activities = orderedActivities(thread.activities);
  for (const activity of activities) {
    if (activity.kind === "thread-handoff.requested") {
      const decoded = decodeRequest(activity.payload);
      if (Option.isSome(decoded)) {
        handoffs.set(decoded.value.handoffId, {
          sourceThreadId: thread.id,
          ...decoded.value,
          state: "pending",
          targetThreadId: null,
          resolvedAt: null,
        });
      }
      continue;
    }
    if (activity.kind === "thread-handoff.source") {
      const decoded = decodeSource(activity.payload);
      if (Option.isSome(decoded)) {
        handoffs.set(decoded.value.handoff.handoffId, {
          sourceThreadId: decoded.value.sourceThreadId,
          ...decoded.value.handoff,
          state: "accepted",
          targetThreadId: thread.id,
          resolvedAt: decoded.value.acceptedAt,
        });
      }
      continue;
    }
  }
  // A Plan handoff emits its requested and available activities in the same
  // command. Older activity rows do not always carry an event sequence, so
  // resolve after discovering every request instead of relying on timestamp
  // or random activity-id ordering.
  for (const activity of activities) {
    switch (activity.kind) {
      case "thread-handoff.available":
        updateState(handoffs, activity.payload, "available");
        break;
      case "thread-handoff.dismissed":
        updateState(handoffs, activity.payload, "dismissed");
        break;
      case "thread-handoff.cancelled":
        updateState(handoffs, activity.payload, "cancelled");
        break;
      case "thread-handoff.accepted":
        updateState(handoffs, activity.payload, "accepted");
        break;
      default:
        break;
    }
  }
  return [...handoffs.values()].toSorted(
    (left, right) =>
      left.requestedAt.localeCompare(right.requestedAt) ||
      left.handoffId.localeCompare(right.handoffId),
  );
}

export function findThreadHandoff(
  thread: Pick<OrchestrationThread, "id" | "activities">,
  handoffId: ThreadHandoffId | string,
) {
  return findThreadHandoffs(thread).find((handoff) => handoff.handoffId === handoffId);
}

export function isAvailableThreadHandoff(
  handoff: ThreadHandoffRecord | undefined,
): handoff is ThreadHandoffRecord & { readonly state: "available" } {
  return handoff?.state === "available";
}
