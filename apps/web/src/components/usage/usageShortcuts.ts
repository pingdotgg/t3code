import { msg } from "gt-react";
import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import type { UsageWindowId } from "@t3tools/shared/usageFormat";
import type { UsageChartMetric } from "./UsageProviderChart";
import { resolveShortcutCommand, type ShortcutEventLike } from "../../keybindings";

export type UsageMetric = UsageChartMetric | "limits";
export const METRIC_OPTIONS = [
  { value: "cost", label: msg("Cost"), command: "usage.cost" },
  { value: "tokens", label: msg("Tokens"), command: "usage.tokens" },
  { value: "limits", label: msg("Limits"), command: "usage.limits" },
] as const satisfies readonly { value: UsageMetric; label: string; command: KeybindingCommand }[];

export const WINDOW_OPTIONS = [
  {
    id: "5h",
    label: msg("5h", { $context: "short label for the past 5 hours" }),
    command: "usage.period.5h",
  },
  {
    id: "12h",
    label: msg("12h", { $context: "short label for the past 12 hours" }),
    command: "usage.period.12h",
  },
  {
    id: "24h",
    label: msg("24h", { $context: "short label for the past 24 hours" }),
    command: "usage.period.day",
  },
  {
    id: "7d",
    label: msg("7d", { $context: "short label for the past 7 days" }),
    command: "usage.period.week",
  },
  {
    id: "30d",
    label: msg("30d", { $context: "short label for the past 30 days" }),
    command: "usage.period.month",
  },
  {
    id: "90d",
    label: msg("90d", { $context: "short label for the past 90 days" }),
    command: "usage.period.quarter",
  },
  {
    id: "180d",
    label: msg("180d", { $context: "short label for the past 180 days" }),
    command: "usage.period.180d",
  },
] as const satisfies readonly { id: UsageWindowId; label: string; command: KeybindingCommand }[];

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
      target.closest(
        '[role="dialog"]:not([data-app-modal]), [aria-modal="true"]:not([data-app-modal]), [data-slot$="popup"]:not([data-app-modal])',
      ))
  ) {
    return null;
  }

  return resolveShortcutCommand(event, keybindings, {
    context: { usagePageOpen: true },
  });
}
