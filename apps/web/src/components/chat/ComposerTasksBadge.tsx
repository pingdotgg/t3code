import { ChevronDownIcon, ListTodoIcon, XIcon } from "lucide-react";
import { memo } from "react";

import { formatDuration } from "../../session-logic";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

export interface ComposerTasksProgress {
  readonly step: string;
  readonly completedSteps: number;
  readonly totalSteps: number;
}

export interface ComposerTaskStep {
  readonly durationMs?: number;
  readonly step: string;
  readonly status: "pending" | "inProgress" | "completed";
}

const MAX_TASK_SEGMENTS = 10;

function keyedTaskSteps(steps: readonly ComposerTaskStep[]) {
  const occurrences = new Map<string, number>();
  return steps.map((step) => {
    const occurrence = occurrences.get(step.step) ?? 0;
    occurrences.set(step.step, occurrence + 1);
    return { key: `${step.step}:${occurrence}`, step };
  });
}

function TaskSegments({
  className,
  steps,
}: {
  readonly className?: string;
  readonly steps: readonly ComposerTaskStep[];
}) {
  if (steps.length <= 1 || steps.length > MAX_TASK_SEGMENTS) return null;

  return (
    <span aria-hidden className={cn("flex w-10 shrink-0 items-center gap-0.5", className)}>
      {keyedTaskSteps(steps).map(({ key, step }) => (
        <span
          key={key}
          className={cn(
            "h-[3px] min-w-0 flex-1 rounded-full",
            step.status === "completed"
              ? "bg-success"
              : step.status === "inProgress"
                ? "bg-primary"
                : "bg-muted-foreground/25",
          )}
        />
      ))}
    </span>
  );
}

export const ComposerTasksBadge = memo(function ComposerTasksBadge({
  expanded,
  hasTrailingShoulder = false,
  onDismiss,
  onToggle,
  placement = "tab",
  progress,
  steps,
}: {
  readonly expanded: boolean;
  readonly hasTrailingShoulder?: boolean;
  readonly onDismiss: () => void;
  readonly onToggle: () => void;
  readonly placement?: "inline" | "tab";
  readonly progress: ComposerTasksProgress;
  readonly steps: readonly ComposerTaskStep[];
}) {
  if (progress.totalSteps <= 0) return null;

  const allDone = progress.completedSteps >= progress.totalSteps;
  const label = `Tasks: ${progress.completedSteps} of ${progress.totalSteps} complete. Current task: ${progress.step}`;
  if (placement === "inline") {
    return (
      <span className="inline-flex shrink-0 items-center gap-0.5" data-composer-tasks-badge="true">
        <Button
          size="micro"
          variant="ghost-muted"
          aria-expanded={expanded}
          aria-label={label}
          className="shrink-0 gap-1 px-1.5"
          onClick={onToggle}
          onPointerDown={(event) => event.preventDefault()}
        >
          <ListTodoIcon aria-hidden className="size-3 shrink-0" />
          <span>Tasks</span>
          <TaskSegments steps={steps} />
          <span
            className={cn(
              "font-medium tabular-nums",
              allDone ? "text-success" : "text-muted-foreground",
            )}
          >
            {progress.completedSteps}/{progress.totalSteps}
          </span>
        </Button>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          aria-label="Dismiss tasks for this turn"
          className="shrink-0"
          onClick={onDismiss}
          onPointerDown={(event) => event.preventDefault()}
        >
          <XIcon aria-hidden className="size-2.5" />
        </Button>
      </span>
    );
  }

  return (
    <div
      className={cn(
        "chat-composer-shoulder-tab chat-composer-tasks-tab absolute -top-7 left-5.5 z-0 flex h-8 items-center gap-1 rounded-t-xl border border-b-0 px-2 pb-1 text-xs leading-none text-muted-foreground",
        hasTrailingShoulder ? "right-30" : "right-5.5",
        allDone && "text-foreground",
      )}
      data-composer-tasks-badge="true"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={label}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch text-muted-foreground hover:text-foreground"
        onClick={onToggle}
        onPointerDown={(event) => event.preventDefault()}
      >
        <ListTodoIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="shrink-0">Tasks</span>
        <span
          className="min-w-0 flex-1 truncate text-left font-medium text-foreground/80"
          data-composer-task-current="true"
        >
          {progress.step}
        </span>
        <span
          className={cn(
            "shrink-0 font-medium tabular-nums",
            allDone ? "text-success" : "text-muted-foreground",
          )}
        >
          {progress.completedSteps}/{progress.totalSteps}
        </span>
        <TaskSegments className="w-20" steps={steps} />
      </button>
      <Button
        size="icon-micro"
        variant="ghost-muted"
        aria-label="Dismiss tasks for this turn"
        className="shrink-0"
        onClick={onDismiss}
        onPointerDown={(event) => event.preventDefault()}
      >
        <XIcon aria-hidden className="size-3" />
      </Button>
    </div>
  );
});

