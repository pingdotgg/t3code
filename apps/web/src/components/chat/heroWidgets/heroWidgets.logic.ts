import { type HostCpuHistory, UsageDay, type UsageSummaryInput } from "@t3tools/contracts";
import type { LimitPool, LimitPoolWindow } from "@t3tools/shared/usageLimits";

import { DETAILS_CARD_CLEARANCE } from "../chatCanvasLayout";

const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

const DAY_KEY = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The local calendar day of `date`, in the YYYY-MM-DD form usage buckets use. */
export function dayKey(date: Date): string {
  return DAY_KEY.format(date);
}

export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addLocalDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** One day-resolution window: the last `days` local days through today. One server call. */
export function dailyWindow(now: Date, days: number): UsageSummaryInput {
  return {
    sinceDay: UsageDay.make(dayKey(addLocalDays(now, -(days - 1)))),
    untilDay: UsageDay.make(dayKey(now)),
    timeZone: localTimeZone(),
    resolution: "day",
  };
}

// Layout: Pool spans the top, Machines and Streak share the row below (or stack when narrow).

export type LowerWidgetId = "machines" | "streak";

export interface HeroLayout {
  readonly columns: 1 | 2;
  /** Rows under the pool; each row holds one widget per column. */
  readonly lowerRows: ReadonlyArray<ReadonlyArray<LowerWidgetId>>;
  readonly poolHeight: number;
  readonly lowerHeight: number;
  /** Height before the cards grow into half of the spare room. */
  readonly compactHeight: number;
  readonly height: number;
}

export const HERO_LAYOUT = {
  gap: 10,
  minCardWidth: 340,
  pool: { min: 232, ideal: 268, max: 300 },
  lower: { min: 214, ideal: 248, max: 316 },
} as const;

/**
 * Fits Pool, Machines and Streak into `space` without scrolling. Pool always comes first;
 * the lower widgets sit side by side when two cards fit across, otherwise they stack and the
 * ones that do not fit are dropped. Returns null when not even the pool fits.
 */
export function fitHeroLayout(space: {
  readonly width: number;
  readonly height: number;
}): HeroLayout | null {
  const { gap, pool, lower } = HERO_LAYOUT;
  const columns: 1 | 2 = space.width >= HERO_LAYOUT.minCardWidth * 2 + gap ? 2 : 1;
  const options: ReadonlyArray<ReadonlyArray<ReadonlyArray<LowerWidgetId>>> =
    columns === 2
      ? [[["machines", "streak"]], []]
      : [[["machines"], ["streak"]], [["machines"]], []];
  const need = (poolHeight: number, lowerHeight: number, rows: number) =>
    poolHeight + rows * (gap + lowerHeight);
  const lowerRows = options.find((rows) => need(pool.min, lower.min, rows.length) <= space.height);
  if (lowerRows === undefined || space.width < 200) return null;
  const rows = lowerRows.length;

  let poolHeight: number = pool.ideal;
  let lowerHeight: number = lower.ideal;
  const ideal = need(pool.ideal, lower.ideal, rows);
  if (ideal > space.height) {
    const slack = ideal - need(pool.min, lower.min, rows);
    const shrink = slack > 0 ? Math.min(1, (ideal - space.height) / slack) : 1;
    poolHeight = pool.ideal - shrink * (pool.ideal - pool.min);
    lowerHeight = lower.ideal - shrink * (lower.ideal - lower.min);
  }
  poolHeight = Math.floor(poolHeight);
  lowerHeight = Math.floor(lowerHeight);
  const compactHeight = need(poolHeight, lowerHeight, rows);
  // Grow into half of what is left under the centered block.
  const extra = Math.max(0, (space.height - compactHeight) / 2);
  const poolGrowth = Math.min(pool.max - poolHeight, rows > 0 ? extra / 2 : extra);
  const lowerGrowth = rows > 0 ? Math.min(lower.max - lowerHeight, (extra - poolGrowth) / rows) : 0;
  poolHeight = Math.floor(poolHeight + Math.max(0, poolGrowth));
  lowerHeight = Math.floor(lowerHeight + Math.max(0, lowerGrowth));
  return {
    columns,
    lowerRows,
    poolHeight,
    lowerHeight,
    compactHeight,
    height: need(poolHeight, lowerHeight, rows),
  };
}

