import { Trans, Plural } from "@palamedes/react/macro";
import type { PullRequestReplyAvailability } from "./pullRequestDetail.logic";

export function PullRequestMoreReplies({
  moreReplies,
  hasMoreReplies,
  url,
}: PullRequestReplyAvailability) {
  if (!hasMoreReplies) return null;
  const moreRepliesToLocaleStringText = moreReplies > 0 ? moreReplies.toLocaleString() : undefined;

  return (
    <div className="flex flex-wrap items-baseline gap-2 py-1 text-xs text-muted-foreground">
      <span>
        {moreReplies > 0 ? (
          <Plural
            value={moreReplies}
            one={`${moreRepliesToLocaleStringText} more reply`}
            other={`${moreRepliesToLocaleStringText} more replies`}
          />
        ) : (
          <Trans>More replies</Trans>
        )}
      </span>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground hover:underline"
        >
          <Trans>View on host</Trans>
        </a>
      ) : null}
    </div>
  );
}
