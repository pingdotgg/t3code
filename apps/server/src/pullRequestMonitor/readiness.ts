import type {
  PullRequestMonitorBlocker,
  PullRequestMonitorReadiness,
  PullRequestMonitorSnapshot,
} from "@t3tools/contracts";

/**
 * Durable monitor state that blocks merge readiness independently of provider state:
 * feedback nobody dispositioned, claims nothing verified, escalations, and wakes that
 * never reached the owner.
 */
export interface PullRequestMonitorFeedbackReadiness {
  readonly openCount: number;
  readonly verifyingCount: number;
  readonly needsHumanCount: number;
  readonly pendingDeliveryCount: number;
}

export const emptyFeedbackReadiness: PullRequestMonitorFeedbackReadiness = {
  openCount: 0,
  verifyingCount: 0,
  needsHumanCount: 0,
  pendingDeliveryCount: 0,
};

/**
 * Deterministic server readiness. `ready-to-merge` requires evidence that every merge policy
 * input was actually observed; anything less is only `no-known-blockers`.
 */
export function computeReadiness(
  snapshot: PullRequestMonitorSnapshot,
  feedback: PullRequestMonitorFeedbackReadiness = emptyFeedbackReadiness,
): PullRequestMonitorReadiness {
  const blockers: PullRequestMonitorBlocker[] = [];

  if (snapshot.state !== "open") {
    blockers.push({ kind: "terminal", detail: snapshot.state });
  }
  if (snapshot.isDraft) {
    blockers.push({ kind: "draft" });
  }
  if (snapshot.mergeability !== "mergeable") {
    blockers.push({ kind: "mergeability", detail: snapshot.mergeability });
  }
  if (!snapshot.completeness.reviewsComplete) {
    blockers.push({ kind: "evidence-incomplete", detail: "reviews" });
  }
  if (!snapshot.completeness.reviewThreadsComplete) {
    blockers.push({ kind: "evidence-incomplete", detail: "review-threads" });
  }
  if (!snapshot.completeness.issueCommentsComplete) {
    blockers.push({ kind: "evidence-incomplete", detail: "issue-comments" });
  }
  if (!snapshot.completeness.checksComplete) {
    blockers.push({ kind: "evidence-incomplete", detail: "checks" });
  }
  const requiredCheckCoverage = snapshot.requiredCheckCoverage;
  if (requiredCheckCoverage === undefined) {
    blockers.push({ kind: "required-check-coverage-unknown" });
  } else {
    const expected = new Set(requiredCheckCoverage.expected);
    const observed = new Set(requiredCheckCoverage.observed.map((check) => check.name));
    const missing = [...expected].filter((name) => !observed.has(name));
    const extra = [...observed].filter((name) => !expected.has(name));
    if (requiredCheckCoverage.completeness !== "complete" || missing.length > 0) {
      blockers.push({
        kind: "required-check-coverage-unknown",
        detail:
          missing.length > 0 ? `missing:${missing.join(",")}` : requiredCheckCoverage.completeness,
      });
    } else if (extra.length > 0) {
      blockers.push({
        kind: "required-check-coverage-unknown",
        detail: `extra:${extra.join(",")}`,
      });
    }
  }

  const currentChecks = snapshot.checkRuns.filter((check) => check.headSha === snapshot.headSha);
  if (currentChecks.length === 0) {
    blockers.push({ kind: "checks-missing" });
  }
  for (const check of currentChecks) {
    if (check.status === "pending") {
      blockers.push({ kind: "check-pending", detail: check.name });
    } else if (check.status === "cancelled") {
      // A cancelled run never proved success; it must be re-run before merge.
      blockers.push({ kind: "check-cancelled", detail: check.name });
    } else if (
      check.status !== "success" &&
      check.status !== "neutral" &&
      check.status !== "skipped"
    ) {
      blockers.push({ kind: "check-failed", detail: check.name });
    }
  }

  const latestOpinionated = new Map<string, (typeof snapshot.reviews)[number]>();
  for (const review of snapshot.reviews) {
    if (review.state !== "changes-requested" && review.state !== "approved") continue;
    const previous = latestOpinionated.get(review.author.login);
    if (previous === undefined || (review.submittedAt ?? "") > (previous.submittedAt ?? "")) {
      latestOpinionated.set(review.author.login, review);
    }
  }
  for (const review of latestOpinionated.values()) {
    if (review.state === "changes-requested") {
      blockers.push({ kind: "changes-requested", detail: review.author.login });
    }
  }

  // Readiness considers every currently unresolved thread, regardless of when monitoring
  // started; baseline timing only gates notification generation in the diff path.
  for (const thread of snapshot.reviewThreads) {
    if (!thread.resolved) {
      blockers.push({ kind: "unresolved-thread", detail: thread.id });
    }
  }

  if (feedback.openCount > 0) {
    blockers.push({ kind: "feedback-open", detail: String(feedback.openCount) });
  }
  if (feedback.verifyingCount > 0) {
    blockers.push({ kind: "feedback-unverified", detail: String(feedback.verifyingCount) });
  }
  if (feedback.needsHumanCount > 0) {
    blockers.push({ kind: "feedback-needs-human", detail: String(feedback.needsHumanCount) });
  }
  if (feedback.pendingDeliveryCount > 0) {
    blockers.push({
      kind: "feedback-delivery-pending",
      detail: String(feedback.pendingDeliveryCount),
    });
  }

  if (blockers.length > 0) {
    return { ready: false, label: "blocked", blockers };
  }

  return { ready: true, label: "ready-to-merge", blockers: [] };
}

export function formatBlockersSummary(readiness: PullRequestMonitorReadiness): string {
  if (readiness.ready) return readiness.label;
  if (readiness.blockers.length === 0) return "blocked";
  return readiness.blockers
    .slice(0, 8)
    .map((blocker) => (blocker.detail ? `${blocker.kind}:${blocker.detail}` : blocker.kind))
    .join(", ");
}
