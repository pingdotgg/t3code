import type { PullRequestActivity } from "@t3tools/contracts";
import { groupPullRequestComments } from "./pullRequestCommentReplies.ts";

export const azureDevOpsDiscussionFilters = [
  { id: "all", label: "Show everything" },
  { id: "comments", label: "All comments" },
  { id: "new", label: "What's new" },
  { id: "mine", label: "My comments/replies" },
  { id: "active", label: "Active comments" },
  { id: "resolved", label: "Resolved comments" },
] as const;

export type AzureDevOpsDiscussionFilter = (typeof azureDevOpsDiscussionFilters)[number]["id"];

export function filterAzureDevOpsDiscussions(
  activity: PullRequestActivity,
  filter: AzureDevOpsDiscussionFilter,
  context: { readonly viewer?: string | undefined; readonly since?: string | null | undefined },
) {
  const groups = groupPullRequestComments(activity);
  const newer = (date: string) => !context.since || Date.parse(date) > Date.parse(context.since);
  const resolvedThreads = new Set(
    activity.reviewThreads.filter((thread) => thread.isResolved).map((thread) => thread.id),
  );
  const categories = groups.map((group) => {
    const status = group.comments[0]?.threadStatus;
    const resolved =
      status === undefined
        ? group.threadId !== undefined && resolvedThreads.has(group.threadId)
        : ["fixed", "wontFix", "closed", "byDesign"].includes(status);
    return {
      group,
      matches: {
        all: true,
        comments: true,
        new: group.comments.some((comment) => newer(comment.editedAt ?? comment.createdAt)),
        mine:
          context.viewer !== undefined &&
          group.comments.some(
            (comment) => comment.author?.login.toLowerCase() === context.viewer?.toLowerCase(),
          ),
        active: !resolved,
        resolved,
      },
    };
  });
  const events = activity.events ?? [];
  const newEvents = events.filter((event) => newer(event.createdAt));
  const myEvents = events.filter(
    (event) =>
      context.viewer !== undefined &&
      event.actor?.login.toLowerCase() === context.viewer.toLowerCase(),
  );
  const counts = {
    all: groups.length + events.length,
    comments: groups.length,
    new: categories.filter((item) => item.matches.new).length + newEvents.length,
    mine: categories.filter((item) => item.matches.mine).length + myEvents.length,
    active: categories.filter((item) => item.matches.active).length,
    resolved: categories.filter((item) => item.matches.resolved).length,
  };
  const discussions = categories.filter((item) => item.matches[filter]).map((item) => item.group);
  const commentIds = new Set(
    discussions.flatMap((group) => group.comments.map((comment) => comment.id)),
  );
  return {
    counts,
    hiddenCount: counts.all - counts[filter],
    discussions,
    activity: {
      ...activity,
      comments: activity.comments.filter((comment) => commentIds.has(comment.id)),
      reviewThreads: activity.reviewThreads.filter((thread) =>
        thread.comments.some((comment) => commentIds.has(comment.id)),
      ),
      events:
        filter === "all"
          ? events
          : filter === "new"
            ? newEvents
            : filter === "mine"
              ? myEvents
              : [],
      // Azure already reports pushes as system updates, with their commit links.
      commits: [],
    },
  };
}
