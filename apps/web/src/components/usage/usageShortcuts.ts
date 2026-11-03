import type { MessageKey } from "@t3tools/client-runtime/i18n";
import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import type { UsageChartMetric } from "./UsageProviderChart";
import { resolveShortcutCommand, type ShortcutEventLike } from "../../keybindings";

export type UsageMetric = UsageChartMetric | "limits";
export const METRIC_OPTIONS = [
  {
    value: "cost",
    label: "Cost",
    labelKey: "misc.usage.metric.cost",
    command: "usage.cost",
  },
  {
    value: "tokens",
    label: "Tokens",
    labelKey: "misc.usage.metric.tokens",
    command: "usage.tokens",
  },
  {
    value: "limits",
    label: "Limits",
    labelKey: "misc.usage.metric.limits",
    command: "usage.limits",
  },
] as const satisfies readonly {
  value: UsageMetric;
  label: string;
  labelKey: MessageKey;
  command: KeybindingCommand;
}[];

export const WINDOW_OPTIONS = [
  { days: 1, label: "Past 24h", labelKey: "misc.usage.period.day", command: "usage.period.day" },
  { days: 7, label: "7 days", labelKey: "misc.usage.period.week", command: "usage.period.week" },
  {
    days: 30,
    label: "30 days",
    labelKey: "misc.usage.period.month",
    command: "usage.period.month",
  },
  {
    days: 90,
    label: "90 days",
    labelKey: "misc.usage.period.quarter",
    command: "usage.period.quarter",
  },
] as const;

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
