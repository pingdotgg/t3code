/**
 * Cursor account usage, cached per credential source.
 *
 * Cursor's dashboard API takes about 20 seconds for a 30-day window, so fetched
 * records are kept for the whole retention period, whatever window was asked
 * for. After one full fetch, a refresh fetches only the newest edge.
 *
 * A record's dedupe key carries its timestamp and an occurrence index counted
 * within one fetch. A refetched range therefore replaces every cached record in
 * that range rather than adding to it, so each timestamp's records always come
 * from a single fetch and their occurrence indexes cannot collide.
 *
 * @module cursorAccountCache
 */
import { cursorRateModel } from "./cursorUsageReader.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

export type CursorCredentialSource = string | { readonly kind: "keychain" };

/** Matches the clients' stale time, so a page refetching on focus reuses one fetch. */
export const CURSOR_ACCOUNT_TTL_MS = 60 * 1000;

/** Dashboard events can be finalized after they were first read. */
const REFETCH_OVERLAP_MS = 60 * 60 * 1000;

export interface CursorAccountCache {
  readonly accountKey: string;
  /** Inclusive range of event timestamps the records are complete for. */
  readonly sinceMs: number;
  readonly untilMs: number;
  /** When the newest edge was fetched. */
  readonly fetchedAtMs: number;
  readonly records: readonly UsageRecord[];
}

interface CursorFetchRange {
  readonly sinceMs: number;
  readonly untilMs: number;
}

/** Whether the cache answers without a refresh. */
export function isCursorCacheFresh(
  cache: CursorAccountCache | undefined,
  nowMs: number,
): cache is CursorAccountCache {
  return cache !== undefined && nowMs - cache.fetchedAtMs < CURSOR_ACCOUNT_TTL_MS;
}

/**
 * The range to fetch so the cache covers `[retentionStartMs, nowMs]`: the
 * newest edge, or everything when the cache does not reach back that far.
 */
export function cursorFetchRange(
  cache: CursorAccountCache | undefined,
  retentionStartMs: number,
  nowMs: number,
): CursorFetchRange {
  return cache === undefined ||
    cache.sinceMs > retentionStartMs ||
    cache.untilMs - REFETCH_OVERLAP_MS < retentionStartMs
    ? { sinceMs: retentionStartMs, untilMs: nowMs }
    : { sinceMs: cache.untilMs - REFETCH_OVERLAP_MS, untilMs: nowMs };
}

/**
 * Applies a fetched range to the cache, replacing the cached records it covers
 * and dropping those before the retention start. Pass `undefined` for a cache
 * that belongs to another account. `changed` is false when the fetch only
 * confirmed the cached records, so there is nothing new to persist.
 */
export function mergeCursorFetch(
  cache: CursorAccountCache | undefined,
  accountKey: string,
  range: CursorFetchRange,
  fetched: readonly UsageRecord[],
  nowMs: number,
  retentionStartMs: number,
) {
  const inRange = (record: UsageRecord) =>
    record.timestampMs >= range.sinceMs && record.timestampMs <= range.untilMs;
  const previous = cache?.records ?? [];
  const added = fetched.filter(inRange);
  const replacedKeys = new Set(previous.filter(inRange).map((record) => record.dedupeKey));
  const changed =
    cache === undefined ||
    replacedKeys.size !== added.length ||
    added.some((record) => !replacedKeys.has(record.dedupeKey));
  return {
    changed,
    cache: {
      accountKey,
      sinceMs: retentionStartMs,
      untilMs: range.untilMs,
      fetchedAtMs: nowMs,
      records: [
        ...previous.filter((record) => !inRange(record) && record.timestampMs >= retentionStartMs),
        ...added,
      ],
    } satisfies CursorAccountCache,
  };
}

/**
 * Each version writes its own file, as the scan cache does, so servers of
 * different versions sharing a state directory keep their own caches.
 */
export const CURSOR_ACCOUNT_CACHE_FILE_NAME = "usage-cursor-account-cache-v1.json";
const CURSOR_ACCOUNT_CACHE_VERSION = 1;

/** Positional rows with interned strings, as in the scan cache. */
type SerializedRecord = readonly [
  timestampMs: number,
  modelIndex: number,
  sessionIndex: number,
  uncachedInputTokens: number,
  cachedInputTokens: number,
  cacheCreationTokens: number,
  outputTokens: number,
  reportedCostUsd: number | null,
  dedupeKey: string | null,
];

