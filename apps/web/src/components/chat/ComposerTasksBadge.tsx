import { CheckIcon, ChevronDownIcon, ListTodoIcon } from "lucide-react";
import { useState } from "react";

import type { ActivePlanState } from "../../session-logic";
import { cn } from "~/lib/utils";

type TaskStep = ActivePlanState["steps"][number];

const statusLabels = {
  pending: "Pending",
  inProgress: "Running",
  completed: "Completed",
} satisfies Record<TaskStep["status"], string>;

export function ComposerTasksBadge({ steps }: { steps: readonly TaskStep[] }) {
  const [expanded, setExpanded] = useState(false);
  const completed = steps.filter((step) => step.status === "completed").length;
  const current =
    steps.find((step) => step.status === "inProgress") ??
    steps.find((step) => step.status === "pending");
  const occurrences = new Map<string, number>();
  const keyedSteps = steps.map((step) => {
    const occurrence = occurrences.get(step.step) ?? 0;
    occurrences.set(step.step, occurrence + 1);
    return { key: `${step.step}:${occurrence}`, step };
  });

  if (!current) return null;

  return (
    <section
      data-composer-tasks="true"
      className="relative z-0 mx-1.5 -mb-3 min-w-0 rounded-t-2xl border border-border/70 bg-card pb-3 text-sm shadow-sm sm:mx-3"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`Tasks: ${completed} of ${steps.length} complete. Current task: ${current.step}`}
        onClick={() => setExpanded((value) => !value)}
        onPointerDown={(event) => event.preventDefault()}
        className="flex min-h-10 w-full min-w-0 items-center gap-2.5 rounded-t-2xl px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4"
      >
        <ListTodoIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">Tasks</span>
        <span className="min-w-0 flex-1 truncate font-medium text-foreground/85">
          {current.step}
        </span>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {completed}/{steps.length} complete
        </span>
        {steps.length > 1 && steps.length <= 10 ? (
          <span aria-hidden className="hidden w-20 shrink-0 items-center gap-0.5 sm:flex">
            {keyedSteps.map(({ key, step }) => (
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
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn("size-4 shrink-0 text-muted-foreground", !expanded && "rotate-180")}
        />
      </button>
      {expanded ? (
        <ul
          aria-label={`Task list. ${completed} of ${steps.length} complete.`}
          className="max-h-[min(24rem,40dvh)] overflow-y-auto px-3 pb-1 sm:px-4"
        >
          {keyedSteps.map(({ key, step }) => (
            <li key={key} className="flex min-w-0 items-start gap-2.5 py-1">
              <span
                aria-hidden
                className={cn(
                  "mt-1 flex size-4 shrink-0 items-center justify-center",
                  step.status === "completed"
                    ? "text-success"
                    : step.status === "inProgress"
                      ? "text-primary"
                      : "text-muted-foreground/50",
                )}
              >
                {step.status === "completed" ? (
                  <CheckIcon className="size-3.5" />
                ) : (
                  <span
                    className={cn(
                      "size-2 rounded-full border",
                      step.status === "inProgress" ? "border-primary bg-primary" : "border-current",
                    )}
                  />
                )}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 wrap-anywhere",
                  step.status === "inProgress" ? "text-foreground/90" : "text-muted-foreground/70",
                )}
              >
                {step.step}
              </span>
              <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
                {statusLabels[step.status]}
              </span>
              <span className="w-8 shrink-0 text-right text-xs text-muted-foreground/70">
                {step.status === "inProgress" ? "now" : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
