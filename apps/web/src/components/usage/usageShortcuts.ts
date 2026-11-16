import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import type { UsageChartMetric } from "./UsageProviderChart";
import { translateDynamic } from "../../i18nCore";
import { resolveShortcutCommand, type ShortcutEventLike } from "../../keybindings";

export type UsageMetric = UsageChartMetric | "limits";
export const METRIC_OPTIONS = [
  { value: "cost", label: translateDynamic("usage:cost"), command: "usage.cost" },
  { value: "tokens", label: translateDynamic("usage:tokens"), command: "usage.tokens" },
  { value: "limits", label: translateDynamic("usage:limits"), command: "usage.limits" },
] as const satisfies readonly { value: UsageMetric; label: string; command: KeybindingCommand }[];

export const WINDOW_OPTIONS = [
  { days: 1, label: translateDynamic("usage:window24h"), command: "usage.period.day" },
  { days: 7, label: translateDynamic("usage:window7d"), command: "usage.period.week" },
  { days: 30, label: translateDynamic("usage:window30d"), command: "usage.period.month" },
  { days: 90, label: translateDynamic("usage:window90d"), command: "usage.period.quarter" },
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
