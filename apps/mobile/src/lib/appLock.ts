export const APP_LOCK_GRACE_PERIODS_MS = [0, 60_000, 300_000, 900_000, 3_600_000] as const;

export type AppLockGracePeriodMs = (typeof APP_LOCK_GRACE_PERIODS_MS)[number];

export const DEFAULT_APP_LOCK_GRACE_PERIOD_MS: AppLockGracePeriodMs = 0;

export function isAppLockGracePeriodMs(value: unknown): value is AppLockGracePeriodMs {
  return (APP_LOCK_GRACE_PERIODS_MS as ReadonlyArray<unknown>).includes(value);
}

/** A clock that moved backwards while the app was away locks, so changing the time can't skip it. */
export function appLockExpired(input: {
  readonly awaySince: number;
  readonly now: number;
  readonly gracePeriodMs: number;
}): boolean {
  return input.now < input.awaySince || input.now - input.awaySince >= input.gracePeriodMs;
}
