import { type OrchestrationV2TurnItem } from "@t3tools/contracts";
import { providerErrorPresentation } from "../../session-logic";
import {
  CheckIcon,
  CircleAlertIcon,
  GitForkIcon,
  type LucideIcon,
  MinusIcon,
  WrenchIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import * as DateTime from "effect/DateTime";

type V2EventTone = "muted" | "warning" | "danger" | "success";

export function v2EventPresentation(item: OrchestrationV2TurnItem): {
  readonly label: string;
  readonly detail: string | null;
  readonly tone: V2EventTone;
  readonly icon: LucideIcon;
} {
  switch (item.type) {
    case "error": {
      const presentation = providerErrorPresentation(item);
      return {
        ...presentation,
        tone:
          item.status === "completed"
            ? "success"
            : item.status === "running" || item.failure.class === "usage_limit"
              ? "warning"
              : "danger",
        icon: CircleAlertIcon,
      };
    }
    case "run_interrupt_request":
      return {
        label: "Interrupt requested",
        detail: item.message,
        tone: "warning",
        icon: CircleAlertIcon,
      };
    case "run_interrupt_result":
      return {
        label: "Run interrupted",
        detail: item.message,
        tone: "danger",
        icon: XIcon,
      };
    case "handoff":
      return {
        label: "Context handoff",
        detail:
          item.summary ??
          `${item.fromProviderInstanceIds.join(", ")} → ${item.toProviderInstanceId}`,
        tone: item.status === "failed" ? "danger" : "muted",
        icon: ZapIcon,
      };
    case "fork":
      return {
        label: "Conversation fork",
        detail: `Continues in ${item.targetThreadId}`,
        tone: "muted",
        icon: GitForkIcon,
      };
    case "compaction": {
      const tokenSummary =
        item.beforeTokenCount === undefined && item.afterTokenCount === undefined
          ? null
          : `${item.beforeTokenCount ?? "?"} → ${item.afterTokenCount ?? "?"} tokens`;
      return {
        label: "Context compacted",
        detail: item.summary ?? tokenSummary,
        tone: item.status === "failed" ? "danger" : "muted",
        icon: MinusIcon,
      };
    }
    case "todo_list": {
      const steps = item.steps.map((step) => `${step.status}: ${step.text}`).join("\n");
      return {
        label: "Plan updated",
        detail: [item.explanation, steps].filter(Boolean).join("\n\n") || null,
        tone: item.status === "failed" ? "danger" : "success",
        icon: CheckIcon,
      };
    }
    default:
      return {
        label: item.title?.trim() || item.type.replaceAll("_", " "),
        detail: null,
        tone: item.status === "failed" ? "danger" : "muted",
        icon: WrenchIcon,
      };
  }
}

export function subagentGroupTiming(
  agents: ReadonlyArray<{
    status: OrchestrationV2TurnItem["status"];
    startedAt: DateTime.Utc | null;
    completedAt: DateTime.Utc | null;
  }>,
) {
  let startMs: number | null = null;
  let endMs: number | null = null;
  let endUnknown = false;
  for (const agent of agents) {
    if (agent.startedAt) {
      const ms = DateTime.toEpochMillis(agent.startedAt);
      startMs = startMs === null ? ms : Math.min(startMs, ms);
    }
    if (agent.completedAt) {
      const ms = DateTime.toEpochMillis(agent.completedAt);
      endMs = endMs === null ? ms : Math.max(endMs, ms);
    } else {
      endUnknown = true;
    }
  }
  const live = agents.some(
    ({ status }) => status === "pending" || status === "running" || status === "waiting",
  );
  return {
    status: live ? ("running" as const) : ("completed" as const),
    startedAt: startMs === null ? null : new Date(startMs).toISOString(),
    completedAt: live || endUnknown || endMs === null ? null : new Date(endMs).toISOString(),
  };
}
