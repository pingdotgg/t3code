import type { Wakeups } from "@t3tools/client-runtime/connection";

export const MOBILE_LONG_BACKGROUND_AFTER_MS = 10_000;

export type MobileApplicationActiveWakeup = Extract<
  Wakeups.ConnectionWakeup,
  "application-active-probe" | "application-active-long"
>;

export function mobileApplicationActiveWakeup(
  leftActiveAtMs: number | null,
  activeAtMs: number,
): MobileApplicationActiveWakeup {
  return leftActiveAtMs !== null && activeAtMs - leftActiveAtMs >= MOBILE_LONG_BACKGROUND_AFTER_MS
    ? "application-active-long"
    : "application-active-probe";
}

// iOS can suspend JS before `background` arrives, so time away from `inactive`.
export function makeApplicationActiveWakeups(
  initialState: string | null | undefined,
  nowMs: number,
): (state: string, nowMs: number) => MobileApplicationActiveWakeup | undefined {
  let leftActiveAtMs = initialState === "inactive" || initialState === "background" ? nowMs : null;
  return (state, atMs) => {
    if (state !== "active") {
      leftActiveAtMs ??= atMs;
      return undefined;
    }
    const wakeup = mobileApplicationActiveWakeup(leftActiveAtMs, atMs);
    leftActiveAtMs = null;
    return wakeup;
  };
}
