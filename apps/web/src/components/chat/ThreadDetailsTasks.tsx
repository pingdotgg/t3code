import type { OrchestrationV2PlanStep } from "@t3tools/contracts";
import { taskListProgress } from "@t3tools/client-runtime/state/thread-execution";
import { CheckIcon, ChevronDownIcon, CircleDotIcon, CircleIcon } from "lucide-react";
import { msg, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";
import { type TaskListPlan } from "../../session-logic";
import { Button } from "../ui/button";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const STATUS_LABEL = {
  pending: msg("Pending"),
  running: msg("Running"),
  completed: msg("Completed"),
} satisfies Record<OrchestrationV2PlanStep["status"], ReturnType<typeof msg>>;

/** The agent's latest task list; collapsed, or in a short card, it keeps only the current step. */
export function ThreadDetailsTasks({
  plan,
  compact,
}: {
  readonly plan: TaskListPlan;
  readonly compact: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const [expanded, setExpanded] = useState(false);
  const { completed: done, percentage } = taskListProgress(plan.steps);
  const current =
    plan.steps.find((step) => step.status === "running") ??
    plan.steps.find((step) => step.status === "pending");
  const count = (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 text-2xs font-medium tabular-nums",
        done === plan.steps.length ? "text-success-foreground" : "text-muted-foreground",
      )}
    >
      <svg
        role="progressbar"
        aria-label={gt("Tasks")}
        aria-valuemin={0}
        aria-valuemax={plan.steps.length}
        aria-valuenow={done}
        viewBox="0 0 16 16"
        className="size-3.5 shrink-0 -rotate-90"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="8" cy="8" r="6" className="opacity-20" />
        <circle cx="8" cy="8" r="6" pathLength="100" strokeDasharray={`${percentage} 100`} />
      </svg>
      <span>{percentage}%</span>
      <span>
        {done}/{plan.steps.length}
      </span>
    </span>
  );

  if (compact) {
    return (
      <ThreadDetailsSection
        headingId="thread-details-tasks-heading"
        title={gt("Tasks")}
        showHeading={false}
      >
        <div className="flex h-6 min-w-0 items-center gap-2 px-2.5 text-xs">
          <span className="shrink-0 text-muted-foreground">{gt("Tasks")}</span>
          <span className="min-w-0 flex-1 truncate text-foreground/80">
            {current?.text ?? gt("All done")}
          </span>
          {count}
        </div>
      </ThreadDetailsSection>
    );
  }

  return (
    <ThreadDetailsSection
      headingId="thread-details-tasks-heading"
      title={gt("Tasks")}
      actions={
        <Button
          variant="ghost-muted"
          size="micro"
          aria-expanded={expanded}
          aria-label={
            expanded
              ? gt("Collapse tasks, {done} of {total} completed", {
                  done,
                  total: plan.steps.length,
                })
              : gt("Expand tasks, {done} of {total} completed", {
                  done,
                  total: plan.steps.length,
                })
          }
          onClick={() => setExpanded((value) => !value)}
        >
          {count}
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3 shrink-0 transition-transform", !expanded && "-rotate-90")}
          />
        </Button>
      }
    >
      <ul data-thread-details-task-list className="flex max-h-48 flex-col overflow-y-auto text-xs">
        {!expanded && !current ? (
          <li className="px-2.5 py-1 text-muted-foreground/60">{gt("All done")}</li>
        ) : null}
        {(expanded ? plan.steps : current ? [current] : []).map((step) => (
          <li key={step.id} className="flex min-w-0 items-start gap-2 px-2.5 py-1">
            <span
              aria-hidden
              className={cn(
                "flex h-4 shrink-0 items-center [&>svg]:size-3.5",
                step.status === "completed"
                  ? "text-success"
                  : step.status === "running"
                    ? "text-primary"
                    : "text-muted-foreground/40",
              )}
            >
              {step.status === "completed" ? (
                <CheckIcon />
              ) : step.status === "running" ? (
                <CircleDotIcon />
              ) : (
                <CircleIcon />
              )}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 wrap-anywhere",
                step.status === "completed"
                  ? "text-muted-foreground/60"
                  : step.status === "running"
                    ? "text-foreground/90"
                    : "text-muted-foreground",
              )}
            >
              <span className="sr-only">{m(STATUS_LABEL[step.status])}: </span>
              {step.text}
            </span>
            {step.durationMs !== undefined ? (
              <span className="shrink-0 text-3xs/4 text-muted-foreground/50 tabular-nums">
                {formatDuration(step.durationMs, m)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}
