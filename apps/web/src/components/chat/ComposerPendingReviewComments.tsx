import { MessageCircle, X } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { pullRequestContextUrl, type ReviewCommentContext } from "~/reviewCommentContext";
import { cn } from "~/lib/utils";

interface ComposerPendingReviewCommentsProps {
  comments: ReadonlyArray<ReviewCommentContext>;
  onRemove: (commentId: string) => void;
  onOpenPullRequest?: (event: ReactMouseEvent<HTMLElement>, url: string) => void;
  className?: string;
}

/** Renders review-context chips attached to the pending composer draft. */
export function ComposerPendingReviewComments({
  comments,
  onRemove,
  onOpenPullRequest,
  className,
}: ComposerPendingReviewCommentsProps) {
  if (comments.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {comments.map((comment) => {
        const label = `${comment.filePath} ${comment.rangeLabel}`;
        const pullRequestUrl = pullRequestContextUrl(comment);
        const canOpenPullRequest = pullRequestUrl !== null && onOpenPullRequest !== undefined;
        const chip = (
          <span key={comment.id} className={cn(COMPOSER_INLINE_CHIP_CLASS_NAME, "pr-1")}>
            {canOpenPullRequest ? (
              <Button
                size="chip"
                variant="chip"
                aria-label={`Open ${comment.filePath} in the pull request panel`}
                className="max-w-full"
                onClick={(event) => onOpenPullRequest(event, pullRequestUrl)}
              >
                <MessageCircle className={cn(COMPOSER_INLINE_CHIP_ICON_CLASS_NAME, "size-3.5")} />
                <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{label}</span>
              </Button>
            ) : (
              <>
                <MessageCircle className={cn(COMPOSER_INLINE_CHIP_ICON_CLASS_NAME, "size-3.5")} />
                <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{label}</span>
              </>
            )}
            <button
              type="button"
              aria-label={`Remove comment on ${label}`}
              className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRemove(comment.id);
              }}
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        );
        if (comment.text.length === 0) return chip;
        return (
          <Tooltip key={comment.id}>
            <TooltipTrigger render={chip} />
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
              {comment.text}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
