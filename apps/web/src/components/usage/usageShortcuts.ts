import { t } from "@palamedes/core/macro";
import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import type { UsageChartMetric } from "./UsageProviderChart";
import { resolveShortcutCommand, type ShortcutEventLike } from "../../keybindings";

export type UsageMetric = UsageChartMetric | "limits";
export const METRIC_OPTIONS = [
  {
    value: "cost",
    get label() {
      return t({ message: "Cost" });
    },
    command: "usage.cost",
  },
  {
    value: "tokens",
    get label() {
      return t({ message: "Tokens" });
    },
    command: "usage.tokens",
  },
  {
    value: "limits",
    get label() {
      return t({ message: "Limits" });
    },
    command: "usage.limits",
  },
] as const satisfies readonly { value: UsageMetric; label: string; command: KeybindingCommand }[];

export const WINDOW_OPTIONS = [
  {
    days: 1,
    get label() {
      return t({ message: "Past 24h" });
    },
    command: "usage.period.day",
  },
  {
    days: 7,
    get label() {
      return t({ message: "7 days" });
    },
    command: "usage.period.week",
  },
  {
    days: 30,
    get label() {
      return t({ message: "30 days" });
    },
    command: "usage.period.month",
  },
  {
    days: 90,
    get label() {
      return t({ message: "90 days" });
    },
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
