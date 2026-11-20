import type { PullRequestComment, PullRequestReactionContent } from "@t3tools/contracts";

import { ChatMarkdown } from "../chat/Markdown";
import { ago } from "../ui/ago";

const EMOJI = {
  "thumbs-up": "👍",
  "thumbs-down": "👎",
  laugh: "😄",
  hooray: "🎉",
  confused: "😕",
  heart: "❤️",
  rocket: "🚀",
  eyes: "👀",
} satisfies Record<PullRequestReactionContent, string>;

function reviewLabel(state: string | null): string {
  switch (state) {
    case "APPROVED":
      return "Approved";
    case "CHANGES_REQUESTED":
      return "Changes requested";
    case "DISMISSED":
      return "Dismissed";
    default:
      return "Reviewed";
  }
}

const BADGE =
  "shrink-0 rounded border border-line bg-message px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-muted uppercase";

/**
 * One comment as Orca's card draws it: the author over a line of time and badges, then the body as
 * markdown and the reactions. A reply keeps one line and sits behind a rail.
 */
export function CommentEntry({
  comment,
  reply = false,
}: {
  comment: PullRequestComment;
  reply?: boolean;
}) {
  const login = comment.author?.login ?? "ghost";
  const time = (
    <time dateTime={comment.createdAt} className="shrink-0 text-[11px] text-muted">
      {reply ? "· " : ""}
      {ago(comment.createdAt)}
    </time>
  );
  const badges = (
    <>
      {comment.author?.isBot === true && <span className={BADGE}>bot</span>}
      {comment.kind === "review" && (
        <span className={BADGE}>{reviewLabel(comment.reviewState)}</span>
      )}
    </>
  );
  return (
    <div
      data-testid="pr-comment"
      data-bot={comment.author?.isBot === true}
      className={`min-w-0 ${reply ? "bg-message/25 pl-3" : ""}`}
    >
      <div
        className={
          reply
            ? "flex min-w-0 items-center gap-2 px-3 py-2"
            : "flex flex-col gap-1 border-b border-line px-3 py-2"
        }
      >
        <div className="flex min-w-0 items-center gap-2">
          {/* The CSP allows no remote images, so the avatar is the login's first letter. */}
          <span
            aria-hidden
            className={`grid shrink-0 place-items-center rounded-full border border-line bg-bg text-[10px] font-semibold text-fg uppercase ${reply ? "size-4" : "size-5"}`}
          >
            {login[0]}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg">{login}</span>
          {reply && (
            <>
              {time}
              {badges}
            </>
          )}
        </div>
        {!reply && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-7 text-[11px] text-muted">
            {time}
            {badges}
          </div>
        )}
      </div>
      {comment.body.trim() !== "" && (
        <div className="px-4 py-2.5 text-[13px] leading-relaxed break-words text-fg">
          <ChatMarkdown text={comment.body} />
        </div>
      )}
      {(comment.reactions?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1 px-4 pb-2.5">
          {comment.reactions?.map((reaction) => (
            <span
              key={reaction.content}
              data-testid="pr-reaction"
              className="rounded-full border border-line px-1.5 text-[11px] leading-5 text-muted"
            >
              {EMOJI[reaction.content]} {reaction.count}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
