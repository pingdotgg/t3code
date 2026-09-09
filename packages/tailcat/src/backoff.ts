/**
 * Reconnect backoff for tailcat forwarders. The schedule is deliberately slow:
 * a remote machine that went to sleep does not come back faster because we
 * knock harder, and a laptop on battery should not spin a WireGuard bootstrap
 * every second. Jitter keeps many saved environments from retrying in lockstep.
 */
export const TAILCAT_BACKOFF_STEPS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000] as const;
export const TAILCAT_BACKOFF_MAX_MS = 30_000;
export const TAILCAT_BACKOFF_JITTER_RATIO = 0.25;

/** Base delay before jitter for a failure count (1 = first failure). */
export function tailcatBackoffBaseMs(attempt: number): number {
  if (attempt <= 0) {
    return 0;
  }
  const index = Math.min(attempt, TAILCAT_BACKOFF_STEPS_MS.length) - 1;
  return TAILCAT_BACKOFF_STEPS_MS[index] ?? TAILCAT_BACKOFF_MAX_MS;
}

/**
 * Applies symmetric jitter. `random` is a unit-interval sample so the function
 * stays pure and tests can pin it.
 */
export function tailcatBackoffDelayMs(attempt: number, random: number): number {
  const base = tailcatBackoffBaseMs(attempt);
  if (base === 0) {
    return 0;
  }
  const unit = Math.min(1, Math.max(0, random));
  const spread = base * TAILCAT_BACKOFF_JITTER_RATIO;
  return Math.round(base - spread + unit * spread * 2);
}

/** Connections that stayed healthy this long earn a fresh backoff ladder. */
export const TAILCAT_BACKOFF_RESET_AFTER_MS = 60_000;