// Area: the box under the composer that the grid may fill.

export const HERO_AREA = {
  /** Room kept between the grid and the sides of the conversation pane. */
  gutter: 48,
  /** The grid never grows wider than this, so the pool chart keeps a readable week. */
  maxWidth: 1360,
  /** Space between the composer and the grid. */
  gapAbove: 32,
  /** Least room kept for the hero headline above the composer. */
  headlineMin: 112,
  /** Space kept between the grid and the bottom of the pane. */
  edgeMargin: 24,
} as const;

interface HeroPane {
  /** The conversation pane's content box. */
  readonly width: number;
  readonly height: number;
  /** The composer stack's box in the pane. */
  readonly stackLeft: number;
  readonly stackWidth: number;
  readonly stackHeight: number;
  /** Height the hero headline needs to show whole; 0 when it is hidden. */
  readonly headlineHeight: number;
  /** Left edge of the floating details card in the pane, or null while it is closed. */
  readonly detailsLeft: number | null;
}

export interface HeroArea {
  /** Left edge relative to the composer stack, which positions the grid. */
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Centers the grid on the composer, as wide as fits on both sides of it inside the pane and left
 * of an open details card. Its height leaves the headline the room it needs, so cards shrink or
 * drop first.
 */
export function heroWidgetArea(pane: HeroPane): HeroArea {
  const { gutter, maxWidth, gapAbove, headlineMin, edgeMargin } = HERO_AREA;
  const end = Math.min(
    pane.width - gutter,
    pane.detailsLeft === null
      ? Number.POSITIVE_INFINITY
      : pane.detailsLeft - DETAILS_CARD_CLEARANCE,
  );
  const axis = pane.stackLeft + pane.stackWidth / 2;
  const half = Math.max(0, Math.min(axis - gutter, end - axis));
  const width = Math.floor(Math.min(maxWidth, 2 * half));
  return {
    left: (pane.stackWidth - width) / 2,
    width,
    height: Math.max(
      0,
      Math.floor(
        pane.height -
          pane.stackHeight -
          Math.max(headlineMin, pane.headlineHeight) -
          gapAbove -
          edgeMargin,
      ),
    ),
  };
}

// Streak: a day counts when its tokens reach the goal.

export const DEFAULT_TOKEN_GOAL = 1_000_000_000;

export type StreakDayState = "met" | "missed" | "noData" | "today";

export interface StreakDay {
  readonly key: string;
  readonly date: Date;
  readonly tokens: number;
  readonly state: StreakDayState;
}

export interface Streak {
  /** Oldest first, ending today. */
  readonly days: ReadonlyArray<StreakDay>;
  readonly current: number;
  readonly best: number;
  /** First and last day of the best run. */
  readonly bestRun: { readonly from: Date; readonly to: Date } | null;
  /** Median tokens over tracked days before today. */
  readonly medianDay: number;
  readonly todayTokens: number;
  readonly todayMet: boolean;
  readonly bestDay: { readonly key: string; readonly date: Date; readonly tokens: number } | null;
  readonly metDays: number;
  readonly trackedDays: number;
  readonly firstTrackedKey: string | null;
}

/**
 * Days before the first day with any tokens have no data (usage history is limited), so they
 * neither break nor extend a streak. Today counts once it reaches the goal; until then the
 * streak runs through yesterday.
 */
export function buildStreak(
  now: Date,
  tokensByDay: ReadonlyMap<string, number>,
  goal: number,
  spanDays: number,
): Streak {
  const today = startOfLocalDay(now);
  const keys = Array.from({ length: spanDays }, (_, index) =>
    addLocalDays(today, index - (spanDays - 1)),
  );
  const firstTracked = keys.find((date) => (tokensByDay.get(dayKey(date)) ?? 0) > 0) ?? null;
  const days = keys.map((date, index): StreakDay => {
    const key = dayKey(date);
    const tokens = tokensByDay.get(key) ?? 0;
    const isToday = index === keys.length - 1;
    const state: StreakDayState = isToday
      ? "today"
      : firstTracked === null || date < firstTracked
        ? "noData"
        : tokens >= goal
          ? "met"
          : "missed";
    return { key, date, tokens, state };
  });
  const todayDay = days.at(-1)!;
  const todayMet = todayDay.tokens >= goal;
  const counts = (day: StreakDay) => day.state === "met" || (day.state === "today" && todayMet);
  let best = 0;
  let run = 0;
  let bestRun: Streak["bestRun"] = null;
  days.forEach((day, index) => {
    run = counts(day) ? run + 1 : 0;
    if (run > 0 && run >= best) {
      best = run;
      bestRun = { from: days[index - run + 1]!.date, to: day.date };
    }
  });
  let current = 0;
  for (let index = days.length - (todayMet ? 1 : 2); index >= 0; index -= 1) {
    if (!counts(days[index]!)) break;
    current += 1;
  }
  let bestDay: Streak["bestDay"] = null;
  for (const day of days) {
    if (day.tokens > (bestDay?.tokens ?? 0)) {
      bestDay = { key: day.key, date: day.date, tokens: day.tokens };
    }
  }
  const tracked = days.filter((day) => day.state !== "noData");
  const past = tracked
    .filter((day) => day.state !== "today")
    .map((day) => day.tokens)
    .toSorted((left, right) => left - right);
  const medianDay =
    past.length === 0
      ? 0
      : past.length % 2 === 1
        ? past[(past.length - 1) / 2]!
        : (past[past.length / 2 - 1]! + past[past.length / 2]!) / 2;
  return {
    days,
    current,
    best,
    bestRun,
    medianDay,
    todayTokens: todayDay.tokens,
    todayMet,
    bestDay,
    metDays: days.filter(counts).length,
    trackedDays: tracked.length,
    firstTrackedKey: firstTracked ? dayKey(firstTracked) : null,
  };
}

// Pool: every account's binding window, projected forward at a burn rate.

export interface PoolAccount {
  readonly key: string;
  readonly name: string;
  /** Percent left in the binding window, 0..100. */
  readonly left: number;
  readonly resetsAt: number | null;
  readonly periodMs: number;
}

export interface PoolProvider {
  readonly driver: string;
  readonly windowLabel: string;
  readonly accounts: ReadonlyArray<PoolAccount>;
  readonly capacity: number;
  readonly left: number;
}

const WEEK_MS = 7 * DAY_MS;

function windowRank(window: LimitPoolWindow): number {
  if (window.kind === "weekly") return window.label.includes("·") ? 1 : 0;
  if (window.kind === "monthly") return 2;
  if (window.kind === "other") return 3;
  return 4;
}

/** The window that limits the account longest: weekly where present, the general one first. */
function bindingWindow(pool: LimitPool): LimitPoolWindow | null {
  return (
    pool.windows.toSorted(
      (left, right) => windowRank(left) - windowRank(right) || right.usedPercent - left.usedPercent,
    )[0] ?? null
  );
}

export function poolProviders(
  pools: ReadonlyArray<LimitPool>,
  accountName: (account: LimitPool["accounts"][number]) => string,
): ReadonlyArray<PoolProvider> {
  return pools.flatMap((pool) => {
    const window = bindingWindow(pool);
    if (!window || window.members.length === 0) return [];
    const accounts = window.members.map((member): PoolAccount => {
      const resetsAt = member.window.resetsAt ? Date.parse(member.window.resetsAt) : Number.NaN;
      return {
        key: member.account.key,
        name: accountName(member.account),
        left: 100 - Math.max(0, Math.min(100, member.window.usedPercent)),
        resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
        periodMs: (member.window.windowDurationMins ?? 0) * MINUTE_MS || WEEK_MS,
      };
    });
    return [
      {
        driver: String(pool.driver),
        windowLabel: window.label,
        accounts,
        capacity: accounts.length * 100,
        left: accounts.reduce((sum, account) => sum + account.left, 0),
      },
    ];
  });
}

/**
 * Tokens in [from, to) from day totals, spreading each day evenly over its elapsed part (today
 * only up to `now`).
 */
export function tokensBetween(
  tokensByDay: ReadonlyMap<string, number>,
  from: number,
  to: number,
  now: number,
): number {
  if (to <= from) return 0;
  let total = 0;
  let day = startOfLocalDay(new Date(from));
  while (day.getTime() < to) {
    const next = addLocalDays(day, 1);
    const start = day.getTime();
    const end = Math.min(next.getTime(), now);
    const tokens = tokensByDay.get(dayKey(day)) ?? 0;
    if (tokens > 0 && end > start) {
      const overlap = Math.max(0, Math.min(end, to) - Math.max(start, from));
      total += (tokens * overlap) / (end - start);
    }
    day = next;
  }
  return total;
}

export type BurnSource = "tokens" | "window" | "none";

export interface Burn {
  /** Percent points of the pool used per hour. */
  readonly perHour: number;
  readonly source: BurnSource;
  /** Diagnostics: points used this window and tokens behind them. */
  readonly pointsUsed: number;
  readonly tokensSinceStart: number;
  readonly recentTokensPerHour: number;
}

const RECENT_BURN_MS = 3 * DAY_MS;

/**
 * Burn rate for one provider's pool. Preferred: the provider's token rate over the last three
 * days, priced at the percent each token has cost since the earliest of its windows started
 * (points used / tokens since then). Falls back to the window average (points used per hour
 * elapsed) when usage history has no tokens for the provider.
 */
export function estimateBurn(
  provider: PoolProvider,
  tokensByDay: ReadonlyMap<string, number>,
  now: number,
): Burn {
  const timed = provider.accounts.filter((account) => account.resetsAt !== null);
  const pointsUsed = timed.reduce((sum, account) => sum + (100 - account.left), 0);
  const none = {
    perHour: 0,
    source: "none" as const,
    pointsUsed,
    tokensSinceStart: 0,
    recentTokensPerHour: 0,
  };
  if (timed.length === 0) return none;
  const since = Math.min(...timed.map((account) => account.resetsAt! - account.periodMs));
  if (pointsUsed <= 0 || since >= now) return none;
  const tokensSinceStart = tokensBetween(tokensByDay, since, now, now);
  const recentFrom = now - RECENT_BURN_MS;
  const recentTokensPerHour =
    tokensBetween(tokensByDay, recentFrom, now, now) / (RECENT_BURN_MS / HOUR_MS);
  if (tokensSinceStart > 0) {
    return {
      perHour: (pointsUsed / tokensSinceStart) * recentTokensPerHour,
      source: "tokens",
      pointsUsed,
      tokensSinceStart,
      recentTokensPerHour,
    };
  }
  return {
    perHour: pointsUsed / ((now - since) / HOUR_MS),
    source: "window",
    pointsUsed,
    tokensSinceStart,
    recentTokensPerHour,
  };
}

export interface RefillEvent {
  readonly driver: string;
  readonly account: string;
  readonly at: number;
  readonly amount: number;
}

/** A stretch with nothing left: one provider's pool, or the whole pool. */
export interface DrySpan {
  readonly from: number;
  /** null when still dry at the end of the projection. */
  readonly to: number | null;
  /** to - from, null while open-ended. */
  readonly duration: number | null;
}

export interface ProviderDrySpan extends DrySpan {
  readonly driver: string;
}

export interface PoolProjection {
  readonly start: number;
  readonly step: number;
  /** Total percent left per provider at start + index * step. */
  readonly series: ReadonlyMap<string, ReadonlyArray<number>>;
  /** Percent left per account key at start + index * step. */
  readonly accountSeries: ReadonlyMap<string, ReadonlyArray<number>>;
  readonly refills: ReadonlyArray<RefillEvent>;
  /** Per provider, sorted by start. */
  readonly dry: ReadonlyArray<ProviderDrySpan>;
  /** When every provider is dry at once. */
  readonly poolDry: ReadonlyArray<DrySpan>;
}

function drySpan(from: number, to: number | null): DrySpan {
  return { from, to, duration: to === null ? null : to - from };
}

/** Where every list has a span at once; each list is sorted and non-overlapping. */
function intersectSpans(lists: ReadonlyArray<ReadonlyArray<DrySpan>>): ReadonlyArray<DrySpan> {
  if (lists.length === 0) return [];
  return lists.slice(1).reduce<ReadonlyArray<DrySpan>>(
    (current, next) =>
      current.flatMap((left) =>
        next.flatMap((right) => {
          const from = Math.max(left.from, right.from);
          const ends = [left.to, right.to].filter((to): to is number => to !== null);
          const to = ends.length === 0 ? null : Math.min(...ends);
          return to === null || to > from ? [drySpan(from, to)] : [];
        }),
      ),
    lists[0]!,
  );
}

/**
 * Drains each provider's pool at its burn rate, always from the account that resets soonest,
 * and refills an account to 100% at its reset (then every period after).
 */
export function projectPool(
  providers: ReadonlyArray<PoolProvider>,
  burnByDriver: ReadonlyMap<string, number>,
  now: number,
  end: number,
  step = 10 * MINUTE_MS,
): PoolProjection {
  const series = new Map<string, number[]>();
  const accountSeries = new Map<string, number[]>();
  const refills: RefillEvent[] = [];
  const dryByDriver: ProviderDrySpan[][] = [];
  const steps = Math.max(1, Math.ceil((end - now) / step));
  for (const provider of providers) {
    const burn = (burnByDriver.get(provider.driver) ?? 0) * (step / HOUR_MS);
    const state = provider.accounts.map((account) => ({ ...account }));
    const total = () => state.reduce((sum, account) => sum + account.left, 0);
    const dry: ProviderDrySpan[] = [];
    let emptySince: number | null = total() <= 1e-6 ? now : null;
    const values: number[] = [];
    const accountValues = state.map(() => [] as number[]);
    for (let index = 0; index <= steps; index += 1) {
      const t = now + index * step;
      for (const account of state) {
        while (account.resetsAt !== null && account.resetsAt <= t) {
          const amount = 100 - account.left;
          if (amount >= 0.5) {
            refills.push({
              driver: provider.driver,
              account: account.name,
              at: account.resetsAt,
              amount,
            });
          }
          if (emptySince !== null) {
            dry.push({ driver: provider.driver, ...drySpan(emptySince, account.resetsAt) });
            emptySince = null;
          }
          account.left = 100;
          account.resetsAt += account.periodMs;
        }
      }
      values.push(total());
      state.forEach((account, position) => accountValues[position]!.push(account.left));
      if (burn <= 0 || emptySince !== null) continue;
      let need = burn;
      const order = state
        .filter((account) => account.left > 0)
        .toSorted(
          (left, right) =>
            (left.resetsAt ?? Number.POSITIVE_INFINITY) -
            (right.resetsAt ?? Number.POSITIVE_INFINITY),
        );
      for (const account of order) {
        const take = Math.min(account.left, need);
        account.left -= take;
        need -= take;
        if (need <= 1e-9) break;
      }
      if (total() <= 1e-6) {
        emptySince = t + ((burn - need) / burn) * step;
      }
    }
    if (emptySince !== null) dry.push({ driver: provider.driver, ...drySpan(emptySince, null) });
    series.set(provider.driver, values);
    state.forEach((account, position) => accountSeries.set(account.key, accountValues[position]!));
    dryByDriver.push(dry);
  }
  refills.sort((left, right) => left.at - right.at);
  return {
    start: now,
    step,
    series,
    accountSeries,
    refills,
    dry: dryByDriver.flat().toSorted((left, right) => left.from - right.from),
    poolDry: intersectSpans(dryByDriver),
  };
}

function seriesAt(
  projection: PoolProjection,
  values: ReadonlyArray<number> | undefined,
  t: number,
): number | null {
  if (!values || t < projection.start) return null;
  const index = Math.min(values.length - 1, Math.floor((t - projection.start) / projection.step));
  return values[index] ?? null;
}

export function projectedAt(projection: PoolProjection, driver: string, t: number): number | null {
  return seriesAt(projection, projection.series.get(driver), t);
}

export function projectedAccountAt(
  projection: PoolProjection,
  accountKey: string,
  t: number,
): number | null {
  return seriesAt(projection, projection.accountSeries.get(accountKey), t);
}

// Client-side history of the pool: the server keeps no past usedPercent.

export interface PoolSample {
  readonly t: number;
  /** driver -> [percent left, capacity] */
  readonly p: Readonly<Record<string, readonly [number, number]>>;
  /** account key -> percent left; older samples lack it. */
  readonly a?: Readonly<Record<string, number>>;
}

const POOL_SAMPLE_EVERY_MS = 10 * MINUTE_MS;
/** The chart shows at most a day of history; a little more survives a reload near the edge. */
const POOL_SAMPLE_KEEP_MS = 2 * DAY_MS;

export function appendPoolSample(
  samples: ReadonlyArray<PoolSample>,
  sample: PoolSample,
): ReadonlyArray<PoolSample> {
  const filtered = samples.filter((entry) => sample.t - entry.t <= POOL_SAMPLE_KEEP_MS);
  const kept = filtered.length === samples.length ? samples : filtered;
  const last = kept.at(-1);
  if (last) {
    const same =
      JSON.stringify(last.p) === JSON.stringify(sample.p) &&
      JSON.stringify(last.a ?? null) === JSON.stringify(sample.a ?? null);
    if (sample.t < last.t) return kept;
    if (same && sample.t - last.t < POOL_SAMPLE_EVERY_MS) return kept;
  }
  return [...kept, sample].slice(-4000);
}

/** The latest sample at or before `t`, unless it is older than `maxGapMs`. */
export function sampleAt(
  samples: ReadonlyArray<PoolSample>,
  t: number,
  maxGapMs: number,
): PoolSample | null {
  let low = 0;
  let high = samples.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (samples[mid]!.t <= t) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (found < 0) return null;
  const sample = samples[found]!;
  return t - sample.t <= maxGapMs ? sample : null;
}

/**
 * Where the unbroken recorded history ending at `now` starts: walking back from `now`, no two
 * neighbouring samples are more than `maxGapMs` apart. Never more than `capMs` back; `now` when
 * nothing recent was recorded.
 */
export function recordedSince(
  samples: ReadonlyArray<PoolSample>,
  now: number,
  maxGapMs: number,
  capMs: number,
): number {
  let since = now;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const t = samples[index]!.t;
    if (t > now) continue;
    if (since - t > maxGapMs) break;
    since = t;
    if (since <= now - capMs) break;
  }
  return Math.max(now - capMs, since);
}

