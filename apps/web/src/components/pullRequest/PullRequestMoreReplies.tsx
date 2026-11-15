import type { PullRequestReplyAvailability } from "./pullRequestDetail.logic";

import { translateDynamic } from "../../i18nCore";

const td = (key: string, options?: Record<string, unknown>) =>
  translateDynamic(`pullRequest:${key}`, options);

export function PullRequestMoreReplies({
  moreReplies,
  hasMoreReplies,
  url,
}: PullRequestReplyAvailability) {
  if (!hasMoreReplies) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-2 py-1 text-xs text-muted-foreground">
      <span>
        {moreReplies > 0
          ? `${moreReplies.toLocaleString()} more ${moreReplies === 1 ? "reply" : "replies"}`
          : "More replies"}
      </span>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground hover:underline"
        >
          {td("replies.viewOnHost")}
        </a>
      ) : null}
    </div>
  );
}
