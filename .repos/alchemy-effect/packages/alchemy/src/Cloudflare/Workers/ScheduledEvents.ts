import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { DurableObjectState } from "./DurableObjectState.ts";
import type { SqlStorageValue } from "./DurableObjectStorage.ts";

// ---------------------------------------------------------------------------
// Scheduled Events — SQLite-backed cron/timer for Durable Objects
// ---------------------------------------------------------------------------

const INIT_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS alchemy_scheduled_events (
  id TEXT PRIMARY KEY,
  run_at INTEGER NOT NULL,
  repeat_ms INTEGER,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alchemy_scheduled_events_run_at
  ON alchemy_scheduled_events (run_at);
`;

const ensureTable = Effect.gen(function* () {
  const ctx = yield* DurableObjectState;
  yield* ctx.storage.sql.exec(INIT_TABLE_SQL);
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
export const scheduleEvent = Effect.fnUntraced(function* (
  id: string,
  runAt: Date,
  payload: unknown,
  repeatMs?: number,
) {
  yield* ensureTable;
  const ctx = yield* DurableObjectState;

  yield* ctx.storage.sql.exec(
    `INSERT OR REPLACE INTO alchemy_scheduled_events (id, run_at, repeat_ms, payload)
     VALUES (?, ?, ?, ?)`,
    id,
    runAt.getTime(),
    repeatMs ?? null,
    JSON.stringify(payload),
  );

  yield* reconcileAlarm;
});

/**
 * Cancel a previously scheduled event by id. No-op if the event does not exist.
 */
export const cancelEvent = Effect.fnUntraced(function* (id: string) {
  yield* ensureTable;
  const ctx = yield* DurableObjectState;

  yield* ctx.storage.sql.exec(
    `DELETE FROM alchemy_scheduled_events WHERE id = ?`,
    id,
  );

  yield* reconcileAlarm;
});

/**
 * List all currently scheduled events, ordered by `runAt` ascending.
 */
export const listEvents: Effect.Effect<
  ScheduledEvent[],
  never,
  DurableObjectState
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
 *   const fired = yield* Cloudflare.processScheduledEvents;
 *   for (const event of fired) {
 *     // handle each event
 *   }
 * })
 * ```
 */
export const processScheduledEvents: Effect.Effect<
  ScheduledEvent[],
  never,
  DurableObjectState
> = Effect.gen(function* () {
  yield* ensureTable;
  const ctx = yield* DurableObjectState;
  const now = Date.now();

  const cursor = yield* ctx.storage.sql.exec<EventRow>(
    `SELECT id, run_at, repeat_ms, payload FROM alchemy_scheduled_events WHERE run_at <= ? ORDER BY run_at ASC`,
    now,
  );

  const fired = yield* cursor.pipe(
    Stream.mapEffect((row) =>
      (row.repeat_ms != null
        ? ctx.storage.sql.exec(
            `UPDATE alchemy_scheduled_events SET run_at = ? WHERE id = ?`,
            now + row.repeat_ms,
            row.id,
          )
        : ctx.storage.sql.exec(
            `DELETE FROM alchemy_scheduled_events WHERE id = ?`,
            row.id,
          )
      ).pipe(Effect.as(toScheduledEvent(row))),
    ),
    Stream.runCollect,
  );

  yield* reconcileAlarm;
  return fired;
});

/**
 * Set the DO alarm to the earliest pending event, or clear it if none remain.
 */
const reconcileAlarm: Effect.Effect<void, never, DurableObjectState> =
  Effect.gen(function* () {
    const ctx = yield* DurableObjectState;

    const next = yield* (yield* ctx.storage.sql.exec<{
      run_at: number;
    }>(
      `SELECT run_at FROM alchemy_scheduled_events ORDER BY run_at ASC LIMIT 1`,
    )).pipe(Stream.take(1), Stream.runHead);

    if (Option.isSome(next)) {
      yield* ctx.storage.setAlarm(next.value.run_at);
    } else {
      yield* ctx.storage.deleteAlarm();
    }
  });
