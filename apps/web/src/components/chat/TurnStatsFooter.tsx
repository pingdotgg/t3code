import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type AssistantTurnStats } from "../../lib/turnStats";

export function TurnStatsFooter(props: { stats: AssistantTurnStats }) {
  return (
    <div
      aria-label={`Assistant turn stats: ${props.stats.summaryLabel}`}
      className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] leading-4 text-muted-foreground/45"
      data-assistant-turn-stats="true"
    >
      {props.stats.items.map((item, index) => (
        <span key={item.id} className="inline-flex items-center gap-x-1.5">
          {index > 0 ? <span aria-hidden="true">·</span> : null}
          {item.tooltip ? (
            <Tooltip>
              <TooltipTrigger
                className="cursor-help decoration-dotted underline-offset-2 focus-visible:outline-none"
                title={item.tooltip}
              >
                {item.label}
              </TooltipTrigger>
              <TooltipPopup className="max-w-72">
                <p className="text-xs leading-4">{item.tooltip}</p>
              </TooltipPopup>
            </Tooltip>
          ) : (
            <span>{item.label}</span>
          )}
        </span>
      ))}
    </div>
  );
}
