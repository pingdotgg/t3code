import { View } from "react-native";

import { cn } from "../../lib/cn";
import type { SubagentRowTone } from "./threadAgentsPresentation";

const TONE_CLASS = {
  working: "bg-adaptive-sky-600-400",
  completed: "bg-adaptive-emerald-600-400",
  failed: "bg-adaptive-rose-600-400",
  stopped: "bg-foreground-muted",
} as const satisfies Record<SubagentRowTone, string>;

export function SubagentStatusDot({
  tone,
  placement = "inline",
}: {
  readonly tone: SubagentRowTone;
  readonly placement?: "inline" | "provider" | "sheet";
}) {
  return (
    <View
      className={cn(
        "shrink-0 rounded-full",
        placement === "sheet" ? "h-2 w-2" : "h-1.5 w-1.5",
        placement === "provider" && "absolute bottom-0.5 right-0.5",
        TONE_CLASS[tone],
      )}
    />
  );
}
