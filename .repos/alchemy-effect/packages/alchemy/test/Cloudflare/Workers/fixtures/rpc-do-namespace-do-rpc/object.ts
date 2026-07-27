import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { CounterRpcs } from "./group.ts";

/**
 * Typed counter Durable Object built on
 * {@link Cloudflare.RpcDurableObject}. Persists `count` in
 * `state.storage` and serves `Increment` / `Get` / `CountUpTo` over
 * an `RpcServer.toHttpEffect(group)` on the DO's `fetch`.
 */
export default class RpcCounterObject extends Cloudflare.RpcDurableObject<RpcCounterObject>()(
  "RpcCounterObject",
  { schema: CounterRpcs },
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      let count = (yield* state.storage.get<number>("count")) ?? 0;

      const handlers = CounterRpcs.toLayer({
        Increment: () =>
          Effect.gen(function* () {
            count += 1;
            yield* state.storage.put("count", count);
            return { count };
          }),
        Get: () => Effect.succeed({ count }),
        CountUpTo: ({ upto }) =>
          Stream.fromIterable(
            Array.from({ length: Math.max(0, upto) }, (_, i) => i + 1),
          ),
        Reset: () =>
          Effect.gen(function* () {
            count = 0;
            yield* state.storage.put("count", 0);
          }),
      });

      return RpcServer.toHttpEffect(CounterRpcs).pipe(
        Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
      );
    });
  }),
) {}
