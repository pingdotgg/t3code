import type { ReactNode, Ref } from "react";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function DiffFileHeaderActionButton({
  ref,
  ariaLabel,
  children,
  disabled,
  onClick,
  tooltip,
}: {
  ref?: Ref<HTMLButtonElement>;
  ariaLabel: string;
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  tooltip: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={ref}
            size="icon-micro"
            variant="ghost"
            className="text-muted-foreground [:hover,[data-pressed]]:bg-transparent disabled:pointer-events-auto disabled:cursor-not-allowed"
            aria-label={ariaLabel}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>
        <p>{tooltip}</p>
      </TooltipPopup>
    </Tooltip>
  );
}
