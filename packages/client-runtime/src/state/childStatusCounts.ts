import type { AgentThreadStatus } from "./agents.ts";

/**
 * How a collapsed parent summarizes its child chats, most actionable first.
 * Each surface buckets a child by the status its own row shows, so the counts
 * never disagree with the rows they stand in for.
 */
export const CHILD_STATUS_BUCKETS = ["needsInput", "running", "waiting", "failed", "done"] as const;

export type ChildStatusBucket = (typeof CHILD_STATUS_BUCKETS)[number];

export type ChildStatusCounts = Readonly<Record<ChildStatusBucket, number>>;

export function emptyChildStatusCounts(): Record<ChildStatusBucket, number> {
  return { needsInput: 0, running: 0, waiting: 0, failed: 0, done: 0 };
}

export function countChildStatusBuckets<T>(
  children: Iterable<T>,
  bucketOf: (child: T) => ChildStatusBucket,
): ChildStatusCounts {
  const counts = emptyChildStatusCounts();
  for (const child of children) counts[bucketOf(child)] += 1;
  return counts;
}

/** The bucket of an Agents board child row, from the status that row shows. */
export function agentChildStatusBucket(status: AgentThreadStatus): ChildStatusBucket {
  switch (status) {
    case "attention":
      return "needsInput";
    case "running":
    case "queued":
      return "running";
    case "waiting":
    case "idle":
      return "waiting";
    case "error":
      return "failed";
    case "done":
      return "done";
  }
}
