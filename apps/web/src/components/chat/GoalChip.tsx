import type { OrchestrationThreadGoal } from "@t3tools/contracts";
import {
  formatGoalChipAriaLabel,
  formatGoalChipPrefix,
  goalChipActions,
  threadHasActiveGoal,
  type GoalChipAction,
} from "@t3tools/shared/composerTrigger";
import {
  BanIcon,
  CircleCheckIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  TargetIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { memo, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export type { GoalChipAction };

function goalStatusClass(status: string): string {
  if (status === "blocked") {
    return "text-destructive";
  }
  if (status === "usageLimited") {
    return "text-warning-foreground";
  }
  return "text-muted-foreground";
}

function GoalStatusIcon(props: {
  readonly goal: OrchestrationThreadGoal;
  readonly isWorking: boolean;
}) {
  const className = cn("size-3.5 shrink-0", goalStatusClass(props.goal.status));
  if (props.isWorking && props.goal.status === "active") {
    return (
      <Loader2Icon
        className={cn(
          className,
          "text-primary motion-safe:animate-spin motion-reduce:animate-none",
        )}
        aria-hidden="true"
      />
    );
  }
  switch (props.goal.status) {
    case "active":
      return <TargetIcon className={className} aria-hidden="true" />;
    case "paused":
      return <PauseIcon className={className} aria-hidden="true" />;
    case "blocked":
      return <BanIcon className={className} aria-hidden="true" />;
    case "usageLimited":
      return <TriangleAlertIcon className={className} aria-hidden="true" />;
    case "complete":
      return <CircleCheckIcon className={className} aria-hidden="true" />;
    default:
      return <TargetIcon className={className} aria-hidden="true" />;
  }
}

export const GoalActiveMarker = memo(function GoalActiveMarker({
  goal,
}: {
  readonly goal: { readonly status: string } | null | undefined;
}) {
  if (!threadHasActiveGoal(goal)) {
    return null;
  }
  return (
    <span
      data-goal-active
      className="shrink-0 text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground"
    >
      Active
    </span>
  );
});

function GoalChipIconButton(props: {
  readonly action: GoalChipAction;
  readonly label: string;
  readonly onAction: (action: GoalChipAction) => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            data-goal-chip-action={props.action}
            aria-label={props.label}
            onPointerDown={(event) => {
              // Keep composer focus; the action runs without stealing it.
              event.preventDefault();
            }}
            onClick={() => {
              props.onAction(props.action);
            }}
          >
            {props.children}
          </Button>
        }
      />
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Objective pill. The text loads the Goal back into the composer for editing
 * (re-sending `/goal …` replaces the current one); the trailing icons pause,
 * resume, or delete it in place.
 */
export const GoalChip = memo(function GoalChip({
  goal,
  onAction,
  onEdit,
  isWorking = false,
}: {
  readonly goal: OrchestrationThreadGoal | null | undefined;
  readonly onAction?: ((action: GoalChipAction) => void) | undefined;
  readonly onEdit?: ((objective: string) => void) | undefined;
  readonly isWorking?: boolean;
}) {
  if (goal == null) {
    return null;
  }
  const actions = goalChipActions(goal.status);
  const showWorking = isWorking && threadHasActiveGoal(goal);
  const label = formatGoalChipAriaLabel(goal, { isWorking: showWorking });

  return (
    <span
      data-goal-chip
      role="group"
      aria-label={label}
      className={cn(
        "inline-flex max-w-[min(100%,20rem)] shrink-0 items-center gap-1.5 rounded-full border bg-popover px-2.5 py-0.5 text-xs shadow-sm",
        "border-border/70 text-muted-foreground",
      )}
    >
      <GoalStatusIcon goal={goal} isWorking={showWorking} />
      {onEdit !== undefined ? (
        <button
          type="button"
          data-goal-chip-edit
          aria-label={`Edit Goal: ${goal.objective}`}
          className={cn(
            "inline-flex min-w-0 cursor-pointer items-baseline gap-1 rounded-sm text-left",
            "hover:text-foreground",
            "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
          )}
          onPointerDown={(event) => {
            // Keep composer focus; the edit lands in the prompt.
            event.preventDefault();
          }}
          onClick={() => {
            onEdit(goal.objective);
          }}
        >
          <span className="shrink-0 font-medium">{formatGoalChipPrefix(goal.status)}:</span>
          <span className="truncate">{goal.objective}</span>
        </button>
      ) : (
        <span className="inline-flex min-w-0 items-baseline gap-1">
          <span className="shrink-0 font-medium">{formatGoalChipPrefix(goal.status)}:</span>
          <span className="truncate">{goal.objective}</span>
        </span>
      )}
      {onAction !== undefined && actions.includes("pause") ? (
        <GoalChipIconButton action="pause" label="Pause Goal" onAction={onAction}>
          <PauseIcon className="size-3" aria-hidden="true" />
        </GoalChipIconButton>
      ) : null}
      {onAction !== undefined && actions.includes("resume") ? (
        <GoalChipIconButton action="resume" label="Resume Goal" onAction={onAction}>
          <PlayIcon className="size-3" aria-hidden="true" />
        </GoalChipIconButton>
      ) : null}
      {onAction !== undefined && actions.includes("clear") ? (
        <GoalChipIconButton action="clear" label="Delete Goal" onAction={onAction}>
          <XIcon className="size-3" aria-hidden="true" />
        </GoalChipIconButton>
      ) : null}
    </span>
  );
});
