import { MessageCircle, X } from "lucide-react";

import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import { cn } from "~/lib/utils";
import { useI18n } from "~/i18n";

interface ComposerPendingReviewCommentsProps {
  comments: ReadonlyArray<ReviewCommentContext>;
  onRemove: (commentId: string) => void;
  className?: string;
}

export function ComposerPendingReviewComments({
  comments,
  onRemove,
  className,
}: ComposerPendingReviewCommentsProps) {
  const { t } = useI18n();
  if (comments.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {comments.map((comment) => {
        const label = `${comment.filePath} ${comment.rangeLabel}`;
        const chip = (
          <span key={comment.id} className={cn(COMPOSER_INLINE_CHIP_CLASS_NAME, "pr-1")}>
            <MessageCircle className={cn(COMPOSER_INLINE_CHIP_ICON_CLASS_NAME, "size-3.5")} />
            <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{label}</span>
            <button
              type="button"
              aria-label={t("chat.review.removeComment", { label })}
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
