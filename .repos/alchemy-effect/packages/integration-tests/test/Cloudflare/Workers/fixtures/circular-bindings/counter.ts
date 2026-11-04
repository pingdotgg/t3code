import * as Cloudflare from "@alchemy.run/cloudflare";
import type { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";

const COUNT_KEY = "count";

export class Counter extends Cloudflare.DurableObject<
  Counter,
  {
    increment: () => Effect.Effect<number, never, RuntimeContext>;
    get: () => Effect.Effect<number, never, RuntimeContext>;
  }
>()("Counter") {}

export const CounterLive = Counter.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      const get = Effect.fn(function* () {
        return (yield* state.storage.get<number>(COUNT_KEY)) ?? 0;
      });

      return {
        increment: Effect.fn(function* () {
          const next = (yield* get()) + 1;
          yield* state.storage.put(COUNT_KEY, next);
          return next;
        }),
        get,
      };
    });
  }),
);