export const ComposerTasksDrawer = memo(function ComposerTasksDrawer({
  onDismiss,
  onCollapse,
  progress,
  steps,
}: {
  readonly onDismiss: () => void;
  readonly onCollapse: () => void;
  readonly progress: ComposerTasksProgress;
  readonly steps: readonly ComposerTaskStep[];
}) {
  return (
    <div
      className="chat-composer-top-drawer"
      data-chat-composer-collapsed-controls="true"
      data-chat-composer-tasks-drawer="true"
    >
      <div className="flex items-center gap-1 px-3 py-1.5 sm:px-4">
        <button
          type="button"
          aria-expanded="true"
          aria-label={`Collapse tasks. ${progress.completedSteps} of ${progress.totalSteps} complete.`}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch text-left text-xs text-muted-foreground hover:text-foreground"
          onClick={onCollapse}
          onPointerDown={(event) => event.preventDefault()}
        >
          <ListTodoIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="font-medium text-foreground">Tasks</span>
          <span className="tabular-nums">
            {progress.completedSteps}/{progress.totalSteps}
          </span>
          <ChevronDownIcon aria-hidden className="ml-auto size-3.5 shrink-0" />
        </button>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          aria-label="Dismiss tasks for this turn"
          className="shrink-0"
          onClick={onDismiss}
          onPointerDown={(event) => event.preventDefault()}
        >
          <XIcon aria-hidden className="size-3" />
        </Button>
      </div>
      <div
        aria-label={`Task list. ${progress.completedSteps} of ${progress.totalSteps} complete.`}
        className="max-h-[min(24rem,40dvh)] space-y-px overflow-y-auto overscroll-contain px-3 pb-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 sm:px-4"
        data-composer-tasks-list="true"
        role="list"
        tabIndex={0}
      >
        {keyedTaskSteps(steps).map(({ key, step }) => (
          <div key={key} className="flex items-baseline gap-2 text-xs leading-5" role="listitem">
            <span
              aria-hidden
              className={cn(
                "w-3 shrink-0 text-center font-mono text-[10px]",
                step.status === "completed"
                  ? "text-success"
                  : step.status === "inProgress"
                    ? "text-primary"
                    : "text-muted-foreground/40",
              )}
            >
              {step.status === "completed" ? "✓" : step.status === "inProgress" ? "●" : "○"}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1",
                step.status === "completed"
                  ? "text-muted-foreground/55"
                  : step.status === "inProgress"
                    ? "text-foreground/90"
                    : "text-muted-foreground/70",
              )}
            >
              {step.step}
            </span>
            <span
              className="ml-auto w-10 shrink-0 text-right text-[10px] text-muted-foreground/45 tabular-nums"
              data-composer-task-duration="true"
            >
              {step.durationMs !== undefined
                ? formatDuration(step.durationMs)
                : step.status === "inProgress"
                  ? "now"
                  : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
});
