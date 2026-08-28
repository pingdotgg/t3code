// @effect-diagnostics globalDate:off
/**
 * Folds parsed transcript records into `(day, hourStart?, project, provider,
 * model)` buckets.
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

export interface ProjectRoot {
  readonly workspaceRoot: string;
  readonly title: string;
  /** Soft-deleted projects still attribute: the spend happened while they existed. */
  readonly deleted: boolean;
}

/**
 * Builds the cwd → project-title resolver used by {@link AggregateOptions}.
 *
 * Deepest root wins, so a session in a project nested inside another
 * attributes to the inner one. Live projects outrank deleted ones sharing a
 * root, since deleting and re-creating a project leaves both rows. Results are
 * memoised per cwd; a scan sees few distinct cwds but many records.
 */
export function makeProjectResolver(
  projects: readonly ProjectRoot[],
  separator: string,
): (cwd: string) => string {
  const roots = projects
    .map((project) => ({
      root:
        project.workspaceRoot.length > 1 && project.workspaceRoot.endsWith(separator)
          ? project.workspaceRoot.slice(0, -1)
          : project.workspaceRoot,
      title: project.title.trim(),
      deleted: project.deleted,
    }))
    .filter((entry) => entry.root.length > 0 && entry.title.length > 0)
    .sort((a, b) => b.root.length - a.root.length || Number(a.deleted) - Number(b.deleted));

  const byCwd = new Map<string, string>();
  return (cwd) => {
    if (cwd.length === 0) return "";
    const cached = byCwd.get(cwd);
    if (cached !== undefined) return cached;
    let resolved = "";
    for (const { root, title } of roots) {
      if (cwd === root || (cwd.startsWith(root) && cwd[root.length] === separator)) {
        resolved = title;
        break;
      }
    }
    byCwd.set(cwd, resolved);
    return resolved;
  };
}

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
  /**
   * Maps a record's working directory to the title of the project it ran in,
   * or `""` when it ran outside every project. Omitting it leaves every bucket
   * unattributed.
   */
  readonly resolveProject?: (cwd: string) => string;
}

export interface AggregateResult {
  readonly buckets: readonly UsageBucket[];
  /** Records dropped because an earlier record carried the same dedupe key. */
  readonly duplicatesDropped: number;
  /** Records whose day fell outside the requested window. */
  readonly outOfWindow: number;
}

/**
 * Accumulates records across many files.
 *
 * De-duplication is global across the whole scan, not per file: Claude Code
 * copies a message's records forward when a session is resumed or forked, so
 * the same `dedupeKey` legitimately appears in several transcripts.
 */
export class UsageAggregator {
  readonly #buckets = new Map<string, MutableBucket>();
  readonly #seen = new Set<string>();
  readonly #toDay: (timestampMs: number) => string;
  readonly #hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null;
  readonly #options: AggregateOptions;
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

  /**
   * Folds one record in. Returns whether it actually contributed, so callers
   * can derive per-window facts (distinct sessions, for one) from the records
   * that landed rather than everything the mtime prefilter happened to admit.
   */
  add(record: UsageRecord): boolean {
    if (record.dedupeKey !== null) {
      if (this.#seen.has(record.dedupeKey)) {
        this.#duplicatesDropped += 1;
        return false;
      }
      this.#seen.add(record.dedupeKey);
    }

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
    // The key is parsed back apart on NUL, which project titles must not carry.
    const project =
      this.#options.resolveProject === undefined
        ? ""
        : this.#options.resolveProject(record.cwd).replaceAll("\u0000", "");
    const key = `${day}\u0000${hourStart}\u0000${project}\u0000${record.provider}\u0000${record.model}`;
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

  finish(): AggregateResult {
    const buckets: UsageBucket[] = [];
    for (const [key, bucket] of this.#buckets) {
      const [day = "", hourStart = "", project = "", provider = "", model = ""] =
        key.split("\u0000");
      buckets.push({
        day: day as UsageDay,
        ...(hourStart === "" ? {} : { hourStart }),
        ...(project === "" ? {} : { project }),
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
        (a.project ?? "").localeCompare(b.project ?? "") ||
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
