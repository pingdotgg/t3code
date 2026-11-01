import type { ScheduledTask } from "@t3tools/contracts";
import { View } from "react-native";

import { cn } from "../../../lib/cn";

const STATUS_DOT_CLASS = {
  never: "bg-foreground-muted/40",
  running: "bg-adaptive-sky-600-400",
  succeeded: "bg-adaptive-emerald-600-400",
  failed: "bg-adaptive-rose-600-400",
} as const satisfies Record<ScheduledTask["lastRunStatus"], string>;

/** The last run's outcome, matching the dot beside each automation on web. */
export function ScheduledTaskStatusDot(props: {
  readonly status: ScheduledTask["lastRunStatus"];
  readonly className?: string;
}) {
  return (
    <View
      className={cn("size-1.5 rounded-full", STATUS_DOT_CLASS[props.status], props.className)}
    />
  );
}
