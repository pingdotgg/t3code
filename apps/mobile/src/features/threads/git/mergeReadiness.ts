import type { VcsStatusResult } from "@t3tools/contracts";

/**
 * Pure predicate for when the mobile UI should offer a one-click "Merge PR".
 * Ported from apps/mac/Sources/SergeCodeMac/Model/MergeReadiness.swift — keep
 * the two in sync.
 *
 * Ready only when:
 * - the PR is open
 * - every review thread is resolved (count known and zero)
 * - the review decision is nil or `APPROVED`
 *
 * A nil review decision is normal for repositories without required reviewers.
 * The known-zero unresolved-thread count is the real signal that review feedback
 * has all been fixed; an unknown thread count remains not-ready.
 */
export function isMergeReady(status: VcsStatusResult | null): boolean {
  const pr = status?.pr;
  if (!pr || pr.state !== "open") {
    return false;
  }
  if (pr.unresolvedReviewThreadCount !== 0) {
    // Covers both "unresolved threads remain" and "count unknown" (null).
    return false;
  }
  return pr.reviewDecision === null || pr.reviewDecision === "APPROVED";
}
