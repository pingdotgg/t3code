// @effect-diagnostics globalDate:off
import type {
  UsageBucket,
  UsageCategoryCost,
  UsageDay,
  UsageResolution,
  UsageTokenTotals,
} from "@t3tools/contracts";

import { EMPTY_TOTALS, type UsageRecord } from "@t3tools/provider-core/server/usage";
import { cacheSavingsUsd, priceUsage, type RateTable } from "./usagePricing.ts";

/**
 * `en-CA` yields ISO-ordered parts, which is why it is used here rather than
 * assembling the day from `Date` getters (those are host-local only).
 */
function makeDayFormatter(timeZone: string): (timestampMs: number) => string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  // Formatting once per quarter-hour slot keeps `Intl` (about 2µs a call) off
  // the per-record path. Named zones put midnight on a quarter hour, so their
  // slots never split; a fixed offset such as `+00:01` can, and records in a
  // split slot are formatted exactly.
  const days = new Map<number, string | null>();
  return (timestampMs) => {
    const slot = Math.floor(timestampMs / QUARTER_HOUR_MS);
    let day = days.get(slot);
    if (day === undefined) {
      const first = format.format(new Date(slot * QUARTER_HOUR_MS));
      const last = format.format(new Date((slot + 1) * QUARTER_HOUR_MS - 1));
      day = first === last ? first : null;
      days.set(slot, day);
    }
    return day ?? format.format(new Date(timestampMs));
  };
}

const QUARTER_HOUR_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

interface MutableBucket {
  totals: { -readonly [K in keyof UsageTokenTotals]: number };
  costUsd: number;
  cacheSavingsUsd: number;
  categoryCostUsd: UsageCategoryCost | null;
  /** Retracting the last split contribution must leave no breakdown, not a zero one. */
  categorizedRecords: number;
  fastCostUsd: number;
  ultrafastCostUsd: number;
  speedPremiumUsd: number;
  records: number;
  unpricedRecords: number;
  providerReportedRecords: number;
  sessions: Set<string>;
}

export interface AggregateOptions {
  readonly timeZone: string;
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly rates: RateTable;
  readonly priceOverrides?: RateTable;
  readonly modelAliases?: ReadonlyMap<string, string>;
  readonly resolution?: UsageResolution;
  readonly sinceTimeMs?: number;
  readonly untilTimeMs?: number;
}

export function resolveModelAliases(
  aliases: Readonly<Record<string, string>>,
): ReadonlyMap<string, string> {
  const resolved = new Map<string, string>();
  for (const model of Object.keys(aliases)) {
    const seen = new Set([model]);
    let target = aliases[model]!;
    while (Object.hasOwn(aliases, target) && !seen.has(target)) {
      seen.add(target);
      target = aliases[target]!;
    }
    if (!Object.hasOwn(aliases, target)) resolved.set(model, target);
  }
  return resolved;
}

export interface AggregateResult {
  readonly buckets: readonly UsageBucket[];
  readonly duplicatesDropped: number;
  readonly outOfWindow: number;
}

/**
 * Copies sharing a `dedupeKey` are one billed message, but an early copy can
 * carry partial counts on any channel, so each channel's maximum is the
 * complete count whichever copy is read first. Every other field (time,
 * model, session, speed) stays with the held copy, so merging never moves
 * usage to another bucket. Returns `held` itself when `copy` adds nothing.
 */
export function mergeUsageCopies(held: UsageRecord, copy: UsageRecord): UsageRecord {
  const a = held.totals;
  const b = copy.totals;
  const reportedCostUsd =
    held.reportedCostUsd === null || copy.reportedCostUsd === null
      ? (held.reportedCostUsd ?? copy.reportedCostUsd)
      : Math.max(held.reportedCostUsd, copy.reportedCostUsd);
  if (
    b.uncachedInputTokens <= a.uncachedInputTokens &&
    b.cachedInputTokens <= a.cachedInputTokens &&
    b.cacheCreationTokens <= a.cacheCreationTokens &&
    b.outputTokens <= a.outputTokens &&
    b.reasoningTokens <= a.reasoningTokens &&
    reportedCostUsd === held.reportedCostUsd
  ) {
    return held;
  }
  return {
    ...held,
    totals: {
      uncachedInputTokens: Math.max(a.uncachedInputTokens, b.uncachedInputTokens),
      cachedInputTokens: Math.max(a.cachedInputTokens, b.cachedInputTokens),
      cacheCreationTokens: Math.max(a.cacheCreationTokens, b.cacheCreationTokens),
      outputTokens: Math.max(a.outputTokens, b.outputTokens),
      reasoningTokens: Math.max(a.reasoningTokens, b.reasoningTokens),
    },
    reportedCostUsd,
  };
}

