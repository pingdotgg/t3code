/**
 * Paces reads of a rate-limited provider endpoint per key, such as one usage
 * read per account. Each key is asked at most once per interval and its last
 * answer stands in between; each failed read in a row doubles the wait, and
 * the last answer keeps standing in for failed reads. `forget` makes the next
 * read ask again, for the moment the answer changed, such as a redeemed reset.
 *
 * @module provider/throttledReader
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

export interface ReadPacing {
  /** How long one answer stands before the next request. */
  readonly intervalMs: number;
  /** The longest wait; each failed request in a row doubles it up to this. */
  readonly maxIntervalMs: number;
  /** How long the last answer may stand in for failed requests. Forever by default. */
  readonly keepLastMs?: number;
}

/**
 * Whether a key is asked again: never asked, or the last request is old
 * enough. Each failed request in a row doubles the wait, up to the maximum.
 */
export function readDue(
  pacing: ReadPacing,
  lastAttemptMs: number | null,
  nowMs: number,
  failedInARow = 0,
): boolean {
  const interval = Math.min(pacing.intervalMs * 2 ** failedInARow, pacing.maxIntervalMs);
  return lastAttemptMs === null || nowMs - lastAttemptMs >= interval;
}

interface Entry<A, E> {
  readonly attemptedAt: number;
  readonly failedInARow: number;
  readonly last: { readonly value: A; readonly at: number } | undefined;
  /** The last failure, returned again while a failed key waits with nothing to show. */
  readonly error: E | undefined;
}

/**
 * `read(key, request)` runs `request` only when `key` is due and otherwise
 * returns its last answer. A failed request returns the last answer while it
 * is younger than `keepLastMs`, and fails otherwise; while the key then waits,
 * reads fail with the same error without asking.
 *
 * `forget(key)` drops everything known about `key`. A read still in flight
 * then does not store its older answer. Callers run reads of one key one at a
 * time; two at once may both ask.
 */
export const makeThrottledReader = <A, E>(pacing: ReadPacing) =>
  Effect.gen(function* () {
    const entries = yield* Ref.make<ReadonlyMap<string, Entry<A, E>>>(new Map());
    const generations = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const keepLastMs = pacing.keepLastMs ?? Number.POSITIVE_INFINITY;

    const read = <R>(key: string, request: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const generation = (yield* Ref.get(generations)).get(key) ?? 0;
        const entry = (yield* Ref.get(entries)).get(key);
        const last = entry?.last && now - entry.last.at < keepLastMs ? entry.last : undefined;
        if (entry && !readDue(pacing, entry.attemptedAt, now, entry.failedInARow)) {
          if (last) return last.value;
          if (entry.error !== undefined) return yield* Effect.fail(entry.error);
        }
        const outcome = yield* Effect.result(request);
        const next: Entry<A, E> = Result.isSuccess(outcome)
          ? {
              attemptedAt: now,
              failedInARow: 0,
              last: { value: outcome.success, at: now },
              error: undefined,
            }
          : {
              attemptedAt: now,
              failedInARow: (entry?.failedInARow ?? 0) + 1,
              last,
              error: outcome.failure,
            };
        // Forgotten while the request ran: its answer may predate the change.
        if (((yield* Ref.get(generations)).get(key) ?? 0) === generation) {
          yield* Ref.update(entries, (current) => new Map(current).set(key, next));
        }
        if (Result.isSuccess(outcome)) return outcome.success;
        if (last) return last.value;
        return yield* Effect.fail(outcome.failure);
      });

    const forget = (key: string) =>
      Effect.andThen(
        Ref.update(generations, (current) =>
          new Map(current).set(key, (current.get(key) ?? 0) + 1),
        ),
        Ref.update(entries, (current) => {
          if (!current.has(key)) return current;
          const next = new Map(current);
          next.delete(key);
          return next;
        }),
      );

    return { read, forget };
  });
