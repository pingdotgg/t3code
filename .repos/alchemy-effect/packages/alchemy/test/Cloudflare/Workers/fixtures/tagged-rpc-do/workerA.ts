import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { CounterRpcs } from "./group.ts";
import { Counter, CounterLive } from "./object.ts";

// Tag — host worker for the typed `Counter` rpc DO. The third type
// argument declares `Counter` as part of WorkerA's public contract so
// that `Counter.from(WorkerA)` type-checks from any consumer.
//
// WorkerA's own `fetch` surface is the same `CounterRpcs` group as
// the DO — every call is proxied to `counter.getByName(key).method({...})`.
// Consumers can therefore hit the counter over a service binding via
// `Cloudflare.RpcWorker.bind(WorkerA)` without knowing about DO routing.
export class WorkerA extends Cloudflare.RpcWorker<WorkerA, Counter>()(
  "WorkerA",
  {
    schema: CounterRpcs,
  },
) {}

// Layer — yielding `Counter` resolves to WorkerA's local hosted
// namespace (the `CounterLive` Layer below populates the tag).
export default WorkerA.make(
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const counter = yield* Counter;

    // `counter.getByName(key)` returns a chainable Proxy (built via
    // `proxyChain`) so each method call yields directly. `Effect.orDie`
    // drops the transport-level `RpcClientError`, which isn't part of
    // the declared `CounterRpcs` error channel.
    const handlers = CounterRpcs.toLayer({
      incrementD1: ({ key }) =>
        counter
          .getByName(key)
          .pipe(Effect.flatMap((c) => c.incrementD1({ key })))
          .pipe(Effect.orDie),
      getD1: ({ key }) =>
        counter
          .getByName(key)
          .pipe(Effect.flatMap((c) => c.getD1({ key })))
          .pipe(Effect.orDie),
      incrementDO: ({ key }) =>
        counter
          .getByName(key)
          .pipe(Effect.flatMap((c) => c.incrementDO({ key })))
          .pipe(Effect.orDie),
      getDO: ({ key }) =>
        counter
          .getByName(key)
          .pipe(Effect.flatMap((c) => c.getDO({ key })))
          .pipe(Effect.orDie),
      reset: ({ key }) =>
        counter
          .getByName(key)
          .pipe(Effect.flatMap((c) => c.reset({ key })))
          .pipe(Effect.orDie),
    });

    return RpcServer.toHttpEffect(CounterRpcs).pipe(
      Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
    );
  }).pipe(
    Effect.provide(
      // WorkerA hosts `Counter`, so it must provide `CounterLive`.
      CounterLive.pipe(Layer.provide(Cloudflare.D1.QueryDatabaseBinding)),
    ),
  ),
);
