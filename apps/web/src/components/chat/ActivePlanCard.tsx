import { memo } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";

import type { TimestampFormat } from "../../appSettings";
import type { ActivePlanState } from "../../session-logic";
import { formatTimestamp } from "../../timestampFormat";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

interface ActivePlanCardProps {
  activePlan: ActivePlanState;
  collapsed: boolean;
  timestampFormat: TimestampFormat;
  onToggleCollapsed: () => void;
}

export const ActivePlanCard = memo(function ActivePlanCard({
  activePlan,
  collapsed,
  timestampFormat,
  onToggleCollapsed,
}: ActivePlanCardProps) {
  const keyedSteps = buildKeyedSteps(activePlan.steps);

  return (
    <div
      data-active-plan-card="true"
      className="isolate overflow-hidden rounded-[24px] border border-border/80 bg-card/70 p-4 backdrop-blur-xs sm:p-5"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">Plan</Badge>
          <p className="truncate text-sm font-medium text-muted-foreground/75">
            Updated {formatTimestamp(activePlan.createdAt, timestampFormat)}
          </p>
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground/50 hover:text-foreground/75"
          aria-label={collapsed ? "Expand plan" : "Collapse plan"}
          title={collapsed ? "Expand plan" : "Collapse plan"}
          data-scroll-anchor-ignore
          onClick={onToggleCollapsed}
        >
          {collapsed ? (
            <ChevronDownIcon aria-hidden="true" className="size-3.5" />
          ) : (
            <ChevronUpIcon aria-hidden="true" className="size-3.5" />
          )}
        </Button>
      </div>
      {collapsed ? null : (
        <div className="mt-4 space-y-3">
          {activePlan.explanation?.trim() ? (
            <p className="text-[13px] leading-relaxed text-muted-foreground/80">
              {activePlan.explanation}
            </p>
          ) : null}
          <div className="space-y-3">
            {keyedSteps.map(({ key, step }) => (
              <div
                key={key}
                className="rounded-[18px] border border-border/55 bg-background/35 px-4 py-3"
              >
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-[10px] font-semibold",
                      step.status === "inProgress" &&
                        "border-blue-400/25 bg-blue-400/10 text-blue-300",
                      step.status === "pending" &&
                        "border-border/60 bg-background/50 text-muted-foreground/85",
                      step.status === "completed" &&
                        "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
                    )}
                  >
                    {statusLabel(step.status)}
                  </span>
                  <p
                    className={cn(
                      "min-w-0 flex-1 text-[13px] leading-snug text-foreground/92",
                      step.status === "completed" &&
                        "text-muted-foreground/65 line-through decoration-muted-foreground/25",
                    )}
                  >
                    {step.step}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

function statusLabel(status: ActivePlanState["steps"][number]["status"]): string {
  if (status === "inProgress") return "In progress";
  if (status === "completed") return "Completed";
  return "Pending";
}

function buildKeyedSteps(steps: ActivePlanState["steps"]): Array<{
  key: string;
  step: ActivePlanState["steps"][number];
}> {
  const occurrenceCountByBaseKey = new Map<string, number>();

  return steps.map((step) => {
    const baseKey = `${step.status}:${step.step}`;
    const nextOccurrence = (occurrenceCountByBaseKey.get(baseKey) ?? 0) + 1;
    occurrenceCountByBaseKey.set(baseKey, nextOccurrence);

    return {
      key: `${baseKey}:${nextOccurrence}`,
      step,
    };
  });
}
