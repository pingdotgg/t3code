import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ensureAlarmTables, reconcileDurableObjectAlarm } from "./DurableObjectAlarmStorage.ts";
import { DurableObjectState } from "./DurableObjectState.ts";
import type { SqlStorageValue } from "./DurableObjectStorage.ts";

// ---------------------------------------------------------------------------
// Scheduled Events — SQLite-backed cron/timer for Durable Objects
// ---------------------------------------------------------------------------

const ensureTable = Effect.gen(function* () {
  const ctx = yield* DurableObjectState;
  yield* ensureAlarmTables(ctx.raw.storage);
});

const inTransaction = <A, R>(effect: Effect.Effect<A, never, R>) =>
  Effect.gen(function* () {
    const ctx = yield* DurableObjectState;
    return yield* ctx.storage.transaction(effect).pipe(Effect.orDie);
  });

export interface ScheduledEvent {
  id: string;
  runAt: Date;
  repeatMs?: number;
  payload: unknown;
}

interface EventRow extends Record<string, SqlStorageValue> {
  id: string;
  run_at: number;
  repeat_ms: number | null;
  payload: string;
}

const toScheduledEvent = (row: EventRow): ScheduledEvent => ({
  id: row.id,
  runAt: new Date(row.run_at),
  repeatMs: row.repeat_ms ?? undefined,
  payload: JSON.parse(row.payload) as unknown,
});

/**
 * Schedule (or reschedule) a named event on the current Durable Object.
 *
 * The event is persisted in a SQLite table and the DO alarm is set to
 * the earliest pending `runAt`. If an event with the same `id` already
 * exists it is replaced (upsert).
 *
 * @param id      Stable identifier for the event (used for upsert / cancel).
 * @param runAt   When the event should fire.
 * @param payload Arbitrary JSON-serialisable data delivered to the alarm handler.
 * @param repeatMs If set, the event re-schedules itself this many ms after each fire.
 */
export const scheduleEvent = Effect.fn(function* (
  id: string,
  runAt: Date,
  payload: unknown,
  repeatMs?: number,
) {
  yield* ensureTable;
  const ctx = yield* DurableObjectState;

  yield* ctx.storage.sql
    .exec(
      `INSERT OR REPLACE INTO alchemy_scheduled_events (id, run_at, repeat_ms, payload)
     VALUES (?, ?, ?, ?)`,
      id,
      runAt.getTime(),
      repeatMs ?? null,
      JSON.stringify(payload),
    )
    .pipe(Effect.asVoid);

  yield* reconcileAlarm;
}, inTransaction);

/**
 * Cancel a previously scheduled event by id. No-op if the event does not exist.
 */
export const cancelEvent = Effect.fn(function* (id: string) {
  yield* ensureTable;
  const ctx = yield* DurableObjectState;

  yield* ctx.storage.sql
    .exec(`DELETE FROM alchemy_scheduled_events WHERE id = ?`, id)
    .pipe(Effect.asVoid);

  yield* reconcileAlarm;
}, inTransaction);

/**
 * List all currently scheduled events, ordered by `runAt` ascending.
 */
export const listEvents: Effect.Effect<
  ScheduledEvent[],
  never,
  DurableObjectState | RuntimeContext
> = Effect.gen(function* () {
  yield* ensureTable;
  const ctx = yield* DurableObjectState;

  const cursor = yield* ctx.storage.sql.exec<EventRow>(
    `SELECT id, run_at, repeat_ms, payload FROM alchemy_scheduled_events ORDER BY run_at ASC`,
  );

  return yield* cursor.pipe(Stream.map(toScheduledEvent), Stream.runCollect);
});

/**
 * Process all events whose `runAt` <= now. Returns the fired events.
 *
 * - One-shot events are deleted after firing.
 * - Repeating events have their `runAt` bumped by `repeatMs`.
 * - The DO alarm is re-set to the next pending event (if any).
 *
 * Call this from your Durable Object's `alarm` handler:
 *
 * ```ts
 * alarm: () => Effect.gen(function* () {
 *   const fired = yield* Cloudflare.Workers.processScheduledEvents;
 *   for (const event of fired) {
 *     // handle each event
 *   }
 * })
 * ```
 */
export const processScheduledEvents: Effect.Effect<
  ScheduledEvent[],
  never,
  DurableObjectState | RuntimeContext
> = Effect.gen(function* () {
  yield* ensureTable;
  const ctx = yield* DurableObjectState;
  const now = yield* Clock.currentTimeMillis;

  const cursor = yield* ctx.storage.sql.exec<EventRow>(
    `SELECT id, run_at, repeat_ms, payload FROM alchemy_scheduled_events WHERE run_at <= ? ORDER BY run_at ASC`,
    now,
  );

  const rows = yield* cursor.toArray();
  // The native transaction holds the snapshot stable while these statements
  // run. Cross the SQL/Effect boundary once per category, rather than per row.
  if (rows.some((row) => row.repeat_ms === null)) {
    yield* Effect.asVoid(
      ctx.storage.sql.exec(
        `DELETE FROM alchemy_scheduled_events WHERE run_at <= ? AND repeat_ms IS NULL`,
        now,
      ),
    );
  }
  if (rows.some((row) => row.repeat_ms !== null)) {
    yield* Effect.asVoid(
      ctx.storage.sql.exec(
        // Force binary64 addition, matching the former JavaScript now + repeat_ms
        // even when an integral result is beyond Number.MAX_SAFE_INTEGER.
        `UPDATE alchemy_scheduled_events
       SET run_at = CAST(? AS REAL) + CAST(repeat_ms AS REAL)
       WHERE run_at <= ? AND repeat_ms IS NOT NULL`,
        now,
        now,
      ),
    );
  }
  // Parse before reconciling the alarm: malformed payloads still roll back all
  // row mutations and leave the native alarm unchanged.
  const fired = rows.map(toScheduledEvent);

  yield* reconcileAlarm;
  return fired;
}).pipe(inTransaction);

/**
 * Set the DO alarm to the earliest pending event, or clear it if none remain.
 */
const reconcileAlarm: Effect.Effect<void, never, DurableObjectState | RuntimeContext> = Effect.gen(
  function* () {
    const ctx = yield* DurableObjectState;

    yield* reconcileDurableObjectAlarm(ctx.raw.storage);
  },
);
