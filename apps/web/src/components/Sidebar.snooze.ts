import { snoozeWakeLabel } from "@t3tools/client-runtime/state/thread-settled";
import { parseTimestampDate } from "../timestampFormat";

export {
  resolveSnoozePresets,
  type SnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";
export { snoozeWakeLabel };

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Human wake time for menus and toasts: "tomorrow 9:00", "Mon 9:00",
 * "17:30" (today).
 */
export function snoozeWakeDescription(snoozedUntil: string, now: Date): string {
  const wake = parseTimestampDate(snoozedUntil);
  if (wake === null) return "";
  const time = wake.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayDelta = Math.floor((wake.getTime() - startOfToday.getTime()) / DAY_MS);
  if (dayDelta === 0) return time;
  if (dayDelta === 1) return `tomorrow ${time}`;
  const weekday = wake.toLocaleDateString(undefined, { weekday: "short" });
  if (dayDelta < 7) return `${weekday} ${time}`;
  const date = wake.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${date}, ${time}`;
}
