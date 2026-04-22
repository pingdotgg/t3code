import { MessageSquareIcon } from "lucide-react";
import {
  buildDiffContextCommentsPreviewTitle,
  formatDiffContextCommentLabel,
  type DiffContextCommentDraft,
} from "../../lib/diffContextComments";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ComposerDiffContextCommentInlineChip(props: { comment: DiffContextCommentDraft }) {
  const { comment } = props;
  const label = formatDiffContextCommentLabel(comment);
  const previewTitle = buildDiffContextCommentsPreviewTitle([comment]);

  return <DiffContextCommentInlineChip label={label} tooltipText={previewTitle ?? label} />;
}

export function DiffContextCommentInlineChip(props: { label: string; tooltipText: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={COMPOSER_INLINE_CHIP_CLASS_NAME} title={props.tooltipText}>
            <MessageSquareIcon className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
            <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{props.label}</span>
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-72 whitespace-pre-wrap leading-tight">
        {props.tooltipText}
      </TooltipPopup>
    </Tooltip>
  );
}
