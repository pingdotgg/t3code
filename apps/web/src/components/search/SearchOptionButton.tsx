import type { ReactNode } from "react";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

export function SearchOptionButton(props: {
  readonly active: boolean;
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            aria-label={props.label}
            pressed={props.active}
            className={cn(
              "size-8 rounded-[5px] font-mono text-muted-foreground data-pressed:text-foreground sm:size-7",
              props.className,
            )}
            size="compact"
            variant="ghost"
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}
