// @effect-diagnostics globalDate:off
/**
 * Folds parsed transcript records into `(day, hourStart?, project, provider,
 * model)` buckets.
 *
 * `Intl.DateTimeFormat` is the only reliable way to resolve a wall-clock day in
 * an arbitrary IANA zone, and it takes a `Date`. That is why the raw `Date`
 * construction is allowed here; nothing in this module reads the clock.
 *
 * Pure, so the bucketing and accumulation rules are testable without touching
 * the filesystem or the network. Callers apply any source-scoped deduplication
 * before adding transcript records.
 *
 * @module usageAggregation
 */
import type {
  ProjectId,
  UsageBucket,
  UsageDay,
  UsageResolution,
  UsageTokenTotals,
} from "@t3tools/contracts";

import { normalizeUsagePath } from "./usagePaths.ts";
import { addTotals, EMPTY_TOTALS, type UsageRecord } from "./usageTranscripts.ts";
import { cacheSavingsUsd, cacheWriteUsd, priceUsage, type RateTable } from "./usagePricing.ts";

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

export interface ProjectRoot {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly title: string;
  /** Soft-deleted projects still attribute: the spend happened while they existed. */
  readonly deleted: boolean;
}

export interface ProjectAttribution {
  readonly projectId: ProjectId;
  readonly title: string;
}

/**
 * Builds the cwd → project resolver used by {@link AggregateOptions}.
 *
 * Deepest root wins, so a session in a project nested inside another
 * attributes to the inner one. Live projects outrank deleted ones sharing a
 * root, since deleting and re-creating a project leaves both rows. Results are
 * memoised per cwd; a scan sees few distinct cwds but many records.
 */
export function makeProjectResolver(
  projects: readonly ProjectRoot[],
): (cwd: string) => ProjectAttribution | null {
  const roots = projects
    .map((project) => ({
      projectId: project.projectId,
      root: project.workspaceRoot.length === 0 ? "" : normalizeUsagePath(project.workspaceRoot),
      title: project.title.trim(),
      deleted: project.deleted,
    }))
    .filter((entry) => entry.root.length > 0 && entry.title.length > 0)
    .sort((a, b) => b.root.length - a.root.length || Number(a.deleted) - Number(b.deleted));

  const byCwd = new Map<string, ProjectAttribution | null>();
  return (cwd) => {
    if (cwd.length === 0) return null;
    const normalizedCwd = normalizeUsagePath(cwd);
    if (byCwd.has(normalizedCwd)) return byCwd.get(normalizedCwd) ?? null;
    let resolved: ProjectAttribution | null = null;
    for (const { projectId, root, title } of roots) {
      if (
        normalizedCwd === root ||
        (root === "/" ? normalizedCwd.startsWith("/") : normalizedCwd.startsWith(`${root}/`))
      ) {
        resolved = { projectId, title };
        break;
      }
    }
    byCwd.set(normalizedCwd, resolved);
    return resolved;
  };
}

interface MutableBucket {
  totals: UsageTokenTotals;
  costUsd: number;
  cacheSavingsUsd: number;
  cacheWriteUsd: number;
  cacheWriteComplete: boolean;
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
  readonly resolution?: UsageResolution;
  readonly sinceTimeMs?: number;
  readonly untilTimeMs?: number;
  /**
   * Maps a record's working directory to the project it ran in, or `null` when
   * it ran outside every project. Omitting it leaves every bucket unattributed.
   */
  readonly resolveProject?: (cwd: string) => ProjectAttribution | null;
}

export interface AggregateResult {
  readonly buckets: readonly UsageBucket[];
  /** Records dropped because an earlier record carried the same dedupe key. */
  readonly duplicatesDropped: number;
  /** Retained records whose day fell outside the requested window. */
  readonly outOfWindow: number;
}

/** A pre-aggregated UTC quarter-hour cell read from the durable ledger. */
export interface NormalizedUsageAggregate {
  readonly bucketStartMs: number;
  readonly provider: UsageRecord["provider"];
  readonly model: string;
  readonly projectId?: ProjectId;
  readonly project?: string;
  readonly projectAttribution?: UsageBucket["projectAttribution"];
  readonly totals: UsageTokenTotals;
  /** Tokens from records priced by the model table, excluding reported costs. */
  readonly pricedTotals: UsageTokenTotals;
  /** Cache tokens remain savings-eligible for provider-reported records. */
  readonly savingsTotals: UsageTokenTotals;
  /** Null-cost rows whose cache writes may be priced dynamically. */
  readonly cacheWriteTotals?: UsageTokenTotals;
  /** v1 rows need the current rate table to determine whether they are priced. */
  readonly legacyPricing?: boolean;
  /** v3 rows retain every null-cost token total for dynamic repricing. */
  readonly dynamicPricing?: boolean;
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
  readonly #recordsByKey = new Map<string, UsageRecord>();
  readonly #unkeyedRecords: UsageRecord[] = [];
  readonly #toDay: (timestampMs: number) => string;
  readonly #hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null;
  readonly #options: AggregateOptions;
  #outOfWindow = 0;
  #duplicatesDropped = 0;

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

