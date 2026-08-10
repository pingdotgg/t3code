/**
 * Folds persisted Cursor usage events into `(day, model, usageType)` buckets
 * shaped like `UsageBucket`, so they can be appended alongside the Claude and
 * Codex buckets `UsageService` already produces.
 *
 * Bucketing is done here, in application code, against the caller's
 * requested time zone - the same approach `usageAggregation.ts` uses for the
 * file-scanned providers - rather than in SQL against a timezone-agnostic
 * stored day, so a change of reporting time zone does not require
 * re-ingesting events.
 *
 * @module CursorUsageAggregation
 */
import type { CursorUsageEvent, UsageBucket, UsageDay } from "@t3tools/contracts";

export interface CursorUsageAggregationInput {
  readonly events: readonly CursorUsageEvent[];
  readonly timeZone: string;
}

interface BucketAccumulator {
  day: UsageDay;
  model: string;
  usageType: "included" | "onDemand";
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  rawCostCents: number;
  chargedCents: number;
  records: number;
  unpricedRecords: number;
}

const dayFormatterCache = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = dayFormatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  dayFormatterCache.set(timeZone, formatter);
  return formatter;
}

/** `YYYY-MM-DD` in `timeZone`, matching `usageAggregation.ts`'s day bucketing. */
function toDayInTimeZone(occurredAt: string, timeZone: string): UsageDay {
  return dayFormatter(timeZone).format(Date.parse(occurredAt)) as UsageDay;
}

export function aggregateCursorUsageBuckets(input: CursorUsageAggregationInput): UsageBucket[] {
  const accumulators = new Map<string, BucketAccumulator>();

  for (const event of input.events) {
    const day = toDayInTimeZone(event.occurredAt, input.timeZone);
    const key = `${day} ${event.model} ${event.usageType}`;
    const accumulator = accumulators.get(key) ?? {
      day,
      model: event.model,
      usageType: event.usageType,
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      rawCostCents: 0,
      chargedCents: 0,
      records: 0,
      unpricedRecords: 0,
    };

    accumulator.uncachedInputTokens += event.inputTokens ?? 0;
    accumulator.cachedInputTokens += event.cacheReadTokens ?? 0;
    accumulator.cacheCreationTokens += event.cacheWriteTokens ?? 0;
    accumulator.outputTokens += event.outputTokens ?? 0;
    accumulator.records += 1;
    if (event.rawCostCents === undefined) {
      accumulator.unpricedRecords += 1;
    } else {
      accumulator.rawCostCents += event.rawCostCents;
    }
    if (event.chargedCents !== undefined) {
      accumulator.chargedCents += event.chargedCents;
    }

    accumulators.set(key, accumulator);
  }

  return [...accumulators.values()]
    .map(
      (accumulator): UsageBucket => ({
        day: accumulator.day,
        provider: "cursor",
        model: accumulator.model,
        totals: {
          uncachedInputTokens: accumulator.uncachedInputTokens,
          cachedInputTokens: accumulator.cachedInputTokens,
          cacheCreationTokens: accumulator.cacheCreationTokens,
          outputTokens: accumulator.outputTokens,
          reasoningTokens: 0,
        },
        costUsd: accumulator.rawCostCents / 100,
        cacheSavingsUsd: 0,
        costSource:
          accumulator.unpricedRecords === accumulator.records ? "unpriced" : "providerReported",
        records: accumulator.records,
        unpricedRecords: accumulator.unpricedRecords,
        sessions: 0,
        usageType: accumulator.usageType,
        chargedUsd: accumulator.chargedCents / 100,
      }),
    )
    .sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model));
}
