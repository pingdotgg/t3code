import type { ReactNode } from "react";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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
            className={props.className}
            size="segmented"
            variant="segmented"
            onClick={props.onClick}
          />
        }
      >
        <span className="font-mono">{props.children}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}
