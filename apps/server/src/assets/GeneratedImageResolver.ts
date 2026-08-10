import type { EventId, OrchestrationThreadActivity } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

export function findGeneratedImagePath(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  activityId: EventId,
): string | null {
  const activity = activities.find((candidate) => candidate.id === activityId);
  if (!activity || activity.kind !== "tool.completed") {
    return null;
  }

  const payload = activity.payload;
  if (!Predicate.isObject(payload) || !Predicate.hasProperty(payload, "data")) {
    return null;
  }
  const data = payload.data;
  if (!Predicate.isObject(data) || !Predicate.hasProperty(data, "item")) {
    return null;
  }
  const item = data.item;
  if (
    !Predicate.isObject(item) ||
    !Predicate.hasProperty(item, "type") ||
    item.type !== "imageGeneration" ||
    !Predicate.hasProperty(item, "status") ||
    item.status !== "completed" ||
    !Predicate.hasProperty(item, "savedPath") ||
    !Predicate.isString(item.savedPath)
  ) {
    return null;
  }

  const savedPath = item.savedPath.trim();
  return savedPath.length > 0 ? savedPath : null;
}
