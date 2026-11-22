import { T, useGT } from "gt-react";

import { InlineButton } from "../ui/button";

import type { PullRequestReplyAvailability } from "./pullRequestDetail.logic";

export function PullRequestMoreReplies({
  moreReplies,
  hasMoreReplies,
  url,
}: PullRequestReplyAvailability) {
  const gt = useGT();
  if (!hasMoreReplies) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-2 py-1 text-meta text-muted-foreground">
      <span>
        {moreReplies > 0
          ? gt("{count, plural, one {{formatted} more reply} other {{formatted} more replies}}", {
              count: moreReplies,
              formatted: moreReplies.toLocaleString(),
            })
          : gt("More replies")}
      </span>
      {url ? (
        <InlineButton
          tone="muted"
          render={<a href={url} target="_blank" rel="noopener noreferrer" />}
        >
          <T>View on host</T>
        </InlineButton>
      ) : null}
    </div>
  );
}
