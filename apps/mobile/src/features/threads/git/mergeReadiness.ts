import type { VcsStatusResult } from "@t3tools/contracts";

/**
 * Pure predicate for when the mobile UI should offer a one-click "Merge PR".
 * Ported from apps/mac/Sources/SergeCodeMac/Model/MergeReadiness.swift — keep
 * the two in sync.
 *
 * Ready only when:
 * - the PR is open
 * - the PR is not a draft
 * - every review thread is resolved (count known and zero)
 * - the review decision is nil or `APPROVED`
 * - the PR has no merge conflicts with its base branch
 *
 * A nil review decision is normal for repositories without required reviewers.
 * The known-zero unresolved-thread count is the real signal that review feedback
 * has all been fixed; an unknown thread count remains not-ready.
 *
 * Merge state is opt-in from the provider: only an explicit "dirty" blocks
 * merging. A null/unknown merge state never affects readiness — older servers
 * and non-GitHub providers simply don't report it.
 */
export function isMergeReady(status: VcsStatusResult | null): boolean {
  const pr = status?.pr;
  if (!pr || pr.state !== "open") {
    return false;
  }
  if (pr.isDraft === true) {
    return false;
  }
  if (hasPrConflicts(status)) {
    return false;
  }
  if (pr.unresolvedReviewThreadCount !== 0) {
    // Covers both "unresolved threads remain" and "count unknown" (null).
    return false;
  }
  return pr.reviewDecision === null || pr.reviewDecision === "APPROVED";
}

/**
 * True only when the provider reports the PR has merge conflicts with its base
 * branch ("dirty"). An unknown merge state is never conflicting.
 * Mirrors `VcsStatus.hasPrConflicts` in
 * apps/mac/Sources/SergeCodeMac/Model/Entities.swift.
 */
export function hasPrConflicts(status: VcsStatusResult | null): boolean {
  return status?.pr?.mergeStateStatus === "dirty";
}

/**
 * True when the UI should offer the "mark ready for review" (`ready_pr`)
 * action: the PR is open and known to be a draft. Mirrors the Ready for Review
 * affordance in apps/mac/Sources/SergeCodeMac/UI/Shell/VcsToolbar.swift.
 */
export function shouldOfferReadyPr(status: VcsStatusResult | null): boolean {
  return status?.pr?.state === "open" && status.pr.isDraft === true;
}
