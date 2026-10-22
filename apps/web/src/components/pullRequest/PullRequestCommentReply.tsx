import type { PullRequestCommentReplyContext } from "@t3tools/client-runtime/pull-request-comment-replies";
import { CornerDownRightIcon } from "lucide-react";

export function PullRequestCommentReply({
  reply,
}: {
  reply: PullRequestCommentReplyContext | undefined;
}) {
  if (reply === undefined) return null;
  return (
    <div className="mt-2 flex min-w-0 gap-2 border-l-2 border-border pl-2 text-xs text-muted-foreground">
      <CornerDownRightIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
      <div className="min-w-0">
        <p className="truncate font-medium">Reply to {reply.author}</p>
        <p className="truncate">{reply.excerpt}</p>
      </div>
    </div>
  );
}
