import type { ScopedThreadRef } from "@t3tools/contracts";
import { T, useGT } from "gt-react";

import { useOpenLink } from "~/browser/useOpenLink";
import { InlineButton } from "../ui/button";

import type { PullRequestReplyAvailability } from "./pullRequestDetail.logic";

export function PullRequestMoreReplies({
  moreReplies,
  hasMoreReplies,
  url,
  threadRef,
}: PullRequestReplyAvailability & { threadRef: ScopedThreadRef | null }) {
  const gt = useGT();
  const openLink = useOpenLink(threadRef);
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
          onClick={(event) => {
            event.preventDefault();
            void openLink(url, { event }).catch(console.error);
          }}
        >
          <T>View on host</T>
        </InlineButton>
      ) : null}
    </div>
  );
}
