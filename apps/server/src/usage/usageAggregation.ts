// @effect-diagnostics globalDate:off
/**
 * Folds parsed transcript records into `(day, hourStart?, provider, model)`
 * buckets.
 *
 * `Intl.DateTimeFormat` is the only reliable way to resolve a wall-clock day in
 * an arbitrary IANA zone, and it takes a `Date`. That is why the raw `Date`
 * construction is allowed here; nothing in this module reads the clock.
 *
 * Pure, so the bucketing and de-duplication rules are testable without touching
 * the filesystem or the network.
 *
 * @module usageAggregation
 */
import type { UsageBucket, UsageDay, UsageResolution, UsageTokenTotals } from "@t3tools/contracts";

import { addTotals, EMPTY_TOTALS, type UsageRecord } from "./usageTranscripts.ts";
import { cacheSavingsUsd, priceUsage, type RateTable } from "./usagePricing.ts";

/**
 * Formats an instant as a `YYYY-MM-DD` day in `timeZone`.
 *
 * `en-CA` yields ISO-ordered parts, which is why it is used here rather than
 * assembling the day from `Date` getters (those are host-local only).
 */
export function makeDayFormatter(timeZone: string): (timestampMs: number) => string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    // An unknown zone should degrade to UTC rather than fail the whole scan.
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  return (timestampMs) => format.format(new Date(timestampMs));
}

const HOUR_MS = 60 * 60 * 1000;

interface MutableBucket {
  totals: UsageTokenTotals;
  costUsd: number;
  cacheSavingsUsd: number;
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
  readonly resolution?: UsageResolution;
  readonly sinceTimeMs?: number;
  readonly untilTimeMs?: number;
}

export interface AggregateResult {
  readonly buckets: readonly UsageBucket[];
  /** Records whose day fell outside the requested window. */
  readonly outOfWindow: number;
}

/** A pre-aggregated UTC quarter-hour cell read from the durable ledger. */
export interface NormalizedUsageAggregate {
  readonly bucketStartMs: number;
  readonly provider: UsageRecord["provider"];
  readonly model: string;
  readonly totals: UsageTokenTotals;
  /** Tokens from records priced by the model table, excluding reported costs. */
  readonly pricedTotals: UsageTokenTotals;
  /** Cache tokens remain savings-eligible for provider-reported records. */
  readonly savingsTotals: UsageTokenTotals;
  /** v1 rows need the current rate table to determine whether they are priced. */
  readonly legacyPricing?: boolean;
  /** Number of null-cost v1 rows represented by this aggregate. */
  readonly legacyPricingRecords?: number;
  readonly reportedCostUsd: number;
  readonly records: number;
  readonly unpricedRecords: number;
  readonly providerReportedRecords: number;
  readonly sessions: readonly string[];
}

/**
 * Accumulates records across many files. Callers own transcript identity and
 * must deduplicate records before adding them when their source format has a
 * stable dedupe key.
 */
export class UsageAggregator {
  readonly #buckets = new Map<string, MutableBucket>();
  readonly #toDay: (timestampMs: number) => string;
  readonly #hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null;
  readonly #options: AggregateOptions;
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

