import { FileTextIcon } from "lucide-react";

import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The report a message carries, as a pill. The agent reads the whole report;
 * the reader gets its title, and the beginning of what was sent on hover.
 */
export function ReportContextInlineChip({
  title,
  markdown,
}: {
  readonly title: string;
  readonly markdown: string;
}) {
  // A report runs to thousands of words. The tooltip is a reminder of what
  // travelled, not a reader for it — the report's own page is that.
  const preview = markdown.length > 600 ? `${markdown.slice(0, 600).trimEnd()}…` : markdown;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={COMPOSER_INLINE_CHIP_CLASS_NAME}>
            <FileTextIcon className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
            <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{title}</span>
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
        {preview}
      </TooltipPopup>
    </Tooltip>
  );
}
