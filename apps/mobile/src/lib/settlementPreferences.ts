const MINUTE_MS = 60 * 1_000;

export const MIN_CHANGE_REQUEST_SETTLE_IDLE_MINUTES = 0;
export const MAX_CHANGE_REQUEST_SETTLE_IDLE_MINUTES = 24 * 60;
export const CHANGE_REQUEST_SETTLE_IDLE_MINUTES_STEP = 15;
// "Now" mirrors the resolver's immediate-settle behavior for merged/closed
// PRs; a delay is a per-device opt-in on top of that default.
export const DEFAULT_CHANGE_REQUEST_SETTLE_IDLE_MINUTES = 0;

export function isChangeRequestSettleIdleMinutes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_CHANGE_REQUEST_SETTLE_IDLE_MINUTES &&
    value <= MAX_CHANGE_REQUEST_SETTLE_IDLE_MINUTES &&
    value % CHANGE_REQUEST_SETTLE_IDLE_MINUTES_STEP === 0
  );
}

export function resolveChangeRequestSettleIdleMs(preference: number | undefined): number {
  return (preference ?? DEFAULT_CHANGE_REQUEST_SETTLE_IDLE_MINUTES) * MINUTE_MS;
}

export function formatChangeRequestSettleIdleMinutes(minutes: number): string {
  if (minutes === 0) return "Now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}
