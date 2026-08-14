import type { Wakeups } from "@t3tools/client-runtime/connection";

export const MOBILE_BACKGROUND_RECONNECT_AFTER_MS = 10_000;

export type MobileApplicationActiveWakeup = Extract<
  Wakeups.ConnectionWakeup,
  "application-active-preserved" | "application-active-probe" | "application-active-reconnect"
>;

export interface MobileBackgroundConnectionProtection {
  readonly serviceRunning: boolean;
  readonly runtimeReady: boolean;
}

export function mobileApplicationActiveWakeup(
  backgroundedAtMs: number | null,
  activeAtMs: number,
  protection?: MobileBackgroundConnectionProtection,
): MobileApplicationActiveWakeup {
  if (protection?.serviceRunning === true && protection.runtimeReady === true) {
    return "application-active-preserved";
  }
  return backgroundedAtMs !== null &&
    activeAtMs - backgroundedAtMs >= MOBILE_BACKGROUND_RECONNECT_AFTER_MS
    ? "application-active-reconnect"
    : "application-active-probe";
}
