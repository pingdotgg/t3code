import type { PullRequestState } from "@t3tools/contracts";

interface ObservedPullRequest {
  readonly state: PullRequestState;
  readonly updatedAt?: string | undefined;
  readonly observedAt?: number | undefined;
}

/** Older than what is shown by host update time, then server read time, or a merge undone. */
export function isStalePullRequestReply(
  shown: ObservedPullRequest,
  reply: ObservedPullRequest,
): boolean {
  if (shown.state === "merged" && reply.state !== "merged") return true;
  if (shown.updatedAt !== undefined && reply.updatedAt !== undefined) {
    const updated = Date.parse(reply.updatedAt) - Date.parse(shown.updatedAt);
    if (Number.isFinite(updated) && updated !== 0) return updated < 0;
  }
  return (reply.observedAt ?? -Infinity) < (shown.observedAt ?? -Infinity);
}
