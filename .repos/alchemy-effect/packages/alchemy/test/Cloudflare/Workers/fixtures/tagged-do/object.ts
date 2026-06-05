import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export const MyDB = Cloudflare.D1Database("MyDB");

const DO_COUNT_KEY = "do_count";

// Tag — D1 RPC methods take an explicit row `key` so the shared D1 table
// can be partitioned per-caller. The DO storage methods don't need one
// because per-instance storage is already isolated by `getByName(name)`.
export class Counter extends Cloudflare.DurableObjectNamespace<
  Counter,
  {
    incrementD1: (key: string) => Effect.Effect<number, never, RuntimeContext>;
    getD1: (key: string) => Effect.Effect<number, never, RuntimeContext>;
    incrementDO: () => Effect.Effect<number, never, RuntimeContext>;
    getDO: () => Effect.Effect<number, never, RuntimeContext>;
    reset: (key: string) => Effect.Effect<void, never, RuntimeContext>;
  }
>()("Counter") {}

// Layer
export const CounterLive = Counter.make(
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1Connection.bind(MyDB);

    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;

      // D1's `exec()` splits on newlines and rejects multi-line statements
      // ("incomplete input: SQLITE_ERROR"). Keep the DDL on a single line.
      yield* db.exec(
        "CREATE TABLE IF NOT EXISTS d1_counters (id TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0)",
      );

      const readD1 = (key: string) =>
        db
          .prepare("SELECT value FROM d1_counters WHERE id = ?")
          .bind(key)
          .first<{ value: number }>()
          .pipe(Effect.map((row) => row?.value ?? 0));

      const writeD1 = (key: string, value: number) =>
        db
          .prepare(
            "INSERT INTO d1_counters (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value",
          )
          .bind(key, value)
          .run()
          .pipe(Effect.asVoid);

      const readDO = () =>
        state.storage
          .get<number>(DO_COUNT_KEY)
          .pipe(Effect.map((value) => value ?? 0));

      const writeDO = (value: number) =>
        state.storage.put(DO_COUNT_KEY, value).pipe(Effect.asVoid);

      return {
        incrementD1: (key: string) =>
          Effect.gen(function* () {
            const next = (yield* readD1(key)) + 1;
            yield* writeD1(key, next);
            return next;
          }),
        getD1: (key: string) => readD1(key),
        incrementDO: () =>
          Effect.gen(function* () {
            const next = (yield* readDO()) + 1;
            yield* writeDO(next);
            return next;
          }),
        getDO: () => readDO(),
        reset: (key: string) =>
          Effect.gen(function* () {
            yield* writeD1(key, 0);
            yield* writeDO(0);
          }),
      };
    });
  }),
);
