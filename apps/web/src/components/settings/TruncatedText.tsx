import { useRef } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * One line of text that ends in an ellipsis when it doesn't fit, with the
 * whole text in a tooltip on hover. The fit is checked as the tooltip opens,
 * so a line that fits never shows one and long lists measure nothing until
 * hovered.
 */
export function TruncatedText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  return (
    <Tooltip
      onOpenChange={(open, details) => {
        const element = ref.current;
        if (open && element !== null && element.scrollWidth <= element.clientWidth) {
          details.cancel();
        }
      }}
    >
      <TooltipTrigger render={<span ref={ref} className={cn("block truncate", className)} />}>
        {text}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-sm">
        {text}
      </TooltipPopup>
    </Tooltip>
  );
}
