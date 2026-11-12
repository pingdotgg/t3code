/**
 * The usage each environment last reported to this browser, so an environment
 * that is offline still shows what it had when it was last read.
 *
 * @module state/savedUsage
 */
import {
  UsageSummary,
  type UsageSourceFingerprint,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const DATABASE_NAME = "t3code:usage-snapshots";
const DATABASE_VERSION = 1;
const STORE_NAME = "summaries";
/** Windows kept per environment: enough for the range buttons and a zoom. */
const MAX_SAVED_WINDOWS = 4;
export interface SavedUsage {
  readonly input: UsageSummaryInput;
  readonly summary: UsageSummary;
}

const decodeSummary = Schema.decodeUnknownOption(UsageSummary);

let database: Promise<IDBDatabase> | undefined;

function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("blocked", () => reject(new Error("Saved usage is blocked.")));
  }).catch((error: unknown) => {
    database = undefined;
    throw error;
  }));
}

/** Runs `use` in one transaction, so a read and the write after it cannot interleave. */
async function inTransaction(
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore, done: (value: unknown) => void) => void,
): Promise<unknown> {
  const transaction = (await openDatabase()).transaction(STORE_NAME, mode);
  let result: unknown;
  use(transaction.objectStore(STORE_NAME), (value) => {
    result = value;
  });
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
  return result;
}

const windowKey = (input: UsageSummaryInput) =>
  JSON.stringify([
    input.sinceDay,
    input.untilDay,
    input.timeZone,
    input.resolution ?? "day",
    input.sinceTime ?? null,
    input.untilTime ?? null,
    input.modelFilter ?? null,
  ]);

function decodeSaved(stored: unknown): readonly SavedUsage[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((entry: { input?: UsageSummaryInput; summary?: unknown }) => {
    const summary = decodeSummary(entry?.summary);
    return entry?.input !== undefined && Option.isSome(summary)
      ? [{ input: entry.input, summary: summary.value }]
      : [];
  });
}

const listeners = new Set<(environmentId: string, cleared: boolean) => void>();

/** Called after an environment's saved usage changes, or is cleared. */
export function onSavedUsageChange(
  listener: (environmentId: string, cleared: boolean) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Bumped by a clear, so a save that started before it does not write the data back. */
const generations = new Map<string, number>();

/** Saved windows for an environment, newest first. Unreadable entries are dropped. */
export async function loadSavedUsage(environmentId: string): Promise<readonly SavedUsage[]> {
  if (typeof indexedDB === "undefined") return [];
  try {
    return decodeSaved(
      await inTransaction("readonly", (store, done) => {
        const request = store.get(environmentId);
        request.addEventListener("success", () => done(request.result));
      }),
    );
  } catch (error) {
    console.warn("Could not read saved usage.", error);
    return [];
  }
}

/** Keeps a summary that just arrived, replacing any older read of the same window. */
export async function saveUsage(environmentId: string, saved: SavedUsage): Promise<boolean> {
  if (typeof indexedDB === "undefined") return false;
  const generation = generations.get(environmentId) ?? 0;
  try {
    await inTransaction("readwrite", (store) => {
      const request = store.get(environmentId);
      request.addEventListener("success", () => {
        if ((generations.get(environmentId) ?? 0) !== generation) return;
        const kept = decodeSaved(request.result).filter(
          (entry) => windowKey(entry.input) !== windowKey(saved.input),
        );
        store.put([saved, ...kept].slice(0, MAX_SAVED_WINDOWS), environmentId);
      });
    });
    if ((generations.get(environmentId) ?? 0) !== generation) return false;
    for (const listener of listeners) listener(environmentId, false);
    return true;
  } catch (error) {
    console.warn("Could not save usage.", error);
    return false;
  }
}

/** Forgets an environment's saved usage, as when it is removed. */
export async function clearSavedUsage(environmentId: string): Promise<void> {
  generations.set(environmentId, (generations.get(environmentId) ?? 0) + 1);
  for (const listener of listeners) listener(environmentId, true);
  if (typeof indexedDB === "undefined") return;
  try {
    await inTransaction("readwrite", (store) => {
      store.delete(environmentId);
    });
  } catch (error) {
    console.warn("Could not clear saved usage.", error);
  }
}

/** A saved read answers only the exact window whose source aggregates it contains. */
export function pickSavedUsage(
  saved: readonly SavedUsage[],
  input: UsageSummaryInput,
): UsageSummary | null {
  const key = windowKey(input);
  return saved.find((entry) => windowKey(entry.input) === key)?.summary ?? null;
}

const fingerprintKey = (fingerprint: UsageSourceFingerprint) =>
  [
    fingerprint.hostId,
    fingerprint.provider,
    fingerprint.resolvedHomePath,
    fingerprint.volumeId,
  ].join(" ");

/** A saved summary without the history folders in `taken`, and their buckets. */
function withoutSources(saved: UsageSummary, taken: ReadonlySet<string>): UsageSummary {
  const dropped = saved.sources.filter((source) => taken.has(fingerprintKey(source.fingerprint)));
  if (dropped.length === 0) return saved;
  // A bucket without a path cannot be told apart between its provider's
  // folders, so dropping any of them drops all of that provider's.
  const unpathed = new Set(
    saved.buckets.flatMap((bucket) => (bucket.sourcePath === undefined ? [bucket.provider] : [])),
  );
  const droppedProviders = new Set(dropped.map((source) => source.fingerprint.provider));
  const drops = (source: UsageSummary["sources"][number]) =>
    taken.has(fingerprintKey(source.fingerprint)) ||
    (unpathed.has(source.fingerprint.provider) &&
      droppedProviders.has(source.fingerprint.provider));
  const droppedPaths = new Set(
    saved.sources
      .filter(drops)
      .map(
        (source) => `${source.fingerprint.provider}\u0000${source.fingerprint.resolvedHomePath}`,
      ),
  );
  return {
    ...saved,
    sources: saved.sources.filter((source) => !drops(source)),
    buckets: saved.buckets.filter((bucket) =>
      bucket.sourcePath === undefined
        ? !droppedProviders.has(bucket.provider)
        : !droppedPaths.has(`${bucket.provider}\u0000${bucket.sourcePath}`),
    ),
  };
}

/**
 * Saved summaries trimmed so each history folder is counted from one place.
 * A folder a live read answered for stays with that read; among saved reads,
 * the newest keeps it. Saved reads then never compete with each other or with
 * live ones, so aliases, hour grids and coverage cannot double count.
 */
export function trimSavedUsage(
  live: readonly UsageSummary[],
  saved: ReadonlyMap<string, UsageSummary>,
): ReadonlyMap<string, UsageSummary> {
  // Only a folder that was actually read claims it; a failed read holds nothing.
  const claims = (summary: UsageSummary) =>
    summary.sources
      .filter((source) => source.status === "ok" || source.status === "partial")
      .map((source) => fingerprintKey(source.fingerprint));
  const taken = new Set(live.flatMap(claims));
  const trimmed = new Map<string, UsageSummary>();
  const newestFirst = [...saved].sort(
    ([, a], [, b]) => (Date.parse(b.readAt) || 0) - (Date.parse(a.readAt) || 0),
  );
  for (const [environmentId, summary] of newestFirst) {
    const kept = withoutSources(summary, taken);
    for (const key of claims(kept)) taken.add(key);
    trimmed.set(environmentId, kept);
  }
  return trimmed;
}