  /** Retains one record and reports whether it falls in the requested window. */
  add(record: UsageRecord, dedupeScope = ""): boolean {
    const inWindow = this.#isInWindow(record);
    if (record.dedupeKey === null) {
      this.#unkeyedRecords.push(record);
      return inWindow;
    }
    const dedupeKey = `${dedupeScope}\u0000${record.dedupeKey}`;
    if (this.#recordsByKey.has(dedupeKey)) {
      // Claude writes progressive snapshots for one response. The final copy
      // is complete, so replace the earlier one without counting it twice.
      this.#recordsByKey.set(dedupeKey, record);
      this.#duplicatesDropped += 1;
      return inWindow;
    }
    this.#recordsByKey.set(dedupeKey, record);
    return inWindow;
  }

  #isInWindow(record: UsageRecord): boolean {
    if (
      this.#hourlyWindow !== null &&
      (record.timestampMs < this.#hourlyWindow.sinceTimeMs ||
        record.timestampMs >= this.#hourlyWindow.untilTimeMs)
    ) {
      return false;
    }

    const day = this.#toDay(record.timestampMs);
    if (
      this.#hourlyWindow === null &&
      (day < this.#options.sinceDay || day > this.#options.untilDay)
    ) {
      return false;
    }
    return true;
  }

  /** Distinct in-window sessions retained after progressive snapshots settle. */
  distinctSessions(provider: UsageRecord["provider"]): number {
    const sessionIds = new Set<string>();
    const addSession = (record: UsageRecord): void => {
      if (this.#isInWindow(record) && record.provider === provider && record.sessionId.length > 0) {
        sessionIds.add(record.sessionId);
      }
    };
    for (const record of this.#unkeyedRecords) addSession(record);
    for (const record of this.#recordsByKey.values()) addSession(record);
    return sessionIds.size;
  }

  #foldRecord(record: UsageRecord, buckets: Map<string, MutableBucket>): void {
    const day = this.#toDay(record.timestampMs);

    const hourStart =
      this.#hourlyWindow === null
        ? ""
        : new Date(
            this.#hourlyWindow.sinceTimeMs +
              Math.floor((record.timestampMs - this.#hourlyWindow.sinceTimeMs) / HOUR_MS) * HOUR_MS,
          ).toISOString();
    // The key is parsed back apart on NUL, which project fields must not carry.
    const resolvedProject = this.#options.resolveProject?.(record.cwd) ?? null;
    const projectAttribution =
      resolvedProject !== null
        ? "project"
        : this.#options.resolveProject === undefined || record.cwd.length === 0
          ? "unknown"
          : "outside";
    const projectId = resolvedProject?.projectId.replaceAll("\u0000", "") ?? "";
    const project = resolvedProject?.title.replaceAll("\u0000", "") ?? "";
    const key = `${day}\u0000${hourStart}\u0000${projectAttribution}\u0000${projectId}\u0000${project}\u0000${record.provider}\u0000${record.model}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        totals: EMPTY_TOTALS,
        costUsd: 0,
        cacheSavingsUsd: 0,
        cacheWriteUsd: 0,
        cacheWriteComplete: true,
        records: 0,
        unpricedRecords: 0,
        providerReportedRecords: 0,
        sessions: new Set<string>(),
      };
      buckets.set(key, bucket);
    }

    const priced = priceUsage(
      this.#options.rates,
      record.model,
      record.totals,
      record.reportedCostUsd,
      this.#options.priceOverrides,
    );

    bucket.totals = addTotals(bucket.totals, record.totals);
    bucket.costUsd += priced.costUsd;
    bucket.cacheSavingsUsd += cacheSavingsUsd(
      this.#options.rates,
      record.model,
      record.totals,
      this.#options.priceOverrides,
    );
    if (priced.costSource === "modelPriced") {
      bucket.cacheWriteUsd += cacheWriteUsd(
        this.#options.rates,
        record.model,
        record.totals,
        this.#options.priceOverrides,
      );
    } else if (record.totals.cacheCreationTokens > 0) {
      bucket.cacheWriteComplete = false;
    }
    bucket.records += 1;
    if (priced.costSource === "unpriced") bucket.unpricedRecords += 1;
    if (priced.costSource === "providerReported") bucket.providerReportedRecords += 1;
    if (record.sessionId.length > 0) bucket.sessions.add(record.sessionId);
  }

  /**
   * Folds one normalized UTC cell into a requested view. The caller has already
   * deduplicated ledger cells within each transcript-directory scope, so this
   * updates the counters in one step without a synthetic record per event.
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
    const projectAttribution = aggregate.projectAttribution ?? "unknown";
    const projectId = aggregate.projectId?.replaceAll("\u0000", "") ?? "";
    const project = aggregate.project?.replaceAll("\u0000", "") ?? "";
    const key = `${day}\u0000${hourStart}\u0000${projectAttribution}\u0000${projectId}\u0000${project}\u0000${aggregate.provider}\u0000${aggregate.model}`;
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        totals: EMPTY_TOTALS,
        costUsd: 0,
        cacheSavingsUsd: 0,
        cacheWriteUsd: 0,
        cacheWriteComplete: true,
        records: 0,
        unpricedRecords: 0,
        providerReportedRecords: 0,
        sessions: new Set<string>(),
      };
      this.#buckets.set(key, bucket);
    }

    const hasPriceOverride = this.#options.priceOverrides?.has(aggregate.model.trim()) === true;
    const priced = priceUsage(
      this.#options.rates,
      aggregate.model,
      hasPriceOverride ? aggregate.totals : aggregate.pricedTotals,
      null,
      this.#options.priceOverrides,
    );
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
    const unpricedRecords = hasPriceOverride
      ? 0
      : aggregate.dynamicPricing === true
        ? priced.costSource === "unpriced"
          ? aggregate.records - aggregate.providerReportedRecords
          : 0
        : aggregate.legacyPricing === true
          ? legacyUnpricedRecords
          : aggregate.unpricedRecords + unpricedByMissingRates;
    bucket.totals = addTotals(bucket.totals, aggregate.totals);
    bucket.costUsd +=
      (hasPriceOverride ? 0 : aggregate.reportedCostUsd) + (legacyUnpriced ? 0 : priced.costUsd);
    bucket.cacheSavingsUsd += cacheSavingsUsd(
      this.#options.rates,
      aggregate.model,
      aggregate.savingsTotals,
      this.#options.priceOverrides,
    );
    const cacheWriteTotals = hasPriceOverride ? aggregate.totals : aggregate.cacheWriteTotals;
    if (cacheWriteTotals === undefined && aggregate.totals.cacheCreationTokens > 0) {
      // Pre-v4 ledgers did not retain cache-write TTL provenance. Keep their
      // usage and overall cost, but do not present a base-rate guess as a
      // complete cache-write estimate.
      bucket.cacheWriteComplete = false;
    } else if (cacheWriteTotals !== undefined && cacheWriteTotals.cacheCreationTokens > 0) {
      const cacheWritePricing = priceUsage(
        this.#options.rates,
        aggregate.model,
        cacheWriteTotals,
        null,
        this.#options.priceOverrides,
      );
      if (cacheWritePricing.costSource === "modelPriced") {
        bucket.cacheWriteUsd += cacheWriteUsd(
          this.#options.rates,
          aggregate.model,
          cacheWriteTotals,
          this.#options.priceOverrides,
        );
      } else {
        bucket.cacheWriteComplete = false;
      }
    }
    bucket.records += aggregate.records;
    bucket.unpricedRecords += unpricedRecords;
    bucket.providerReportedRecords += hasPriceOverride ? 0 : aggregate.providerReportedRecords;
    for (const session of aggregate.sessions) bucket.sessions.add(session);
    return true;
  }

  finish(): AggregateResult {
    const bucketsByKey = new Map(this.#buckets);
    let outOfWindow = this.#outOfWindow;
    const foldIfInWindow = (record: UsageRecord): void => {
      if (this.#isInWindow(record)) {
        this.#foldRecord(record, bucketsByKey);
      } else {
        outOfWindow += 1;
      }
    };
    for (const record of this.#unkeyedRecords) foldIfInWindow(record);
    for (const record of this.#recordsByKey.values()) foldIfInWindow(record);
    const buckets: UsageBucket[] = [];
    for (const [key, bucket] of bucketsByKey) {
      const [
        day = "",
        hourStart = "",
        projectAttribution = "unknown",
        projectId = "",
        project = "",
        provider = "",
        model = "",
      ] = key.split("\u0000");
      buckets.push({
        day: day as UsageDay,
        ...(hourStart === "" ? {} : { hourStart }),
        ...(project === "" ? {} : { project }),
        ...(projectId === "" ? {} : { projectId: projectId as ProjectId }),
        projectAttribution: projectAttribution as UsageBucket["projectAttribution"],
        provider: provider as UsageBucket["provider"],
        model,
        totals: bucket.totals,
        costUsd: bucket.costUsd,
        cacheSavingsUsd: bucket.cacheSavingsUsd,
        ...(bucket.cacheWriteComplete ? { cacheWriteUsd: bucket.cacheWriteUsd } : {}),
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
        (a.project ?? "").localeCompare(b.project ?? "") ||
        (a.projectId ?? "").localeCompare(b.projectId ?? "") ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    );

    return {
      buckets,
      duplicatesDropped: this.#duplicatesDropped,
      outOfWindow,
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
