import type { PullRequestActivity, PullRequestActor } from "@t3tools/contracts";

export interface ActivityFilter {
  readonly kind: "all" | "comments" | "commits";
  readonly bots: boolean;
  readonly resolved: boolean;
  readonly newestFirst: boolean;
}

export const DEFAULT_ACTIVITY_FILTER: ActivityFilter = {
  kind: "all",
  bots: false,
  resolved: false,
  newestFirst: true,
};

function isBot(actor: PullRequestActor | null) {
  return actor?.isBot === true;
}

function eventCount(activity: PullRequestActivity) {
  const discussionIds = new Set(
    activity.reviewThreads.flatMap((thread) => thread.comments.map((comment) => comment.id)),
  );
  return (
    activity.comments.filter((comment) => !discussionIds.has(comment.id)).length +
    activity.reviewThreads.length +
    activity.commits.length
  );
}

export function filterPullRequestActivity(activity: PullRequestActivity, filter: ActivityFilter) {
  const reviewThreads =
    filter.kind === "commits"
      ? []
      : activity.reviewThreads.filter(
          (thread) =>
            (filter.resolved || !thread.isResolved) &&
            (filter.bots ||
              (thread.commentCount ?? 0) > thread.comments.length ||
              thread.nextCommentsCursor != null ||
              thread.comments.some((comment) => !isBot(comment.author))),
        );
  const allDiscussionIds = new Set(
    activity.reviewThreads.flatMap((thread) => thread.comments.map((comment) => comment.id)),
  );
  const comments =
    filter.kind === "commits"
      ? []
      : activity.comments.filter(
          (comment) =>
            !allDiscussionIds.has(comment.id) &&
            (filter.bots || !isBot(comment.author)) &&
            (filter.resolved || comment.reviewState?.trim().toLowerCase() !== "dismissed"),
        );
  const filtered = {
    ...activity,
    comments,
    reviewThreads,
    commits: filter.kind === "comments" ? [] : activity.commits,
    commentsTruncated: filter.kind !== "commits" && activity.commentsTruncated,
    reviewThreadsTruncated: filter.kind !== "commits" && activity.reviewThreadsTruncated,
  };
  return { activity: filtered, hiddenCount: eventCount(activity) - eventCount(filtered) };
}
