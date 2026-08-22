import type { Wakeups } from "@t3tools/client-runtime/connection";

export const MOBILE_BACKGROUND_RECONNECT_AFTER_MS = 10_000;

export type MobileApplicationActiveWakeup = Extract<
  Wakeups.ConnectionWakeup,
  "application-active-probe" | "application-active-reconnect"
>;

export function mobileApplicationActiveWakeup(
  backgroundedAtMs: number | null,
  activeAtMs: number,
): MobileApplicationActiveWakeup {
  return backgroundedAtMs !== null &&
    activeAtMs - backgroundedAtMs >= MOBILE_BACKGROUND_RECONNECT_AFTER_MS
    ? "application-active-reconnect"
    : "application-active-probe";
}

export function mobileSuspensionStartedAtMs(
  startedAtMs: number | null,
  appState: string,
  nowMs: number,
): number | null {
  if (appState === "background" || appState === "inactive") {
    return startedAtMs ?? nowMs;
  }
  if (appState === "active") {
    return null;
  }
  return startedAtMs;
}