const ZERO_CATEGORY_COST: UsageCategoryCost = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

interface Contribution {
  record: UsageRecord;
  /** Null when the first copy fell outside the window. */
  readonly bucket: MutableBucket | null;
}

/**
 * De-duplication is global across the whole scan, not per file: Claude Code
 * copies a message's records forward when a session is resumed or forked, so
 * the same `dedupeKey` legitimately appears in several transcripts. A replayed
 * copy can be partial or zeroed, so a richer copy read later replaces the held
 * copy's contribution instead of being dropped.
 */
export class UsageAggregator {
  readonly #buckets = new Map<string, MutableBucket>();
  readonly #seen = new Map<string, Contribution>();
  readonly #toDay: (timestampMs: number) => string;
  readonly #hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null;
  readonly #options: AggregateOptions;
  #lastBucket: {
    readonly day: string;
    readonly hourIndex: number;
    readonly provider: string;
    readonly model: string;
    readonly source: string;
    readonly bucket: MutableBucket;
  } | null = null;
  #duplicatesDropped = 0;
  #outOfWindow = 0;

  constructor(options: AggregateOptions) {
    this.#options = options;
    this.#toDay = makeDayFormatter(options.timeZone);
    if (options.resolution === "hour") {
      if (options.sinceTimeMs === undefined || options.untilTimeMs === undefined) {
        throw new Error("Hourly usage aggregation requires exact time bounds");
      }
      this.#hourlyWindow = {
        sinceTimeMs: options.sinceTimeMs,
        untilTimeMs: options.untilTimeMs,
      };
    } else {
      this.#hourlyWindow = null;
    }
  }

  add(input: UsageRecord, sourcePath?: string): boolean {
    const record = this.#mapModel(input);
    if (record.dedupeKey !== null) {
      const held = this.#seen.get(record.dedupeKey);
      if (held !== undefined) {
        this.#duplicatesDropped += 1;
        const merged = mergeUsageCopies(held.record, record);
        if (merged !== held.record) {
          if (held.bucket !== null) {
            this.#accumulate(held.bucket, held.record, -1);
            this.#accumulate(held.bucket, merged, 1);
          }
          held.record = merged;
        }
        return false;
      }
    }

    const bucket = this.#placeInWindow(record, sourcePath ?? "");
    if (record.dedupeKey !== null) this.#seen.set(record.dedupeKey, { record, bucket });
    if (bucket === null) {
      this.#outOfWindow += 1;
      return false;
    }
    this.#accumulate(bucket, record, 1);
    if (record.sessionId.length > 0) bucket.sessions.add(record.sessionId);
    return true;
  }

  #placeInWindow(record: UsageRecord, source: string): MutableBucket | null {
    if (
      this.#hourlyWindow !== null &&
      (record.timestampMs < this.#hourlyWindow.sinceTimeMs ||
        record.timestampMs >= this.#hourlyWindow.untilTimeMs)
    ) {
      return null;
    }

    const day = this.#toDay(record.timestampMs);
    if (
      this.#hourlyWindow === null &&
      (day < this.#options.sinceDay || day > this.#options.untilDay)
    ) {
      return null;
    }

    const hourIndex =
      this.#hourlyWindow === null
        ? -1
        : Math.floor((record.timestampMs - this.#hourlyWindow.sinceTimeMs) / HOUR_MS);
    return this.#bucketFor(day, hourIndex, record.provider, record.model, source);
  }

  #accumulate(bucket: MutableBucket, record: UsageRecord, sign: 1 | -1): void {
    const priced = priceUsage(this.#options.rates, record, this.#options.priceOverrides);

    const totals = bucket.totals;
    totals.uncachedInputTokens += sign * record.totals.uncachedInputTokens;
    totals.cachedInputTokens += sign * record.totals.cachedInputTokens;
    totals.cacheCreationTokens += sign * record.totals.cacheCreationTokens;
    totals.outputTokens += sign * record.totals.outputTokens;
    totals.reasoningTokens += sign * record.totals.reasoningTokens;
    bucket.costUsd += sign * priced.costUsd;
    if (priced.categoryCostUsd !== null) {
      bucket.categorizedRecords += sign;
      const sum = bucket.categoryCostUsd ?? ZERO_CATEGORY_COST;
      const add = priced.categoryCostUsd;
      bucket.categoryCostUsd =
        bucket.categorizedRecords === 0
          ? null
          : {
              input: sum.input + sign * add.input,
              cacheRead: sum.cacheRead + sign * add.cacheRead,
              cacheWrite: sum.cacheWrite + sign * add.cacheWrite,
              output: sum.output + sign * add.output,
            };
    }
    if (record.speed === "fast") bucket.fastCostUsd += sign * priced.costUsd;
    if (record.speed === "ultrafast") bucket.ultrafastCostUsd += sign * priced.costUsd;
    bucket.speedPremiumUsd += sign * priced.speedPremiumUsd;
    bucket.cacheSavingsUsd +=
      sign * cacheSavingsUsd(this.#options.rates, record, this.#options.priceOverrides);
    bucket.records += sign;
    if (priced.costSource === "unpriced") bucket.unpricedRecords += sign;
    if (priced.costSource === "providerReported") bucket.providerReportedRecords += sign;
  }

  /** The target's own rate applies, so a provider-specific `rateModel` is dropped. */
  #mapModel(record: UsageRecord): UsageRecord {
    const model = this.#options.modelAliases?.get(record.model);
    if (model === undefined) return record;
    const { rateModel: _rateModel, ...rest } = record;
    return { ...rest, model };
  }

  /**
   * Records arrive file by file in time order, so most land in the bucket the
   * previous record used. Checking that first skips building and hashing a
   * key string per record.
   */
  #bucketFor(
    day: string,
    hourIndex: number,
    provider: string,
    model: string,
    source: string,
  ): MutableBucket {
    const last = this.#lastBucket;
    if (
      last !== null &&
      last.day === day &&
      last.hourIndex === hourIndex &&
      last.provider === provider &&
      last.model === model &&
      last.source === source
    ) {
      return last.bucket;
    }
    const window = this.#hourlyWindow;
    const hourStart =
      window === null ? "" : new Date(window.sinceTimeMs + hourIndex * HOUR_MS).toISOString();
    const key = `${day}\u0000${hourStart}\u0000${provider}\u0000${model}\u0000${source}`;
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        totals: { ...EMPTY_TOTALS },
        costUsd: 0,
        cacheSavingsUsd: 0,
        categoryCostUsd: null,
        categorizedRecords: 0,
        fastCostUsd: 0,
        ultrafastCostUsd: 0,
        speedPremiumUsd: 0,
        records: 0,
        unpricedRecords: 0,
        providerReportedRecords: 0,
        sessions: new Set<string>(),
      };
      this.#buckets.set(key, bucket);
    }
    this.#lastBucket = { day, hourIndex, provider, model, source, bucket };
    return bucket;
  }

  finish(): AggregateResult {
    const buckets: UsageBucket[] = [];
    for (const [key, bucket] of this.#buckets) {
      const [day = "", hourStart = "", provider = "", model = "", sourcePath = ""] =
        key.split("\u0000");
      const category = bucket.categoryCostUsd;
      const fastCostUsd = roundUsd(bucket.fastCostUsd);
      const ultrafastCostUsd = roundUsd(bucket.ultrafastCostUsd);
      const speedPremiumUsd = roundUsd(bucket.speedPremiumUsd);
      buckets.push({
        day: day as UsageDay,
        ...(hourStart === "" ? {} : { hourStart }),
        provider: provider as UsageBucket["provider"],
        model,
        ...(sourcePath === "" ? {} : { sourcePath }),
        totals: { ...bucket.totals },
        costUsd: bucket.costUsd,
        cacheSavingsUsd: bucket.cacheSavingsUsd,
        ...(category === null
          ? {}
          : {
              categoryCostUsd: {
                input: roundUsd(category.input),
                cacheRead: roundUsd(category.cacheRead),
                cacheWrite: roundUsd(category.cacheWrite),
                output: roundUsd(category.output),
              },
            }),
        ...(fastCostUsd === 0 ? {} : { fastCostUsd }),
        ...(ultrafastCostUsd === 0 ? {} : { ultrafastCostUsd }),
        ...(speedPremiumUsd === 0 ? {} : { speedPremiumUsd }),
        costSource: resolveCostSource(bucket),
        records: bucket.records,
        unpricedRecords: bucket.unpricedRecords,
        sessions: bucket.sessions.size,
      });
    }
    buckets.sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        (a.hourStart ?? "").localeCompare(b.hourStart ?? "") ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    );

    return {
      buckets,
      duplicatesDropped: this.#duplicatesDropped,
      outOfWindow: this.#outOfWindow,
    };
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function resolveCostSource(bucket: MutableBucket): UsageBucket["costSource"] {
  if (bucket.unpricedRecords === bucket.records) return "unpriced";
  if (bucket.providerReportedRecords === bucket.records) return "providerReported";
  return "modelPriced";
}
