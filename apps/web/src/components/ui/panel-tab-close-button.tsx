import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

interface PanelTabCloseButtonProps {
  children: ReactNode;
  label: string;
  onClick: () => void;
  tooltip?: string;
  showOnPhone?: boolean;
}

export function PanelTabCloseButton({
  children,
  label,
  onClick,
  tooltip,
  showOnPhone = false,
}: PanelTabCloseButtonProps) {
  const button = (
    <button
      type="button"
      className="cursor-pointer group/close relative flex size-3.5 shrink-0 items-center justify-center rounded-sm outline-none hover:surface-ghost-hover focus-visible:inset-ring-2 focus-visible:inset-ring-ring"
      aria-label={label}
      onClick={onClick}
    >
      <span
        className={cn(
          "relative flex size-3.5 items-center justify-center group-hover/tab:hidden group-focus-visible/close:hidden",
          showOnPhone && "max-md:hidden",
        )}
      >
        {children}
      </span>
      <X
        className={cn(
          "hidden size-3 group-hover/tab:block group-focus-visible/close:block",
          showOnPhone && "max-md:block",
        )}
      />
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
