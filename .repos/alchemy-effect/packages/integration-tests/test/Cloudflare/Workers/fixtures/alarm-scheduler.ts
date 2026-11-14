import { Database } from "bun:sqlite";
import {
  dispatchAlarmCallbacks,
  initializeAlarmCallbacks,
  makeDurableObjectCallbackFactory,
} from "@alchemy.run/cloudflare/Workers/AlarmCallback";
import {
  DurableObjectState,
  fromDurableObjectState,
} from "@alchemy.run/cloudflare/Workers/DurableObjectState";
import type * as cf from "@cloudflare/workers-types";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

/** Real SQLite and the production scheduler, with a controllable native alarm. */
export const makeAlarmScheduler = Effect.gen(function* () {
  yield* TestClock.setTime(10_000);
  const db = yield* Effect.acquireRelease(
    Effect.sync(() => new Database(":memory:")),
    (db) => Effect.sync(() => db.close()),
  );
  let alarm: number | null = null;
  let transactionId = 0;
  const sql = {
    exec(query: string, ...bindings: cf.SqlStorageValue[]) {
      const before = db
        .query<{ count: number }, []>("SELECT total_changes() AS count")
        .get()!.count;
      const statements = query.split(";").filter((statement) => statement.trim());
      let rows: Record<string, cf.SqlStorageValue>[] = [];
      const values = bindings.map((value) =>
        value instanceof ArrayBuffer ? new Uint8Array(value) : value,
      );
      for (const statement of statements) {
        rows = db
          .query<Record<string, cf.SqlStorageValue>, typeof values>(statement)
          .all(...values);
      }
      const after = db.query<{ count: number }, []>("SELECT total_changes() AS count").get()!.count;
      const iterator = rows[Symbol.iterator]();
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`Expected one row, got ${rows.length}`);
          return rows[0];
        },
        next: () => iterator.next(),
        [Symbol.iterator]: () => iterator,
        rowsRead: rows.length,
        rowsWritten: after - before,
      };
    },
  };
  const begin = () => {
    const name = `alarm_test_${++transactionId}`;
    const previousAlarm = alarm;
    db.exec(`SAVEPOINT ${name}`);
    return {
      commit: () => db.exec(`RELEASE ${name}`),
      rollback: () => {
        db.exec(`ROLLBACK TO ${name}`);
        alarm = previousAlarm;
      },
    };
  };
  const native = {
    sql,
    getAlarm: () => Promise.resolve(alarm),
    setAlarm: (at: number | Date) => {
      alarm = at instanceof Date ? at.getTime() : at;
      return Promise.resolve();
    },
    deleteAlarm: () => {
      alarm = null;
      return Promise.resolve();
    },
    sync: () => Promise.resolve(),
    async transaction<T>(closure: (transaction: unknown) => Promise<T>) {
      const transaction = begin();
      try {
        const result = await closure({
          ...native,
          rollback: transaction.rollback,
        });
        transaction.commit();
        return result;
      } catch (cause) {
        transaction.rollback();
        transaction.commit();
        throw cause;
      }
    },
    transactionSync<T>(closure: () => T) {
      const transaction = begin();
      try {
        const result = closure();
        transaction.commit();
        return result;
      } catch (cause) {
        transaction.rollback();
        transaction.commit();
        throw cause;
      }
    },
  };
  const raw = {
    id: { toString: () => "alarm-scheduler-test" },
    storage: native,
  } as unknown as cf.DurableObjectState;
  const state = fromDurableObjectState(raw);
  let seal = initializeAlarmCallbacks(raw);
  return {
    db,
    raw,
    state,
    get alarm() {
      return alarm;
    },
    register: makeDurableObjectCallbackFactory(raw),
    seal: () => seal(),
    restart: () => {
      seal = initializeAlarmCallbacks(raw);
    },
    fire: Effect.gen(function* () {
      if (alarm === null) return yield* Effect.die("No native alarm is scheduled");
      yield* TestClock.setTime(alarm);
      alarm = null;
      yield* dispatchAlarmCallbacks(raw, false).pipe(
        Effect.provideService(DurableObjectState, state),
      );
    }),
  };
}).pipe(Effect.provide(RuntimeContext.phantom));
