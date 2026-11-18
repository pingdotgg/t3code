import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

interface PanelTabCloseButtonProps {
  /** The tab's icon, swapped for the X while the tab is hovered. Omit to always show the X. */
  children?: ReactNode;
  label: string;
  onClick: () => void;
  tooltip?: string;
}

export function PanelTabCloseButton({
  children,
  label,
  onClick,
  tooltip,
}: PanelTabCloseButtonProps) {
  const alwaysVisible = children === undefined;
  const button = (
    <button
      type="button"
      className={cn(
        "cursor-pointer group/close relative flex size-4 shrink-0 items-center justify-center rounded-sm",
        // An always visible X follows the tab's own colour and hover, so the tab reads as one unit.
        !alwaysVisible && "hover:bg-muted",
      )}
      aria-label={label}
      onClick={onClick}
    >
      {alwaysVisible ? (
        <X className="size-3" />
      ) : (
        <>
          <span className="relative flex size-3 items-center justify-center group-hover/tab:hidden group-focus-visible/close:hidden">
            {children}
          </span>
          <X className="hidden size-3 group-hover/tab:block group-focus-visible/close:block" />
        </>
      )}
    </button>
  );

  if (!tooltip) return button;

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
