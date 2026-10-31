import { InlineButton } from "../ui/button";

import type { PullRequestReplyAvailability } from "./pullRequestDetail.logic";

export function PullRequestMoreReplies({
  moreReplies,
  hasMoreReplies,
  url,
}: PullRequestReplyAvailability) {
  if (!hasMoreReplies) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-2 py-1 text-meta text-muted-foreground">
      <span>
        {moreReplies > 0
          ? `${moreReplies.toLocaleString()} more ${moreReplies === 1 ? "reply" : "replies"}`
          : "More replies"}
      </span>
      {url ? (
        <InlineButton
          tone="muted"
          render={<a href={url} target="_blank" rel="noopener noreferrer" />}
        >
          View on host
        </InlineButton>
      ) : null}
    </div>
  );
}
