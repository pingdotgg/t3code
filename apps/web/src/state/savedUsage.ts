/**
 * The usage each environment last reported to this browser, so an environment
 * that is offline still shows what it had when it was last read.
 *
 * @module state/savedUsage
 */
import { UsageSummary, type UsageSummaryInput } from "@t3tools/contracts";
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
  }));
}

async function withStore<A>(
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => IDBRequest<A> | void,
): Promise<A | undefined> {
  const transaction = (await openDatabase()).transaction(STORE_NAME, mode);
  const request = use(transaction.objectStore(STORE_NAME));
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
  return request?.result;
}

const windowKey = (input: UsageSummaryInput) =>
  JSON.stringify([
    input.sinceDay,
    input.untilDay,
    input.timeZone,
    input.resolution ?? "day",
    input.sinceTime ?? null,
    input.untilTime ?? null,
  ]);

/** Saved windows for an environment, newest first. Unreadable entries are dropped. */
export async function loadSavedUsage(environmentId: string): Promise<readonly SavedUsage[]> {
  if (typeof indexedDB === "undefined") return [];
  try {
    const stored = await withStore<unknown>("readonly", (store) => store.get(environmentId));
    if (!Array.isArray(stored)) return [];
    return stored.flatMap((entry: { input?: UsageSummaryInput; summary?: unknown }) => {
      const summary = decodeSummary(entry?.summary);
      return entry?.input !== undefined && Option.isSome(summary)
        ? [{ input: entry.input, summary: summary.value }]
        : [];
    });
  } catch (error) {
    console.warn("Could not read saved usage.", error);
    return [];
  }
}

/** Keeps a summary that just arrived, replacing any older read of the same window. */
export async function saveUsage(environmentId: string, saved: SavedUsage): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const kept = (await loadSavedUsage(environmentId)).filter(
      (entry) => windowKey(entry.input) !== windowKey(saved.input),
    );
    const next = [saved, ...kept].slice(0, MAX_SAVED_WINDOWS);
    await withStore("readwrite", (store) => store.put(next, environmentId));
  } catch (error) {
    console.warn("Could not save usage.", error);
  }
}

/** Forgets an environment's saved usage, as when it is removed. */
export async function clearSavedUsage(environmentId: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    await withStore("readwrite", (store) => store.delete(environmentId));
  } catch (error) {
    console.warn("Could not clear saved usage.", error);
  }
}

const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000;

/**
 * The saved read that best covers a window, cut to it. A saved read by day
 * answers an hourly window only by day, which the caller reports as such;
 * a saved hourly read answers a daily window.
 */
export function pickSavedUsage(
  saved: readonly SavedUsage[],
  input: UsageSummaryInput,
): { readonly summary: UsageSummary; readonly readByDay: boolean } | null {
  const wantsHours = input.resolution === "hour";
  let best: { entry: SavedUsage; overlap: number; exact: boolean } | null = null;
  for (const entry of saved) {
    if (entry.input.timeZone !== input.timeZone) continue;
    const overlap =
      Math.min(dayNumber(entry.input.untilDay), dayNumber(input.untilDay)) -
      Math.max(dayNumber(entry.input.sinceDay), dayNumber(input.sinceDay)) +
      1;
    if (!(overlap > 0)) continue;
    const exact = (entry.input.resolution === "hour") === wantsHours;
    if (
      best === null ||
      overlap > best.overlap ||
      (overlap === best.overlap && exact && !best.exact)
    ) {
      best = { entry, overlap, exact };
    }
  }
  if (best === null) return null;
  const { summary } = best.entry;
  const since = input.sinceTime === undefined ? null : Date.parse(input.sinceTime);
  const until = input.untilTime === undefined ? null : Date.parse(input.untilTime);
  return {
    summary: {
      ...summary,
      buckets: summary.buckets.filter((bucket) => {
        if (bucket.day < input.sinceDay || bucket.day > input.untilDay) return false;
        if (bucket.hourStart === undefined || since === null || until === null) return true;
        const start = Date.parse(bucket.hourStart);
        return start >= since && start < until;
      }),
    },
    readByDay: wantsHours && best.entry.input.resolution !== "hour",
  };
}