export interface HostSample {
  readonly t: number;
  readonly cpu: number | null;
}

export const HOST_HISTORY_MS = 60 * MINUTE_MS;
const HOST_SAMPLE_EVERY_MS = 15_000;
/** A reading stands in for later columns until it is this old; past that the chart shows a gap. */
const HOST_SAMPLE_STALE_MS = 3 * HOST_SAMPLE_EVERY_MS;

export function appendHostSample(
  samples: ReadonlyArray<HostSample>,
  sample: HostSample,
): ReadonlyArray<HostSample> {
  const last = samples.at(-1);
  if (last && sample.t - last.t < HOST_SAMPLE_EVERY_MS) return samples;
  return [...samples.filter((entry) => sample.t - entry.t <= HOST_HISTORY_MS), sample];
}

export function hostSamplesFromHistory(
  history: HostCpuHistory,
  clientAheadOfServerMs: number,
): ReadonlyArray<HostSample> {
  const last = history.values.length - 1;
  return history.values.map((cpu, index) => ({
    t: history.endAt + clientAheadOfServerMs - (last - index) * history.intervalMs,
    cpu,
  }));
}

/**
 * One CPU value per column across the hour ending at `now`: the busiest reading in the column,
 * so a short spike survives, or the latest earlier reading while it is fresh.
 */
