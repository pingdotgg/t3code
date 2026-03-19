import { TerminalIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface TerminalContextInlineChipProps {
  label: string;
  tooltipText: string;
  expired?: boolean;
}

export function TerminalContextInlineChip(props: TerminalContextInlineChipProps) {
  const { label, tooltipText, expired = false } = props;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              COMPOSER_INLINE_CHIP_CLASS_NAME,
              expired && "border-destructive/35 bg-destructive/8 text-destructive",
            )}
            data-terminal-context-expired={expired ? "true" : undefined}
          >
            <TerminalIcon
              className={cn(
                COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
                "size-3.5",
                expired && "opacity-100",
              )}
            />
            <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{label}</span>
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-80 whitespace-pre-wrap leading-tight">
        {tooltipText}
      </TooltipPopup>
    </Tooltip>
  );
}
