import type { ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Keeps complete paths available when a compact review control truncates its label. */
export function ReviewPath({
  path,
  children,
  className,
}: {
  path: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={className} />}>{children ?? path}</TooltipTrigger>
      <TooltipPopup>
        <span className="break-all font-mono text-xs">{path}</span>
      </TooltipPopup>
    </Tooltip>
  );
}
