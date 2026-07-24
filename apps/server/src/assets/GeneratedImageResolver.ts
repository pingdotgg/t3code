import type { EventId, OrchestrationThreadActivity } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const GENERATED_IMAGE_LOOKUP_RETRY_COUNT = 20;
const GENERATED_IMAGE_LOOKUP_RETRY_INTERVAL = "250 millis";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function findGeneratedImagePath(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  activityId: EventId,
): string | null {
  const activity = activities.find((candidate) => candidate.id === activityId);
  if (!activity || activity.kind !== "tool.completed") {
    return null;
  }

  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  if (
    item?.type !== "imageGeneration" ||
    item.status !== "completed" ||
    typeof item.savedPath !== "string"
  ) {
    return null;
  }

  const savedPath = item.savedPath.trim();
  return savedPath.length > 0 ? savedPath : null;
}

export function isGeneratedImageFileLookupRetryable(error: unknown): boolean {
  return asRecord(error)?._tag === "AssetGeneratedImageNotFoundError";
}

export function retryGeneratedImageFileLookup<A, E, R>(
  lookup: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return lookup.pipe(
    Effect.retry({
      times: GENERATED_IMAGE_LOOKUP_RETRY_COUNT,
      schedule: Schedule.spaced(GENERATED_IMAGE_LOOKUP_RETRY_INTERVAL),
      while: isGeneratedImageFileLookupRetryable,
    }),
  );
}
