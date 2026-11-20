import {
  type PullRequestActivity,
  type PullRequestComment,
  type PullRequestConversationThread,
  pullRequestConversationThreads,
} from "@t3tools/contracts";

export type ConversationItem =
  | { readonly kind: "comment"; readonly id: string; readonly comment: PullRequestComment }
  | {
      readonly kind: "thread";
      readonly id: string;
      readonly root: PullRequestComment;
      readonly replies: ReadonlyArray<PullRequestComment>;
      readonly thread: PullRequestConversationThread;
    };

export type Audience = "all" | "humans" | "bots";

const time = (comment: PullRequestComment) => Date.parse(comment.createdAt);

/** An item counts as a bot's when its first comment is, so a human's reply to a bot's finding stays under Bots. */
export const rootOf = (item: ConversationItem) =>
  item.kind === "comment" ? item.comment : item.root;

export const isBotItem = (item: ConversationItem) => rootOf(item).author?.isBot === true;

/**
 * The conversation oldest first: each review thread as one item, placed at its first comment's
 * time, and each loose comment. A comment a thread holds is not listed again on its own.
 */
export function conversationItems(
  activity: Pick<PullRequestActivity, "comments" | "reviewThreads" | "overviewThreads">,
): ReadonlyArray<ConversationItem> {
  const byId = new Map(activity.comments.map((comment) => [comment.id, comment]));
  const claimed = new Set<string>();
  const threads = pullRequestConversationThreads(activity).flatMap((thread): ConversationItem[] => {
    // Some hosts list a thread's comment only in the thread, so that copy stands in.
    const ordered = thread.comments
      .map(
        (comment): PullRequestComment =>
          byId.get(comment.id) ?? {
            ...comment,
            kind: "review-comment",
            path: thread.path,
            reviewState: null,
          },
      )
      .toSorted((left, right) => time(left) - time(right));
    const [root, ...replies] = ordered;
    if (root === undefined) return [];
    for (const comment of ordered) claimed.add(comment.id);
    return [{ kind: "thread", id: thread.id, root, replies, thread }];
  });
  const loose = activity.comments
    .filter((comment) => !claimed.has(comment.id))
    .map((comment): ConversationItem => ({ kind: "comment", id: comment.id, comment }));
  return [...threads, ...loose].toSorted((left, right) => time(rootOf(left)) - time(rootOf(right)));
}

export function audienceCounts(items: ReadonlyArray<ConversationItem>) {
  const bots = items.filter(isBotItem).length;
  return { all: items.length, humans: items.length - bots, bots };
}

export function filterByAudience(
  items: ReadonlyArray<ConversationItem>,
  audience: Audience,
): ReadonlyArray<ConversationItem> {
  return audience === "all"
    ? items
    : items.filter((item) => isBotItem(item) === (audience === "bots"));
}
