import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import type { UsageChartMetric } from "./UsageProviderChart";
import { resolveShortcutCommand, type ShortcutEventLike } from "../../keybindings";

export type UsageMetric = UsageChartMetric | "limits";
export const METRIC_OPTIONS = [
  { value: "cost", label: "Cost", labelKey: "metricCost", command: "usage.cost" },
  { value: "tokens", label: "Tokens", labelKey: "metricTokens", command: "usage.tokens" },
  { value: "limits", label: "Limits", labelKey: "metricLimits", command: "usage.limits" },
] as const satisfies readonly {
  value: UsageMetric;
  label: string;
  labelKey: "metricCost" | "metricTokens" | "metricLimits";
  command: KeybindingCommand;
}[];

export const WINDOW_OPTIONS = [
  { days: 1, label: "Past 24h", labelKey: "periodPast24Hours", command: "usage.period.day" },
  { days: 7, label: "7 days", labelKey: "period7Days", command: "usage.period.week" },
  { days: 30, label: "30 days", labelKey: "period30Days", command: "usage.period.month" },
  { days: 90, label: "90 days", labelKey: "period90Days", command: "usage.period.quarter" },
] as const;

/** Resolves page shortcuts without taking letters from fields or popup controls. */
export function resolveUsageShortcut(
  event: ShortcutEventLike & { target: EventTarget | null },
  keybindings: ResolvedKeybindingsConfig,
) {
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable ||
      target.closest('[role="dialog"], [aria-modal="true"], [data-slot$="popup"]'))
  ) {
    return null;
  }

  return resolveShortcutCommand(event, keybindings, {
    context: { usagePageOpen: true },
  });
}