interface SerializedAccount {
  readonly accountKey: string;
  readonly sinceMs: number;
  readonly untilMs: number;
  readonly fetchedAtMs: number;
  readonly records: readonly SerializedRecord[];
}

/** Serialises the caches by credential source. */
export function encodeCursorAccountCaches(caches: ReadonlyMap<string, CursorAccountCache>): string {
  const strings: string[] = [];
  const indexes = new Map<string, number>();
  const intern = (value: string) => {
    let index = indexes.get(value);
    if (index === undefined) {
      index = strings.length;
      strings.push(value);
      indexes.set(value, index);
    }
    return index;
  };
  const accounts: Record<string, SerializedAccount> = {};
  for (const [credentialKey, cache] of caches) {
    accounts[credentialKey] = {
      accountKey: cache.accountKey,
      sinceMs: cache.sinceMs,
      untilMs: cache.untilMs,
      fetchedAtMs: cache.fetchedAtMs,
      records: cache.records.map((record) => [
        record.timestampMs,
        intern(record.model),
        intern(record.sessionId),
        record.totals.uncachedInputTokens,
        record.totals.cachedInputTokens,
        record.totals.cacheCreationTokens,
        record.totals.outputTokens,
        record.reportedCostUsd,
        record.dedupeKey,
      ]),
    };
  }
  return JSON.stringify({ version: CURSOR_ACCOUNT_CACHE_VERSION, strings, accounts });
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Rebuilds the caches from a parsed document. A malformed account is dropped
 * whole, costing one refetch; keeping its survivors would leave a gap the
 * covered range claims is complete.
 */
export function decodeCursorAccountCaches(document: unknown): Map<string, CursorAccountCache> {
  const caches = new Map<string, CursorAccountCache>();
  if (typeof document !== "object" || document === null) return caches;
  const root = document as {
    readonly version?: unknown;
    readonly strings?: unknown;
    readonly accounts?: unknown;
  };
  const strings = root.strings;
  if (
    root.version !== CURSOR_ACCOUNT_CACHE_VERSION ||
    !Array.isArray(strings) ||
    !strings.every((value): value is string => typeof value === "string") ||
    typeof root.accounts !== "object" ||
    root.accounts === null
  ) {
    return caches;
  }
  const stringAt = (index: unknown): string | undefined =>
    typeof index === "number" ? strings[index] : undefined;

  const decodeRecord = (row: unknown): UsageRecord | null => {
    if (!Array.isArray(row)) return null;
    const [
      timestampMs,
      modelIndex,
      sessionIndex,
      uncached,
      cached,
      creation,
      output,
      cost,
      key,
    ]: readonly unknown[] = row;
    const model = stringAt(modelIndex);
    const sessionId = stringAt(sessionIndex);
    if (
      !isFiniteNumber(timestampMs) ||
      model === undefined ||
      sessionId === undefined ||
      !isFiniteNumber(uncached) ||
      !isFiniteNumber(cached) ||
      !isFiniteNumber(creation) ||
      !isFiniteNumber(output) ||
      (cost !== null && !isFiniteNumber(cost)) ||
      (key !== null && typeof key !== "string")
    ) {
      return null;
    }
    return {
      provider: "cursor",
      timestampMs,
      model,
      rateModel: cursorRateModel(model),
      sessionId,
      totals: {
        uncachedInputTokens: uncached,
        cachedInputTokens: cached,
        cacheCreationTokens: creation,
        outputTokens: output,
        reasoningTokens: 0,
      },
      reportedCostUsd: cost,
      speed: "standard",
      dedupeKey: key,
    };
  };

  for (const [credentialKey, raw] of Object.entries(root.accounts)) {
    if (typeof raw !== "object" || raw === null) continue;
    const account = raw as Partial<Record<keyof SerializedAccount, unknown>>;
    if (
      typeof account.accountKey !== "string" ||
      !isFiniteNumber(account.sinceMs) ||
      !isFiniteNumber(account.untilMs) ||
      !isFiniteNumber(account.fetchedAtMs) ||
      !Array.isArray(account.records)
    ) {
      continue;
    }
    const records: UsageRecord[] = [];
    for (const row of account.records) {
      const record = decodeRecord(row);
      if (record === null) break;
      records.push(record);
    }
    if (records.length !== account.records.length) continue;
    caches.set(credentialKey, {
      accountKey: account.accountKey,
      sinceMs: account.sinceMs,
      untilMs: account.untilMs,
      fetchedAtMs: account.fetchedAtMs,
      records,
    });
  }
  return caches;
}
