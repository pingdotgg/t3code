import type { ThreadGoal } from "@t3tools/contracts";
import { PauseIcon, PencilIcon, PlayIcon, TargetIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

const compactNumber = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

const statusLabels: Record<ThreadGoal["status"], string> = {
  active: "Active",
  paused: "Paused",
  blocked: "Blocked",
  usageLimited: "Usage limit",
  budgetLimited: "Budget limit",
  complete: "Complete",
};

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
}

export function GoalProgressRow(props: {
  goal: ThreadGoal;
  pending: boolean;
  onPause: () => void;
  onResume: () => void;
  onEdit: () => void;
  onClear: () => void;
  className?: string;
}) {
  const { goal } = props;
  const usage = [
    goal.tokenBudget === null
      ? goal.tokensUsed > 0
        ? `${compactNumber.format(goal.tokensUsed)} tokens`
        : null
      : `${compactNumber.format(goal.tokensUsed)} / ${compactNumber.format(goal.tokenBudget)} tokens`,
    goal.timeUsedSeconds > 0 ? formatDuration(goal.timeUsedSeconds) : null,
  ].filter((value): value is string => value !== null);

  return (
    <div className={cn("relative z-0 mx-auto w-full max-w-3xl pb-2", props.className)}>
      <div
        className="flex min-h-10 items-center gap-2 rounded-xl border border-border/70 bg-background/92 px-2.5 py-1.5 shadow-xs backdrop-blur-sm"
        aria-live="polite"
      >
        <TargetIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 text-[11px] font-semibold text-foreground">
              {statusLabels[goal.status]}
            </span>
            <span className="truncate text-xs text-muted-foreground" title={goal.objective}>
              {goal.objective}
            </span>
          </div>
          {usage.length > 0 ? (
            <div className="truncate text-[10px] text-muted-foreground/70">{usage.join(" · ")}</div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {goal.status === "active" ? (
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={props.pending}
              aria-label="Pause goal"
              title="Pause goal"
              onClick={props.onPause}
            >
              <PauseIcon />
            </Button>
          ) : goal.status === "paused" ? (
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={props.pending}
              aria-label="Resume goal"
              title="Resume goal"
              onClick={props.onResume}
            >
              <PlayIcon />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={props.pending}
            aria-label="Edit goal"
            title="Edit goal"
            onClick={props.onEdit}
          >
            <PencilIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={props.pending}
            aria-label="Clear goal"
            title="Clear goal"
            onClick={props.onClear}
          >
            <XIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}
