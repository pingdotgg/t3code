import type { OrchestrationV2PlanStep } from "@t3tools/contracts";
import { CheckIcon, CircleDotIcon, CircleIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { formatDuration, type TaskListPlan } from "../../session-logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const STATUS_LABEL = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
} satisfies Record<OrchestrationV2PlanStep["status"], string>;

/** The agent's latest task list; a short card keeps only the current step. */
export function ThreadDetailsTasks({
  plan,
  compact,
}: {
  readonly plan: TaskListPlan;
  readonly compact: boolean;
}) {
  const done = plan.steps.filter((step) => step.status === "completed").length;
  const current =
    plan.steps.find((step) => step.status === "running") ??
    plan.steps.find((step) => step.status === "pending");
  const count = (
    <span
      className={cn(
        "text-2xs font-medium tabular-nums",
        done === plan.steps.length ? "text-success-foreground" : "text-muted-foreground",
      )}
    >
      {done}/{plan.steps.length}
    </span>
  );

  if (compact) {
    return (
      <ThreadDetailsSection
        headingId="thread-details-tasks-heading"
        title="Tasks"
        showHeading={false}
      >
        <div className="flex h-6 min-w-0 items-center gap-2 px-2.5 text-xs">
          <span className="shrink-0 text-muted-foreground">Tasks</span>
          <span className="min-w-0 flex-1 truncate text-foreground/80">
            {current?.text ?? "All done"}
          </span>
          {count}
        </div>
      </ThreadDetailsSection>
    );
  }

  return (
    <ThreadDetailsSection headingId="thread-details-tasks-heading" title="Tasks" actions={count}>
      <ul className="flex max-h-48 flex-col overflow-y-auto text-xs">
        {plan.steps.map((step) => (
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
              <span className="sr-only">{STATUS_LABEL[step.status]}: </span>
              {step.text}
            </span>
            {step.durationMs !== undefined ? (
              <span className="shrink-0 text-3xs/4 text-muted-foreground/50 tabular-nums">
                {formatDuration(step.durationMs)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}
