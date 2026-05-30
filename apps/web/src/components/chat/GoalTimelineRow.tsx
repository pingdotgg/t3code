import { CheckIcon, CircleAlertIcon, type LucideIcon, ZapIcon } from "lucide-react";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { cn } from "~/lib/utils";
import { formatTimestamp } from "../../timestampFormat";

type GoalTimelineRowData = Extract<MessagesTimelineRow, { kind: "goal" }>;

function goalRowIcon(label: string): LucideIcon {
  if (label === "Goal paused" || label === "Goal budget limited") {
    return CircleAlertIcon;
  }
  if (label === "Goal complete" || label === "Goal cleared") {
    return CheckIcon;
  }
  return ZapIcon;
}

function goalRowIconClassName(label: string): string {
  if (label === "Goal paused" || label === "Goal budget limited") {
    return "bg-amber-500/10 text-amber-400";
  }
  if (label === "Goal complete") {
    return "bg-emerald-500/10 text-emerald-400";
  }
  if (label === "Goal cleared") {
    return "bg-muted text-muted-foreground";
  }
  return "bg-primary/10 text-primary";
}

export function GoalTimelineRow({
  row,
  timestampFormat,
}: {
  row: GoalTimelineRowData;
  timestampFormat: TimestampFormat;
}) {
  const Icon = goalRowIcon(row.label);

  return (
    <div className="flex justify-center px-4">
      <div className="flex max-w-[min(100%,42rem)] items-center gap-2 rounded-lg border border-border/50 bg-card/40 px-3 py-2 text-xs text-muted-foreground shadow-sm">
        <span
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full",
            goalRowIconClassName(row.label),
          )}
        >
          <Icon className="size-3" />
        </span>
        <span className="shrink-0 font-medium text-foreground/85">{row.label}</span>
        {row.detail ? (
          <span className="min-w-0 truncate text-muted-foreground/80" title={row.detail}>
            {row.detail}
          </span>
        ) : null}
        <span className="shrink-0 text-muted-foreground/45">
          {formatTimestamp(row.createdAt, timestampFormat)}
        </span>
      </div>
    </div>
  );
}