  /**
   * Folds one record in. Returns whether it actually contributed, so callers
   * can derive per-window facts (distinct sessions, for one) from the records
   * that landed rather than everything the mtime prefilter happened to admit.
   */
  add(record: UsageRecord): boolean {
    if (
      this.#hourlyWindow !== null &&
      (record.timestampMs < this.#hourlyWindow.sinceTimeMs ||
        record.timestampMs >= this.#hourlyWindow.untilTimeMs)
    ) {
      this.#outOfWindow += 1;
      return false;
    }

    const day = this.#toDay(record.timestampMs);
    if (
      this.#hourlyWindow === null &&
      (day < this.#options.sinceDay || day > this.#options.untilDay)
    ) {
      this.#outOfWindow += 1;
      return false;
    }

    const hourStart =
      this.#hourlyWindow === null
        ? ""
        : new Date(
            this.#hourlyWindow.sinceTimeMs +
              Math.floor((record.timestampMs - this.#hourlyWindow.sinceTimeMs) / HOUR_MS) * HOUR_MS,
          ).toISOString();
    const key = `${day}\u0000${hourStart}\u0000${record.provider}\u0000${record.model}`;
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        totals: EMPTY_TOTALS,
        costUsd: 0,
        cacheSavingsUsd: 0,
        records: 0,
        unpricedRecords: 0,
        providerReportedRecords: 0,
        sessions: new Set<string>(),
      };
      this.#buckets.set(key, bucket);
    }

    const priced = priceUsage(
      this.#options.rates,
      record.model,
      record.totals,
      record.reportedCostUsd,
    );

    bucket.totals = addTotals(bucket.totals, record.totals);
    bucket.costUsd += priced.costUsd;
    bucket.cacheSavingsUsd += cacheSavingsUsd(this.#options.rates, record.model, record.totals);
    bucket.records += 1;
    if (priced.costSource === "unpriced") bucket.unpricedRecords += 1;
    if (priced.costSource === "providerReported") bucket.providerReportedRecords += 1;
    if (record.sessionId.length > 0) bucket.sessions.add(record.sessionId);
    return true;
  }

  /**
   * Folds one normalized UTC cell into a requested view. Ledger cells have
   * already been globally de-duplicated, so this updates the counters in one
   * step and does not need a synthetic record per transcript event.
   */
  addAggregate(aggregate: NormalizedUsageAggregate): boolean {
    if (
      this.#hourlyWindow !== null &&
      (aggregate.bucketStartMs < this.#hourlyWindow.sinceTimeMs ||
        aggregate.bucketStartMs >= this.#hourlyWindow.untilTimeMs)
    ) {
      this.#outOfWindow += aggregate.records;
      return false;
    }

    const day = this.#toDay(aggregate.bucketStartMs);
    if (
      this.#hourlyWindow === null &&
      (day < this.#options.sinceDay || day > this.#options.untilDay)
    ) {
      this.#outOfWindow += aggregate.records;
      return false;
    }

    const hourStart =
      this.#hourlyWindow === null
        ? ""
        : new Date(
            this.#hourlyWindow.sinceTimeMs +
              Math.floor((aggregate.bucketStartMs - this.#hourlyWindow.sinceTimeMs) / HOUR_MS) *
                HOUR_MS,
          ).toISOString();
    const key = `${day}\u0000${hourStart}\u0000${aggregate.provider}\u0000${aggregate.model}`;
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        totals: EMPTY_TOTALS,
        costUsd: 0,
        cacheSavingsUsd: 0,
        records: 0,
        unpricedRecords: 0,
        providerReportedRecords: 0,
        sessions: new Set<string>(),
      };
      this.#buckets.set(key, bucket);
    }

    const priced = priceUsage(this.#options.rates, aggregate.model, aggregate.pricedTotals, null);
    // v1 cells did not persist pricing provenance, so their null-cost rows
    // are recovered through `legacyPricingRecords`. v2 cells do persist it,
    // but a missing or corrupt rate cache can still make a previously priced
    // cell unpriced on read. Count the records not already accounted for by
    // stored unpriced/provider-reported provenance in that case.
    const unpricedByMissingRates =
      priced.costSource === "unpriced"
        ? Math.max(
            0,
            aggregate.records - aggregate.unpricedRecords - aggregate.providerReportedRecords,
          )
        : 0;
    const legacyUnpriced = aggregate.legacyPricing === true && priced.costSource === "unpriced";
    const legacyUnpricedRecords =
      aggregate.legacyPricing === true && priced.costSource === "unpriced"
        ? (aggregate.legacyPricingRecords ?? unpricedByMissingRates)
        : 0;
    const unpricedRecords =
      aggregate.legacyPricing === true
        ? legacyUnpricedRecords
        : aggregate.unpricedRecords + unpricedByMissingRates;
    bucket.totals = addTotals(bucket.totals, aggregate.totals);
    bucket.costUsd += aggregate.reportedCostUsd + (legacyUnpriced ? 0 : priced.costUsd);
    bucket.cacheSavingsUsd += cacheSavingsUsd(
      this.#options.rates,
      aggregate.model,
      aggregate.savingsTotals,
    );
    bucket.records += aggregate.records;
    bucket.unpricedRecords += unpricedRecords;
    bucket.providerReportedRecords += aggregate.providerReportedRecords;
    for (const session of aggregate.sessions) bucket.sessions.add(session);
    return true;
  }

  finish(): AggregateResult {
    const buckets: UsageBucket[] = [];
    for (const [key, bucket] of this.#buckets) {
      const [day = "", hourStart = "", provider = "", model = ""] = key.split("\u0000");
      buckets.push({
        day: day as UsageDay,
        ...(hourStart === "" ? {} : { hourStart }),
        provider: provider as UsageBucket["provider"],
        model,
        totals: bucket.totals,
        costUsd: bucket.costUsd,
        cacheSavingsUsd: bucket.cacheSavingsUsd,
        costSource: resolveCostSource(bucket),
        records: bucket.records,
        unpricedRecords: bucket.unpricedRecords,
        sessions: bucket.sessions.size,
      });
    }
    // Stable ordering keeps payloads diffable and snapshot tests meaningful.
    buckets.sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        (a.hourStart ?? "").localeCompare(b.hourStart ?? "") ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    );

    return {
      buckets,
      outOfWindow: this.#outOfWindow,
    };
  }
}

/**
 * A bucket mixes records from one model, but their cost provenance can differ
 * when only some records carried a reported cost. The weakest provenance in the
 * bucket wins so the UI never overstates confidence.
 */
function resolveCostSource(bucket: MutableBucket): UsageBucket["costSource"] {
  if (bucket.unpricedRecords === bucket.records) return "unpriced";
  if (bucket.providerReportedRecords === bucket.records) return "providerReported";
  return "modelPriced";
}
