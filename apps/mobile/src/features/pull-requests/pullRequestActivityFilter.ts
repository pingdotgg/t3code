import {
  pullRequestConversationThreads,
  type PullRequestActivity,
  type PullRequestActor,
  type PullRequestConversationThread,
} from "@t3tools/contracts";

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

// A bot's approval or change request is a verdict, not chatter.
function isVerdict(reviewState: string | null) {
  const state = reviewState?.trim().toUpperCase().replaceAll("-", "_");
  return state === "APPROVED" || state === "CHANGES_REQUESTED";
}

function eventCount(activity: PullRequestActivity) {
  const threads = pullRequestConversationThreads(activity);
  const discussionIds = new Set(
    threads.flatMap((thread) => thread.comments.map((comment) => comment.id)),
  );
  return (
    activity.comments.filter((comment) => !discussionIds.has(comment.id)).length +
    threads.length +
    activity.commits.length
  );
}

export function filterPullRequestActivity(activity: PullRequestActivity, filter: ActivityFilter) {
  const shown = (thread: PullRequestConversationThread) =>
    filter.kind !== "commits" &&
    (filter.resolved || !thread.isResolved) &&
    (filter.bots ||
      (thread.commentCount ?? 0) > thread.comments.length ||
      thread.nextCommentsCursor != null ||
      thread.comments.some((comment) => !isBot(comment.author)));
  const reviewThreads = activity.reviewThreads.filter(shown);
  const overviewThreads = activity.overviewThreads?.filter(shown);
  const allDiscussionIds = new Set(
    pullRequestConversationThreads(activity).flatMap((thread) =>
      thread.comments.map((comment) => comment.id),
    ),
  );
  const comments =
    filter.kind === "commits"
      ? []
      : activity.comments.filter(
          (comment) =>
            !allDiscussionIds.has(comment.id) &&
            (filter.bots || !isBot(comment.author) || isVerdict(comment.reviewState)) &&
            (filter.resolved || comment.reviewState?.trim().toLowerCase() !== "dismissed"),
        );
  const filtered = {
    ...activity,
    comments,
    reviewThreads,
    ...(overviewThreads === undefined ? {} : { overviewThreads }),
    commits: filter.kind === "comments" ? [] : activity.commits,
    commentsTruncated: filter.kind !== "commits" && activity.commentsTruncated,
    reviewThreadsTruncated: filter.kind !== "commits" && activity.reviewThreadsTruncated,
  };
  return { activity: filtered, hiddenCount: eventCount(activity) - eventCount(filtered) };
}
