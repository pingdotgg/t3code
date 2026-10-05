import type * as cf from "@cloudflare/workers-types";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { ActiveStorageTransactions } from "./DurableObjectTransactionContext.ts";

const SCHEMA_VERSION = 1;

export class UnsupportedAlarmSchemaVersion extends Data.TaggedError(
  "UnsupportedAlarmSchemaVersion",
)<{
  readonly version: number;
  readonly supportedVersion: number;
}> {}

export const ensureAlarmTables = (storage: cf.DurableObjectStorage) =>
  Effect.gen(function* () {
    const transaction = (yield* ActiveStorageTransactions).get(storage);
    if (transaction?.alarmTablesEnsured) return;
    yield* initializeAlarmTables(storage);
    if (transaction !== undefined) transaction.alarmTablesEnsured = true;
  });

const initializeAlarmTables = (storage: cf.DurableObjectStorage) =>
  Effect.sync(() => {
    const hasVersion =
      storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'alchemy_alarm_schema'",
        )
        .toArray().length > 0;
    const version = hasVersion
      ? storage.sql
          .exec<{ version: number }>(
            "SELECT version FROM alchemy_alarm_schema WHERE id = 1",
          )
          .one().version
      : 0;
    if (version === SCHEMA_VERSION) return;
    if (version !== 0) {
      throw new UnsupportedAlarmSchemaVersion({
        version,
        supportedVersion: SCHEMA_VERSION,
      });
    }

    storage.transactionSync(() => {
      // Version 0 is the original, unversioned scheduleEvent schema.
      storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS alchemy_scheduled_events (
          id TEXT PRIMARY KEY,
          run_at INTEGER NOT NULL,
          repeat_ms INTEGER,
          payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_alchemy_scheduled_events_run_at
          ON alchemy_scheduled_events (run_at);
        CREATE TABLE alchemy_alarm_callbacks (
          callback TEXT NOT NULL,
          id TEXT NOT NULL,
          version TEXT NOT NULL,
          run_at INTEGER NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY (callback, id)
        );
        CREATE INDEX idx_alchemy_alarm_callbacks_run_at
          ON alchemy_alarm_callbacks (run_at, callback, id);
        CREATE TABLE IF NOT EXISTS alchemy_alarm_schema (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL
        );
        INSERT INTO alchemy_alarm_schema (id, version) VALUES (1, 1)
          ON CONFLICT (id) DO UPDATE SET version = excluded.version;
      `);
    });
  });

// Both schedulers share the Durable Object's single native alarm.
export const reconcileDurableObjectAlarm = (storage: cf.DurableObjectStorage) =>
  Effect.gen(function* () {
    const transaction = (yield* ActiveStorageTransactions).get(storage);
    if (transaction !== undefined) {
      transaction.alarmDirty = true;
    } else {
      yield* reconcileAlarm(storage);
    }
  });

// Flush before commit or an explicit alarm operation, never after rollback.
export const flushDurableObjectAlarm = (storage: cf.DurableObjectStorage) =>
  Effect.gen(function* () {
    const transaction = (yield* ActiveStorageTransactions).get(storage);
    if (transaction?.alarmDirty && !transaction.rolledBack) {
      yield* reconcileAlarm(storage);
      transaction.alarmDirty = false;
    }
  });

const reconcileAlarm = (storage: cf.DurableObjectStorage) =>
  Effect.gen(function* () {
    const next = yield* Effect.sync(
      () =>
        storage.sql
          .exec<{ run_at: number | null }>(`
        SELECT MIN(run_at) AS run_at FROM (
          SELECT MIN(run_at) AS run_at FROM alchemy_scheduled_events
          UNION ALL
          SELECT MIN(run_at) AS run_at FROM alchemy_alarm_callbacks
        )
      `)
          .one().run_at,
    );
    const now = yield* Clock.currentTimeMillis;
    // A continuation must use a new timestamp, not the alarm currently being acknowledged.
    yield* Effect.promise(() =>
      next === null
        ? storage.deleteAlarm()
        : storage.setAlarm(Math.max(next, now + 1)),
    );
  });
