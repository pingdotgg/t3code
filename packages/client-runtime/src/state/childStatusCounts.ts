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

// Who-is-on-it order: what waits on the user first, then what broke, then live work.
const URGENCY: Readonly<Record<ChildStatusBucket, number>> = {
  needsInput: 0,
  failed: 1,
  running: 2,
  waiting: 3,
  done: 4,
};

/**
 * The children a collapsed parent shows as avatars, most urgent first and
 * newest first within a state, capped at `limit`. Children needing input or
 * failed always show, even past the cap; the rest count as `overflow`.
 */
export function selectChildAvatars<
  T extends { readonly bucket: ChildStatusBucket; readonly updatedAt: string },
>(children: readonly T[], limit = 5): { readonly shown: readonly T[]; readonly overflow: number } {
  const ordered = [...children].sort(
    (left, right) =>
      URGENCY[left.bucket] - URGENCY[right.bucket] || right.updatedAt.localeCompare(left.updatedAt),
  );
  const urgent = ordered.filter(
    (child) => child.bucket === "needsInput" || child.bucket === "failed",
  ).length;
  const shown = ordered.slice(0, Math.max(limit, urgent));
  return { shown, overflow: ordered.length - shown.length };
}

// Bounds a saved expanded-parents list; the oldest expansions fall off first.
const EXPANDED_PARENTS_LIMIT = 200;

/** Opens or closes a parent's child chats in a saved list of `environmentId:threadId` keys. */
export function toggleExpandedParentKey(
  keys: readonly string[],
  parentKey: string,
): readonly string[] {
  return keys.includes(parentKey)
    ? keys.filter((key) => key !== parentKey)
    : [...keys, parentKey].slice(-EXPANDED_PARENTS_LIMIT);
}
