import type {
  PullRequestMonitorCheckRun,
  PullRequestMonitorSnapshot,
} from "../sourceControl/gitHubPullRequestMonitor.ts";

export interface PullRequestMonitorCursor {
  readonly headSha: string;
  readonly reviewStates: Readonly<Record<string, string>>;
  readonly threadVersions: Readonly<
    Record<string, { readonly updatedAt: string; readonly resolved: boolean }>
  >;
  readonly issueCommentVersions: Readonly<Record<string, string>>;
  readonly checkRuns: Readonly<
    Record<string, { readonly runId: string; readonly outcome: "success" | "failure" | "pending" }>
  >;
  readonly behindBase: boolean;
}

export type PullRequestMonitorActionableEvent =
  | { readonly kind: "new-review-comment"; readonly threadId: string; readonly edited: boolean }
  | { readonly kind: "changes-requested-review"; readonly reviewId: string }
  | { readonly kind: "check-failed"; readonly checkRunId: string; readonly checkName: string }
  | { readonly kind: "behind-base" };

const checkOutcome = (check: PullRequestMonitorCheckRun): "success" | "failure" | "pending" => {
  if (check.status !== "completed") return "pending";
  if (
    check.conclusion === "success" ||
    check.conclusion === "neutral" ||
    check.conclusion === "skipped"
  ) {
    return "success";
  }
  return "failure";
};

export function cursorFromSnapshot(snapshot: PullRequestMonitorSnapshot): PullRequestMonitorCursor {
  return {
    headSha: snapshot.headSha,
    reviewStates: Object.fromEntries(snapshot.reviews.map((review) => [review.id, review.state])),
    threadVersions: Object.fromEntries(
      snapshot.reviewThreads.map((thread) => [
        thread.id,
        { updatedAt: thread.updatedAt, resolved: thread.resolved },
      ]),
    ),
    issueCommentVersions: Object.fromEntries(
      snapshot.issueComments.map((comment) => [comment.id, comment.updatedAt]),
    ),
    checkRuns: Object.fromEntries(
      snapshot.checkRuns
        .filter((check) => check.headSha === snapshot.headSha)
        .map((check) => [
          `${check.headSha}::${check.name}::${check.id}`,
          { runId: check.id, outcome: checkOutcome(check) },
        ]),
    ),
    behindBase: (snapshot.behindBaseBy ?? 0) > 0,
  };
}

export function diffPullRequestMonitorSnapshot(
  previousCursor: PullRequestMonitorCursor,
  snapshot: PullRequestMonitorSnapshot,
): {
  readonly actionableEvents: ReadonlyArray<PullRequestMonitorActionableEvent>;
  readonly nextCursor: PullRequestMonitorCursor;
} {
  const actionableEvents: PullRequestMonitorActionableEvent[] = [];
  for (const thread of snapshot.reviewThreads) {
    const previous = previousCursor.threadVersions[thread.id];
    if (
      !thread.resolved &&
      (!previous || previous.resolved || previous.updatedAt !== thread.updatedAt)
    ) {
      actionableEvents.push({
        kind: "new-review-comment",
        threadId: thread.id,
        edited: previous !== undefined,
      });
    }
  }
  for (const comment of snapshot.issueComments) {
    const previousUpdatedAt = previousCursor.issueCommentVersions[comment.id];
    if (!previousUpdatedAt || previousUpdatedAt !== comment.updatedAt) {
      actionableEvents.push({
        kind: "new-review-comment",
        threadId: comment.id,
        edited: previousUpdatedAt !== undefined,
      });
    }
  }
  for (const review of snapshot.reviews) {
    if (
      review.commitSha === snapshot.headSha &&
      review.state === "changes-requested" &&
      previousCursor.reviewStates[review.id] !== "changes-requested"
    ) {
      actionableEvents.push({ kind: "changes-requested-review", reviewId: review.id });
    }
  }
  for (const check of snapshot.checkRuns.filter((item) => item.headSha === snapshot.headSha)) {
    const outcome = checkOutcome(check);
    const previous = previousCursor.checkRuns[`${check.headSha}::${check.name}::${check.id}`];
    // Each concrete run is acknowledged independently, including concurrent
    // same-name runs on one head and reruns/new heads with new run ids.
    if (outcome === "failure" && previous?.outcome !== "failure") {
      actionableEvents.push({
        kind: "check-failed",
        checkRunId: check.id,
        checkName: check.name,
      });
    }
  }
  if ((snapshot.behindBaseBy ?? 0) > 0 && !previousCursor.behindBase) {
    actionableEvents.push({ kind: "behind-base" });
  }
  return { actionableEvents, nextCursor: cursorFromSnapshot(snapshot) };
}