export function cpuColumns(
  samples: ReadonlyArray<HostSample>,
  now: number,
  columns: number,
): ReadonlyArray<number | null> {
  const start = now - HOST_HISTORY_MS;
  let index = 0;
  while (index < samples.length && samples[index]!.t <= start) index += 1;
  return Array.from({ length: columns }, (_, column) => {
    const end = start + ((column + 1) / columns) * HOST_HISTORY_MS;
    let peak: number | null = null;
    let any = false;
    while (index < samples.length && samples[index]!.t <= end) {
      const cpu = samples[index]!.cpu;
      if (cpu !== null) peak = Math.max(peak ?? 0, cpu);
      any = true;
      index += 1;
    }
    if (any) return peak;
    const previous = samples[index - 1];
    return previous && end - previous.t <= HOST_SAMPLE_STALE_MS ? previous.cpu : null;
  });
}

/** Quarter-hour marks inside the hour ending at `now`, as a fraction of the chart's width. */
export function hourAxisTicks(
  now: number,
): ReadonlyArray<{ readonly t: number; readonly x: number }> {
  const step = 15 * MINUTE_MS;
  const ticks = [];
  for (let t = Math.ceil((now - HOST_HISTORY_MS) / step) * step; t <= now; t += step) {
    ticks.push({ t, x: 1 - (now - t) / HOST_HISTORY_MS });
  }
  return ticks;
}

export function formatGigabytes(bytes: number): string {
  const value = bytes / 1024 ** 3;
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} GB`;
}
