import type { PullRequestReplyAvailability } from "./pullRequestDetail.logic";

import { useT } from "~/hooks/useI18n";
export function PullRequestMoreReplies({
  moreReplies,
  hasMoreReplies,
  url,
}: PullRequestReplyAvailability) {
  const t = useT();
  if (!hasMoreReplies) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-2 py-1 text-xs text-muted-foreground">
      <span>
        {moreReplies > 0
          ? `${moreReplies.toLocaleString()} more ${moreReplies === 1 ? "reply" : "replies"}`
          : t("review.extra.more.replies")}
      </span>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground hover:underline"
        >
          {t("review.extra.view.on.host")}
        </a>
      ) : null}
    </div>
  );
}
