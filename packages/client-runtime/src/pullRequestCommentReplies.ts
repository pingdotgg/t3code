import type {
  PullRequestThreadStatus,
  PullRequestActivity,
  PullRequestComment,
  PullRequestThreadComment,
} from "@t3tools/contracts";

export const pullRequestThreadStatusLabels: Readonly<Record<PullRequestThreadStatus, string>> = {
  active: "Active",
  pending: "Pending",
  fixed: "Resolved",
  wontFix: "Won’t fix",
  closed: "Closed",
  byDesign: "By design",
};

/** Discussions are ordered by their latest activity; their comments always read oldest first. */
export function groupPullRequestComments(
  activity: Pick<PullRequestActivity, "comments" | "reviewThreads">,
) {
  const parents = new Map<string, string>();
  const threadByCommentId = new Map<string, string>();
  const root = (id: string) => {
    const path: string[] = [];
    let current = id;
    while (parents.has(current)) {
      path.push(current);
      current = parents.get(current)!;
    }
    for (const entry of path) parents.set(entry, current);
    return current;
  };
  const join = (id: string, parent: string) => {
    const from = root(id);
    const to = root(parent);
    if (from !== to) parents.set(from, to);
  };
  for (const thread of activity.reviewThreads) {
    for (const comment of thread.comments) {
      join(`comment:${comment.id}`, `thread:${thread.id}`);
      threadByCommentId.set(comment.id, thread.id);
    }
  }
  for (const comment of activity.comments) {
    if (comment.threadId !== undefined) join(`comment:${comment.id}`, `thread:${comment.threadId}`);
    if (comment.replyToCommentId !== undefined)
      join(`comment:${comment.id}`, `comment:${comment.replyToCommentId}`);
  }
  const groups = new Map<
    string,
    { id: string; threadId: string | undefined; comments: PullRequestComment[] }
  >();
  for (const comment of activity.comments) {
    const id = root(`comment:${comment.id}`);
    const group = groups.get(id);
    const threadId = comment.threadId ?? threadByCommentId.get(comment.id);
    if (group === undefined) groups.set(id, { id, threadId, comments: [comment] });
    else {
      group.comments.push(comment);
      group.threadId ??= threadId;
    }
  }
  for (const group of groups.values()) {
    group.comments.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }
  return [...groups.values()].sort(
    (a, b) => Date.parse(a.comments.at(-1)!.createdAt) - Date.parse(b.comments.at(-1)!.createdAt),
  );
}

const AZURE_MENTION = /@<([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})>/giu;
const INLINE_MARKDOWN =
  /`([^`\n]+)`|!?\[([^\]\n]*)\]\([^)\n]*\)|<\/?[a-z][a-z\d-]*(?:\s[^<>\n]*)?\/?>|(?<![\w\\*~])(\*\*|__|~~|\*|_)(?=\S)(.*?\S)\3(?![\w*~])/giu;

function plainInlineMarkdown(text: string): string {
  return text.replace(
    INLINE_MARKDOWN,
    (_match, code?: string, label?: string, _marker?: string, emphasized?: string) =>
      code ?? label ?? (emphasized === undefined ? " " : plainInlineMarkdown(emphasized)),
  );
}

/**
 * One line of plain text from a comment body, for previews that cannot render Markdown. Azure
 * mentions read as the names in `identities`, keyed by lowercase id.
 */
export function pullRequestCommentExcerpt(
  body: string,
  identities: Readonly<Record<string, string>> = {},
  length = 160,
): string {
  const text = plainInlineMarkdown(
    body
      .replace(/<!--[\s\S]*?-->/gu, "")
      // A preview needs only the opening text; the bound keeps the passes below cheap.
      .slice(0, 2_000)
      .replace(AZURE_MENTION, (_match, id: string) => `@${identities[id.toLowerCase()] ?? id}`)
      .replace(/^ {0,3}(?:`{3,}|~{3,}).*$/gmu, "")
      .replace(
        /^ {0,3}(?:(?:>[ \t]?)+|#{1,6}[ \t]+|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)/gmu,
        "",
      ),
  )
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

export interface PullRequestCommentReplyContext {
  readonly author: string;
  readonly excerpt: string;
}

/** Resolve against the full activity so sorting, filters and comment windows keep their context. */
export function pullRequestCommentReplies(
  activity: Pick<PullRequestActivity, "comments" | "reviewThreads"> & {
    readonly identities?: Readonly<Record<string, string>> | undefined;
  },
): ReadonlyMap<string, PullRequestCommentReplyContext> {
  const comments = new Map<string, PullRequestThreadComment>(
    activity.comments.map((comment) => [comment.id, comment]),
  );
  const parents = new Map<string, string>();
  for (const thread of activity.reviewThreads) {
    const root = thread.comments[0];
    for (const comment of thread.comments) {
      if (!comments.has(comment.id)) {
        comments.set(comment.id, comment);
      }
      if (root !== undefined && comment.id !== root.id) parents.set(comment.id, root.id);
    }
  }
  for (const comment of activity.comments) {
    if (comment.replyToCommentId !== undefined) parents.set(comment.id, comment.replyToCommentId);
  }
  const contexts = new Map<string, PullRequestCommentReplyContext>();
  const byParent = new Map<string, PullRequestCommentReplyContext>();
  for (const [id, parentId] of parents) {
    if (id === parentId) continue;
    let context = byParent.get(parentId);
    if (context === undefined) {
      const parent = comments.get(parentId);
      context = {
        author:
          parent === undefined
            ? "earlier comment"
            : (parent.author?.name ?? parent.author?.login ?? "Unknown author"),
        excerpt:
          parent === undefined
            ? "Original comment isn’t loaded."
            : pullRequestCommentExcerpt(parent.body, activity.identities) || "No comment text.",
      };
      byParent.set(parentId, context);
    }
    contexts.set(id, context);
  }
  return contexts;
}
