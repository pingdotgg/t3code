import type { GitWorkflowProgress, GitWorkflowStep } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";

const stepColors: Record<GitWorkflowStep["state"], string> = {
  pending: "bg-muted-foreground/20",
  skipped: "bg-muted-foreground/20",
  running: "bg-primary",
  completed: "bg-success",
  failed: "bg-destructive",
};
export function GitWorkflowProgressView({ progress }: { readonly progress: GitWorkflowProgress }) {
  const groups = new Map<string, GitWorkflowStep[]>();
  for (const step of progress.steps) {
    const group = groups.get(step.group) ?? [];
    group.push(step);
    groups.set(step.group, group);
  }
  const finished = progress.steps.filter(
    (step) => step.state === "completed" || step.state === "skipped",
  ).length;
  const heading =
    progress.state === "running"
      ? progress.kind === "stack"
        ? "Stack progress"
        : "Logical commits"
      : progress.label;
  return (
    <div
      className="min-w-0 space-y-2 px-2.5 py-2"
      role="region"
      aria-label={progress.kind === "stack" ? "Stack progress" : "Logical commit progress"}
    >
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <Tooltip>
          <TooltipTrigger render={<p className="min-w-0 flex-1 truncate" />}>
            {heading}
          </TooltipTrigger>
          <TooltipPopup>{progress.label}</TooltipPopup>
        </Tooltip>
        {progress.steps.length > 0 ? (
          <span className="shrink-0 tabular-nums">
            {finished}/{progress.steps.length} steps
          </span>
        ) : null}
      </div>
      {progress.kind === "stack" ? (
        <p className="text-2xs text-muted-foreground">Rebase · Push · Hooks</p>
      ) : null}
      <div className="max-h-40 space-y-2 overflow-y-auto">
        {[...groups].map(([group, steps]) => (
          <div key={group} className="space-y-1">
            {progress.kind === "stack" ? (
              <Tooltip>
                <TooltipTrigger render={<p className="truncate text-xs text-muted-foreground" />}>
                  {group}
                </TooltipTrigger>
                <TooltipPopup>{group}</TooltipPopup>
              </Tooltip>
            ) : null}
            <div
              role="progressbar"
              aria-label={group}
              aria-valuemin={0}
              aria-valuemax={steps.length}
              aria-valuenow={
                steps.filter((step) => step.state === "completed" || step.state === "skipped")
                  .length
              }
              aria-valuetext={steps.map((step) => `${step.label}: ${step.state}`).join(", ")}
              className="flex gap-1"
            >
              {steps.map((step) => (
                <Tooltip key={step.id}>
                  <TooltipTrigger
                    render={
                      <span
                        aria-hidden="true"
                        className={cn("h-1.5 min-w-0 flex-1 rounded-sm", stepColors[step.state])}
                      />
                    }
                  />
                  <TooltipPopup>
                    {step.label}: {step.state}
                  </TooltipPopup>
                </Tooltip>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
