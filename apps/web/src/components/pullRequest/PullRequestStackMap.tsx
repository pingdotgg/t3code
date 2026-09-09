import type { PullRequestStack } from "@t3tools/contracts";
import { GitPullRequestArrowIcon } from "lucide-react";

import { InlineButton } from "../ui/button";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { resolvePullRequestState } from "./pullRequestPresentation";

/**
 * The host's stack as one line of layers, bottom to top, with this pull request marked. Mirrors
 * the map GitHub draws above a stacked pull request so a reader who came from there finds the
 * same shape here.
 */
export function PullRequestStackMap({
  stack,
  currentNumber,
  onSelect,
  className,
}: {
  stack: PullRequestStack;
  currentNumber: number;
  /** Opens another layer in the same panel; absent where the panel cannot swap references. */
  onSelect?: ((number: number) => void) | undefined;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1 overflow-x-auto text-[11px] text-muted-foreground",
        className,
      )}
      aria-label={`Stack ${stack.number} on ${stack.base}, ${stack.layers.length} layers`}
    >
      <Tooltip>
        <TooltipTrigger
          render={<span className="inline-flex shrink-0 items-center gap-1 font-mono" />}
        >
          <GitPullRequestArrowIcon aria-hidden className="size-3" />
          <code className="truncate">{stack.base}</code>
        </TooltipTrigger>
        <TooltipPopup side="top">
          Stack #{stack.number} on {stack.base}. Merging a layer lands every layer below it.
        </TooltipPopup>
      </Tooltip>
      {stack.layers.map((layer) => {
        const presentation = resolvePullRequestState({ state: layer.state, isDraft: false });
        const isCurrent = layer.number === currentNumber;
        const chip = (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0 font-mono tabular-nums",
              isCurrent
                ? "border-foreground/40 bg-accent text-foreground"
                : "border-border/70 hover:bg-accent/60",
            )}
          >
            <presentation.Icon aria-hidden className={cn("size-3", presentation.toneClassName)} />#
            {layer.number}
          </span>
        );
        return (
          <span key={layer.number} className="inline-flex shrink-0 items-center gap-1">
            <span aria-hidden className="text-muted-foreground/50">
              →
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  onSelect && !isCurrent ? (
                    <InlineButton onClick={() => onSelect(layer.number)} />
                  ) : (
                    <span aria-current={isCurrent ? "true" : undefined} />
                  )
                }
              >
                {chip}
              </TooltipTrigger>
              <TooltipPopup side="top">
                #{layer.number} · {layer.headBranch} · {presentation.label}
              </TooltipPopup>
            </Tooltip>
          </span>
        );
      })}
    </div>
  );
}
