import * as Effect from "effect/Effect";

// Backstop for a write path that forgets to invalidate; the tick still runs every few seconds.
const DUE_HINT_MAX_AGE_MS = 10 * 60 * 1_000;

/**
 * Remembers when a poller next has work so idle scheduler ticks skip SQL.
 * `invalidate` after every write that can move work earlier; a tick records
 * only if no write happened since it read `version`.
 */
export const make = () => {
  let version = 0;
  let hint: { readonly dueAtMs: number; readonly checkedAtMs: number } | null = null;
  return {
    invalidate: Effect.sync(() => {
      version++;
      hint = null;
    }),
    version: Effect.sync(() => version),
    isIdle: (nowMs: number) =>
      Effect.sync(
        () =>
          hint !== null && hint.dueAtMs > nowMs && nowMs - hint.checkedAtMs < DUE_HINT_MAX_AGE_MS,
      ),
    record: (readVersion: number, dueAtMs: number, nowMs: number) =>
      Effect.sync(() => {
        if (readVersion === version) hint = { dueAtMs, checkedAtMs: nowMs };
      }),
  };
};
