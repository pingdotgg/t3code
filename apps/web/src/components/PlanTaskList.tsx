import { CheckIcon, LoaderIcon } from "lucide-react";

import type { ProposedPlanTask } from "../proposedPlan";
import { cn } from "~/lib/utils";

function PlanTaskStatusIcon({ status }: { status: ProposedPlanTask["status"] }) {
  if (status === "completed") {
    return (
      <span
        aria-label="Completed"
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success/10 text-success-foreground"
      >
        <CheckIcon aria-hidden="true" className="size-3" />
      </span>
    );
  }
  if (status === "inProgress") {
    return (
      <span
        aria-label="In progress"
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
      >
        <LoaderIcon aria-hidden="true" className="size-3 animate-spin" />
      </span>
    );
  }
  return (
    <span
      aria-label="Pending"
      className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/30"
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-muted-foreground/30" />
    </span>
  );
}

export function PlanTaskList({
  tasks,
  label = "Tasks",
}: {
  tasks: ReadonlyArray<ProposedPlanTask>;
  label?: string;
}) {
  const completedCount = tasks.filter((task) => task.status === "completed").length;

  return (
    <div className="space-y-1">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase">
          {label}
        </p>
        <span className="text-[10px] text-muted-foreground/40 tabular-nums">
          {completedCount}/{tasks.length}
        </span>
      </div>
      {tasks.map((task, index) => (
        <div
          key={`${index}:${task.step}`}
          className={cn(
            "flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors duration-200",
            task.status === "inProgress" && "bg-blue-500/5",
            task.status === "completed" && "bg-emerald-500/5",
          )}
        >
          <PlanTaskStatusIcon status={task.status} />
          <p
            className={cn(
              "min-w-0 text-[13px] leading-snug",
              task.status === "completed"
                ? "text-muted-foreground/50 line-through decoration-muted-foreground/20"
                : task.status === "inProgress"
                  ? "text-foreground/90"
                  : "text-muted-foreground/70",
            )}
          >
            {task.step}
          </p>
        </div>
      ))}
    </div>
  );
}
