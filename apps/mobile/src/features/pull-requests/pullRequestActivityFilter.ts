import {
  filterAzureDevOpsDiscussions,
  type AzureDevOpsDiscussionFilter,
} from "@t3tools/client-runtime/azure-devops-discussion-filter";
import type { PullRequestActivity, PullRequestActor } from "@t3tools/contracts";
import { groupPullRequestComments } from "@t3tools/client-runtime/pull-request-comment-replies";

export interface ActivityFilter {
  readonly azure?: AzureDevOpsDiscussionFilter;
  readonly kind: "all" | "comments" | "commits";
  readonly bots: boolean;
  readonly resolved: boolean;
  readonly newestFirst: boolean;
  readonly newOnly?: boolean;
  readonly since?: string | null;
}

export const DEFAULT_ACTIVITY_FILTER: ActivityFilter = {
  kind: "all",
  bots: false,
  resolved: false,
  newestFirst: true,
};

function isBot(actor: PullRequestActor | null) {
  return actor?.isBot === true || actor?.login.endsWith("[bot]") === true;
}

function eventCount(activity: PullRequestActivity) {
  const discussionIds = new Set(
    activity.reviewThreads.flatMap((thread) => thread.comments.map((comment) => comment.id)),
  );
  return (
    groupPullRequestComments({
      comments: activity.comments.filter((comment) => !discussionIds.has(comment.id)),
      reviewThreads: [],
    }).length +
    activity.reviewThreads.length +
    activity.commits.length +
    (activity.events?.length ?? 0)
  );
}

export function filterPullRequestActivity(
  activity: PullRequestActivity,
  filter: ActivityFilter,
  context?: { provider: string; viewer?: string | undefined },
) {
  if (context?.provider === "azure-devops")
    return filterAzureDevOpsDiscussions(activity, filter.azure ?? "all", {
      viewer: context.viewer,
      since: filter.since,
    });
  const newer = (date: string) =>
    !filter.newOnly || !filter.since || Date.parse(date) > Date.parse(filter.since);
  // A discussion's replies stay together, even when a bot replies to a human.
  const reviewThreads =
    filter.kind === "commits"
      ? []
      : activity.reviewThreads.filter(
          (thread) =>
            thread.comments.some((comment) => newer(comment.editedAt ?? comment.createdAt)) &&
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
      : groupPullRequestComments({
          comments: activity.comments.filter((comment) => !allDiscussionIds.has(comment.id)),
          reviewThreads: [],
        })
          .filter(
            (discussion) =>
              discussion.comments.some((comment) => newer(comment.editedAt ?? comment.createdAt)) &&
              (filter.bots || discussion.comments.some((comment) => !isBot(comment.author))) &&
              (filter.resolved ||
                discussion.comments.some(
                  (comment) =>
                    comment.reviewState?.trim().toLowerCase() !== "dismissed" &&
                    (comment.threadStatus === undefined ||
                      ["active", "pending"].includes(comment.threadStatus)),
                )),
          )
          .flatMap((discussion) => discussion.comments);
  const filtered = {
    ...activity,
    comments,
    reviewThreads,
    commits:
      filter.kind === "comments"
        ? []
        : activity.commits.filter((commit) => newer(commit.committedDate)),
    events:
      filter.kind === "all"
        ? (activity.events ?? []).filter((event) => newer(event.createdAt))
        : [],
    commentsTruncated: filter.kind !== "commits" && activity.commentsTruncated,
    reviewThreadsTruncated: filter.kind !== "commits" && activity.reviewThreadsTruncated,
  };
  return { activity: filtered, hiddenCount: eventCount(activity) - eventCount(filtered) };
}
