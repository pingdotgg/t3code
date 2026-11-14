import type { Wakeups } from "@t3tools/client-runtime/connection";

const MOBILE_LONG_BACKGROUND_AFTER_MS = 10_000;

export type MobileApplicationActiveWakeup = Extract<
  Wakeups.ConnectionWakeup,
  "application-active-probe" | "application-active-long"
>;

export function mobileApplicationActiveWakeup(
  backgroundedAtMs: number | null,
  activeAtMs: number,
): MobileApplicationActiveWakeup | null {
  // iOS goes inactive without suspending for Control Center, alerts, and the app switcher.
  if (backgroundedAtMs === null) return null;
  return activeAtMs - backgroundedAtMs >= MOBILE_LONG_BACKGROUND_AFTER_MS
    ? "application-active-long"
    : "application-active-probe";
}
