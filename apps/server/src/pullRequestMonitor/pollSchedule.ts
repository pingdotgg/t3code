import type { PullRequestMonitorReadiness } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

/**
 * Adaptive polling cadence. The monitor snapshot costs at least three REST reads plus one
 * GraphQL query, so sub-minute polling does not scale with the number of open pull requests.
 */
export const POLL_BASE_MS = 5 * 60_000;
export const POLL_READY_MS = 15 * 60_000;
export const POLL_ACTIVE_MS = 60_000;
export const POLL_ERROR_BASE_MS = 2 * 60_000;
export const POLL_ERROR_MAX_MS = 30 * 60_000;
export const HOST_COOLDOWN_BASE_MS = 2 * 60_000;
export const HOST_COOLDOWN_MAX_MS = 60 * 60_000;
export const LEASE_TTL_MS = 90_000;
/** One snapshot per 15-second sweep caps steady-state background work at four per minute. */
export const POLL_BATCH_LIMIT = 1;
/** A snapshot already performs several remote reads; keep monitor snapshots serialized. */
export const POLL_CONCURRENCY = 1;
export const MAX_RETAINED_SNAPSHOTS = 20;

export function jitterMs(baseMs: number, unitSample: number, ratio = 0.2): number {
  const spread = Math.floor(baseMs * ratio);
  if (spread <= 0) return baseMs;
  const unit = Math.min(1, Math.max(0, unitSample));
  return baseMs + Math.floor(unit * (spread * 2 + 1)) - spread;
}

export interface PollDelayInput {
  readonly readiness: PullRequestMonitorReadiness | null;
  readonly failureCount: number;
  readonly hadActionableEvents: boolean;
}

export function hasFastPollBlocker(readiness: PullRequestMonitorReadiness | null): boolean {
  return (
    readiness?.blockers.some(
      (blocker) =>
        blocker.kind === "check-pending" ||
        (blocker.kind === "mergeability" && blocker.detail === "unknown"),
    ) ?? false
  );
}

/** Pure cadence so a poll commit can compute its next schedule inside a transaction. */
export function pollDelayMs(input: PollDelayInput, unitSample: number): number {
  if (input.failureCount > 0) {
    const exp = Math.min(
      POLL_ERROR_MAX_MS,
      POLL_ERROR_BASE_MS * 2 ** Math.min(Math.max(0, input.failureCount - 1), 6),
    );
    return jitterMs(exp, unitSample);
  }
  if (input.readiness?.ready) {
    return jitterMs(POLL_READY_MS, unitSample);
  }
  if (input.hadActionableEvents || hasFastPollBlocker(input.readiness)) {
    return jitterMs(POLL_ACTIVE_MS, unitSample);
  }
  return jitterMs(POLL_BASE_MS, unitSample);
}

export const nextPollDelayMs = (input: PollDelayInput): Effect.Effect<number> =>
  Effect.map(Random.next, (unit) => pollDelayMs(input, unit));

export function rateLimitCooldownMs(failureCount: number): number {
  const exponent = Math.max(0, Math.min(5, failureCount - 1));
  return Math.min(HOST_COOLDOWN_MAX_MS, HOST_COOLDOWN_BASE_MS * 2 ** exponent);
}
