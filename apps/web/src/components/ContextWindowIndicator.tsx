import type { OrchestrationContextWindow } from "@t3tools/contracts";

import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  formatCompactTokenCount,
  resolveContextWindowSeverity,
} from "./ContextWindowIndicator.logic";
import { cn } from "~/lib/utils";

function tokenBreakdown(contextWindow: OrchestrationContextWindow): string | null {
  const parts = [
    contextWindow.inputTokens !== undefined
      ? `Input ${formatCompactTokenCount(contextWindow.inputTokens)}`
      : null,
    contextWindow.cachedInputTokens !== undefined
      ? `cached ${formatCompactTokenCount(contextWindow.cachedInputTokens)}`
      : null,
    contextWindow.outputTokens !== undefined
      ? `output ${formatCompactTokenCount(contextWindow.outputTokens)}`
      : null,
    contextWindow.reasoningOutputTokens !== undefined
      ? `reasoning ${formatCompactTokenCount(contextWindow.reasoningOutputTokens)}`
      : null,
  ].filter((value): value is string => value !== null);

  return parts.length > 0 ? parts.join(", ") : null;
}

export default function ContextWindowIndicator(props: {
  contextWindow: OrchestrationContextWindow;
}) {
  const { contextWindow } = props;
  const remainingPercent = Math.max(0, 100 - contextWindow.usedPercent);
  const severity = resolveContextWindowSeverity(contextWindow.usedPercent);
  const badgeClassName =
    severity === "danger"
      ? "border-destructive/28 bg-destructive/8 text-destructive-foreground hover:bg-destructive/12"
      : severity === "warning"
        ? "border-warning/28 bg-warning/8 text-warning-foreground hover:bg-warning/12"
        : "border-border/70 bg-background text-muted-foreground hover:bg-accent hover:text-foreground";
  const breakdown = tokenBreakdown(contextWindow);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Context window usage"
            className={cn(
              "inline-flex h-8 items-center rounded-full border px-2.5 text-xs font-medium transition-colors sm:h-7",
              badgeClassName,
            )}
          >
            {contextWindow.usedPercent}%
          </button>
        }
      />
      <TooltipPopup side="top" align="end" className="max-w-72 whitespace-normal px-0 py-0">
        <div className="space-y-1.5 px-3 py-2.5 leading-tight">
          <p className="font-medium text-foreground">Context window</p>
          <p>
            {contextWindow.usedPercent}% used ({remainingPercent}% left)
          </p>
          <p>
            {formatCompactTokenCount(contextWindow.usedTokens)} /{" "}
            {formatCompactTokenCount(contextWindow.maxTokens)} tokens used
          </p>
          {breakdown ? <p className="text-muted-foreground">{breakdown}</p> : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
