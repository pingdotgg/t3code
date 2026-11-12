/**
 * Pooled quota projection: every account of a provider counts toward one pool (two Claude
 * subscriptions = 200%). The pool drains at the current burn rate, spending the account that
 * resets first, and each account refills when its window resets.
 */
import type { LimitPoolWindow } from "./usageLimits.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Measured burn needs at least this much history; shorter spans are mostly noise. */
const MIN_MEASURED_SPAN = 15 * MINUTE;

/** One reading of a pool: used percent per account key. */
export interface PoolSample {
  readonly at: number;
  readonly used: Readonly<Record<string, number>>;
}

interface PoolBurn {
  /** Percentage points of the pool spent per hour. */
  readonly perHour: number;
  /** "measured" comes from stored readings, "window" from the average since each window opened. */
  readonly source: "measured" | "window";
}

export interface PoolProjection {
  readonly capacity: number;
  readonly remaining: number;
  readonly points: ReadonlyArray<{ readonly at: number; readonly remaining: number }>;
  readonly refills: ReadonlyArray<{
    readonly at: number;
    readonly accountKey: string;
    /** Percentage points this reset gives back. */
    readonly restores: number;
    /** Pool remaining right after the reset. */
    readonly remainingAfter: number;
  }>;
  readonly firstEmpty: { readonly at: number; readonly accountKey: string } | null;
  readonly poolEmpty: number | null;
}

const clampUsed = (value: number) => Math.max(0, Math.min(100, value));

function resetAt(resetsAt: string | undefined): number | null {
  if (resetsAt === undefined) return null;
  const at = Date.parse(resetsAt);
  return Number.isFinite(at) ? at : null;
}

/** How far ahead to project: a day for session windows, otherwise one full window. */
export function projectionHorizon(pool: LimitPoolWindow): number {
  const longest = Math.max(0, ...pool.members.map((m) => m.window.windowDurationMins ?? 0));
  if (pool.kind === "session" || (longest > 0 && longest <= 12 * 60)) return DAY;
  if (pool.kind === "monthly" || longest >= 28 * 24 * 60) return 31 * DAY;
  return 7 * DAY;
}

function windowAverageBurn(pool: LimitPoolWindow, now: number): number {
  let perHour = 0;
  for (const { window } of pool.members) {
    const at = resetAt(window.resetsAt);
    if (at === null || !window.windowDurationMins) continue;
    const elapsed = window.windowDurationMins * MINUTE - (at - now);
    if (elapsed >= MIN_MEASURED_SPAN) perHour += clampUsed(window.usedPercent) / (elapsed / HOUR);
  }
  return perHour;
}

/**
 * Burn over the last `lookbackMs` from stored readings. A drop between readings means the
 * window reset, so the new value counts as fresh spend. Falls back to the window average while
 * the readings span less than 15 minutes.
 */
export function poolBurn(
  pool: LimitPoolWindow,
  samples: readonly PoolSample[],
  now: number,
  lookbackMs: number,
): PoolBurn {
  const recent = samples.filter((sample) => sample.at >= now - lookbackMs && sample.at <= now);
  const first = recent[0];
  const last = recent.at(-1);
  if (!first || !last || last.at - first.at < MIN_MEASURED_SPAN) {
    return { perHour: windowAverageBurn(pool, now), source: "window" };
  }
  let spent = 0;
  for (const { account } of pool.members) {
    let previous: number | undefined;
    for (const sample of recent) {
      const used = sample.used[account.key];
      if (used === undefined) continue;
      if (previous !== undefined) spent += used >= previous ? used - previous : used;
      previous = used;
    }
  }
  return { perHour: spent / ((last.at - first.at) / HOUR), source: "measured" };
}

export function projectPool(
  pool: LimitPoolWindow,
  now: number,
  options: { readonly burnPerHour: number; readonly horizonMs: number; readonly steps?: number },
): PoolProjection {
  const accounts = pool.members.map((member) => ({
    key: member.account.key,
    used: clampUsed(member.window.usedPercent),
    reset: resetAt(member.window.resetsAt),
    length: (member.window.windowDurationMins ?? 0) * MINUTE,
  }));
  const remainingNow = () => accounts.reduce((sum, account) => sum + 100 - account.used, 0);
  const capacity = accounts.length * 100;
  const remaining = remainingNow();
  const points = [{ at: now, remaining }];
  const refills: Array<PoolProjection["refills"][number]> = [];
  const exhausted = accounts.find((account) => account.used >= 100);
  let firstEmpty = exhausted ? { at: now, accountKey: exhausted.key } : null;
  let poolEmpty = accounts.length > 0 && remaining <= 0 ? now : null;
  const steps = options.steps ?? 480;
  const step = options.horizonMs / steps;

  for (let index = 1; index <= steps; index += 1) {
    const at = now + index * step;
    for (const account of accounts) {
      while (account.reset !== null && account.reset <= at) {
        const restores = account.used;
        account.used = 0;
        if (restores > 0.5) {
          refills.push({
            at: account.reset,
            accountKey: account.key,
            restores,
            remainingAfter: remainingNow(),
          });
        }
        account.reset = account.length > 0 ? account.reset + account.length : null;
      }
    }
    let drain = (options.burnPerHour * step) / HOUR;
    const spendable = accounts
      .filter((account) => account.used < 100)
      .sort((left, right) => (left.reset ?? Infinity) - (right.reset ?? Infinity));
    for (const account of spendable) {
      if (drain <= 0) break;
      // An unused window opens on first spend.
      if (account.reset === null && account.used === 0 && account.length > 0) {
        account.reset = at + account.length;
      }
      const take = Math.min(drain, 100 - account.used);
      account.used += take;
      drain -= take;
      if (account.used >= 100 && firstEmpty === null) firstEmpty = { at, accountKey: account.key };
    }
    const left = remainingNow();
    if (left <= 1e-6 && poolEmpty === null) poolEmpty = at;
    points.push({ at, remaining: left });
  }
  return { capacity, remaining, points, refills, firstEmpty, poolEmpty };
}

/** Pool remaining at each stored reading since `from`, carrying an account's last value forward. */
export function recordedPool(
  pool: LimitPoolWindow,
  samples: readonly PoolSample[],
  from: number,
): ReadonlyArray<{ readonly at: number; readonly remaining: number }> {
  const keys = pool.members.map((member) => member.account.key);
  const last: Record<string, number> = {};
  const series: Array<{ at: number; remaining: number }> = [];
  for (const sample of samples) {
    for (const key of keys) {
      const used = sample.used[key];
      if (used !== undefined) last[key] = clampUsed(used);
    }
    if (sample.at < from || keys.some((key) => last[key] === undefined)) continue;
    series.push({ at: sample.at, remaining: keys.reduce((sum, key) => sum + 100 - last[key]!, 0) });
  }
  return series;
}
