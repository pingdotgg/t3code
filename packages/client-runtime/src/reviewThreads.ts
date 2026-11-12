import type { PullRequestActor, PullRequestReviewThread } from "@t3tools/contracts";

/**
 * Review bots keep their bookkeeping in HTML comments, which markdown renderers drop. A body that
 * is nothing but a marker would render as an empty block, so it counts as no body at all.
 */
export function visibleCommentBody(body: string): string | null {
  return body.replace(/<!--[\s\S]*?-->/gu, "").trim().length === 0 ? null : body.trim();
}

/** A review that says something about the change itself, rather than only carrying remarks. */
export type PullRequestReviewVerdict = "approved" | "changes-requested" | "dismissed";

/** Hosts spell the same verdicts differently, so case and separator are ignored. */
export function pullRequestReviewVerdict(
  reviewState: string | null | undefined,
): PullRequestReviewVerdict | null {
  switch (reviewState?.trim().toLowerCase().replaceAll("_", "-")) {
    case "approved":
      return "approved";
    case "changes-requested":
      return "changes-requested";
    case "dismissed":
      return "dismissed";
    default:
      return null;
  }
}

/** Appends fetched pages without replacing fresher comments already in the activity response. */
export function mergeReviewThreadComments<T extends { readonly id: string }>(
  base: ReadonlyArray<T>,
  loaded: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const seen = new Set(base.map((comment) => comment.id));
  return [
    ...base,
    ...loaded.filter((comment) => {
      if (seen.has(comment.id)) return false;
      seen.add(comment.id);
      return true;
    }),
  ];
}

function actorName(actor: PullRequestActor | null | undefined) {
  return actor?.name ?? actor?.login ?? "ghost";
}

/** "a and b", or "a, b and 2 more" once a list stops fitting on one line. */
export function reviewParticipantsLabel(actors: ReadonlyArray<PullRequestActor | null>) {
  const names = [...new Set(actors.map(actorName))];
  return names.length > 2
    ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`
    : names.join(" and ");
}

/** The one line a review conversation shows when collapsed, matching desktop's header. */
export function reviewThreadSummary(
  thread: Pick<PullRequestReviewThread, "isResolved" | "commentCount" | "comments">,
) {
  const count = thread.commentCount ?? thread.comments.length;
  const noun = count === 1 ? "comment" : "comments";
  if (!thread.isResolved) return `Open · ${count} ${noun}`;
  const authors = reviewParticipantsLabel(thread.comments.map((comment) => comment.author));
  return `${count} resolved ${noun}${authors ? ` from ${authors}` : ""}`;
}

/** Open and resolved totals for a checklist header; read after the optimistic projection. */
export function countReviewThreads(
  threads: ReadonlyArray<Pick<PullRequestReviewThread, "isResolved">>,
) {
  let resolved = 0;
  for (const thread of threads) if (thread.isResolved) resolved += 1;
  return { open: threads.length - resolved, resolved };
}

export type ReviewTimelineRow<T> =
  | { readonly kind: "event"; readonly event: T }
  | { readonly kind: "comments"; readonly events: ReadonlyArray<T> };

/**
 * Consecutive remarks are one conversation section. Commits, discussions, lifecycle updates and
 * verdicts stay first-class rows and split those sections, so expanding a conversation never hides
 * work that happened between two review rounds, and an approval is never folded away.
 */
export function groupReviewTimelineConversations<T>(
  events: ReadonlyArray<T>,
  isRemark: (event: T) => boolean,
): ReadonlyArray<ReviewTimelineRow<T>> {
  const rows: ReviewTimelineRow<T>[] = [];
  for (const event of events) {
    const last = rows.at(-1);
    if (!isRemark(event)) rows.push({ kind: "event", event });
    else if (last?.kind === "comments")
      rows[rows.length - 1] = { kind: "comments", events: [...last.events, event] };
    else rows.push({ kind: "comments", events: [event] });
  }
  return rows;
}
