import type { OrchestrationThreadGoal } from "@t3tools/contracts";
import { PauseIcon, PlayIcon, TargetIcon, XIcon } from "lucide-react";

import { formatGoalDuration, formatGoalTokens, goalStatusLabel } from "../goalPresentation";
import { cn } from "~/lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

function goalStatusClassName(status: OrchestrationThreadGoal["status"]): string {
  switch (status) {
    case "active":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-500";
    case "paused":
      return "border-amber-500/20 bg-amber-500/10 text-amber-500";
    case "budgetLimited":
      return "border-orange-500/20 bg-orange-500/10 text-orange-500";
    case "complete":
      return "border-blue-500/20 bg-blue-500/10 text-blue-500";
  }
}

export interface ThreadGoalPanelProps {
  goal: OrchestrationThreadGoal;
  commandDisabled?: boolean | null;
  onSubmitGoalCommand?: (command: "/goal pause" | "/goal resume" | "/goal clear") => void;
}

export function ThreadGoalPanel({
  goal,
  commandDisabled = false,
  onSubmitGoalCommand,
}: ThreadGoalPanelProps) {
  return (
    <div className="space-y-3 rounded-lg border border-border/60 bg-background/50 p-3">
      <div className="flex items-start gap-2">
        <TargetIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" />
        <div className="min-w-0 flex-1">
          <p
            className="line-clamp-2 text-[13px] leading-snug text-foreground/90"
            title={goal.objective}
          >
            {goal.objective}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge
              variant="outline"
              className={cn(
                "rounded-md px-1.5 py-0 text-[10px] font-semibold",
                goalStatusClassName(goal.status),
              )}
            >
              {goalStatusLabel(goal.status)}
            </Badge>
            <span className="text-[11px] text-muted-foreground/60">
              {formatGoalDuration(goal.timeUsedSeconds)}
            </span>
            <span className="text-[11px] text-muted-foreground/60">
              {formatGoalTokens(goal)} tokens
            </span>
          </div>
        </div>
      </div>

      {onSubmitGoalCommand ? (
        <div className="flex items-center gap-1.5">
          {goal.status === "paused" ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={Boolean(commandDisabled)}
              onClick={() => onSubmitGoalCommand("/goal resume")}
            >
              <PlayIcon className="size-3.5" />
              Resume
            </Button>
          ) : goal.status === "active" || goal.status === "budgetLimited" ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={Boolean(commandDisabled)}
              onClick={() => onSubmitGoalCommand("/goal pause")}
            >
              <PauseIcon className="size-3.5" />
              Pause
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={Boolean(commandDisabled)}
            onClick={() => onSubmitGoalCommand("/goal clear")}
          >
            <XIcon className="size-3.5" />
            Clear
          </Button>
        </div>
      ) : null}
    </div>
  );
}
