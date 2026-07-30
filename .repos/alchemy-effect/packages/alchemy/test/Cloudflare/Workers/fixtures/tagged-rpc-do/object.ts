import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { CounterRpcs } from "./group.ts";

export const MyDB = Cloudflare.D1.Database("MyDB");

const DO_COUNT_KEY = "do_count";

// Tag — modular `RpcDurableObject` declaration. The runtime
// (D1 setup, handler bodies) lives in `CounterLive` below; consumers
// only need this class identifier to bind via `Counter.from(WorkerA)`.
export class Counter extends Cloudflare.RpcDurableObject<Counter>()("Counter", {
  schema: CounterRpcs,
}) {}

// Layer — outer Effect resolves shared deps (D1), inner Effect runs
// once per instance and returns the piped `RpcServer.toHttpEffect`
// the DO's `fetch` handler will serve.
export const CounterLive = Counter.make(
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1.QueryDatabase(MyDB);
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      // D1's `exec()` splits on newlines and rejects multi-line statements;
      // keep the DDL on a single line.
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
        state.storage.get<number>(DO_COUNT_KEY).pipe(Effect.map((v) => v ?? 0));

      const writeDO = (value: number) =>
        state.storage.put(DO_COUNT_KEY, value).pipe(Effect.asVoid);

      const handlers = CounterRpcs.toLayer({
        incrementD1: ({ key }) =>
          Effect.gen(function* () {
            const next = (yield* readD1(key)) + 1;
            yield* writeD1(key, next);
            return { value: next };
          }),
        getD1: ({ key }) => Effect.map(readD1(key), (value) => ({ value })),
        // `key` is ignored — the DO instance is already partitioned by
        // `getByName(key)` at the namespace boundary.
        incrementDO: () =>
          Effect.gen(function* () {
            const next = (yield* readDO()) + 1;
            yield* writeDO(next);
            return { value: next };
          }),
        getDO: () => Effect.map(readDO(), (value) => ({ value })),
        reset: ({ key }) =>
          Effect.gen(function* () {
            console.log("reset DO", key);
            yield* writeD1(key, 0);
            yield* writeDO(0);
          }),
      });

      return RpcServer.toHttpEffect(CounterRpcs).pipe(
        Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
      );
    });
  }),
);
