import type { OrchestrationV2RunStatus, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

export const THREAD_SNAPSHOT_IDLE_TTL_MS = 5 * 60_000;

/**
 * Runs the user is likely to come back to. Preparing, starting and running ones also have newer
 * state than the persisted cache, which is saved only once they settle.
 */
export const UNFINISHED_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

// What the heap charges a small object beyond its strings.
const OBJECT_OVERHEAD_BYTES = 64;

function retainedBytes(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (typeof value !== "object" || value === null) return 8;
  let bytes = OBJECT_OVERHEAD_BYTES;
  for (const field of Object.values(value)) bytes += retainedBytes(field);
  return bytes;
}

/**
 * A cheap estimate of what a thread keeps in the heap, from its items, rows holding an item of their
 * own and message records, with strings counted by length. It walks one thread when the thread is
 * left. Timeline rows and parsed markdown come on top, which matters only for small threads.
 */
export function estimateRetainedThreadBytes(projection: OrchestrationV2ThreadProjection): number {
  let bytes = retainedBytes(projection.turnItems) + retainedBytes(projection.messages);
  const turnItems = new Set<object>(projection.turnItems);
  for (const row of projection.visibleTurnItems) {
    // An inherited row, or a saved record's copy that differs from its item, holds its own.
    bytes += turnItems.has(row.item)
      ? OBJECT_OVERHEAD_BYTES
      : retainedBytes(row.item) + OBJECT_OVERHEAD_BYTES;
  }
  return bytes;
}
