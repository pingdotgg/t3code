import { fromDurableObjectState } from "@/Cloudflare/Workers/DurableObjectState.ts";
import { fromDurableObjectStorage } from "@/Cloudflare/Workers/DurableObjectStorage.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { describe, expect, it } from "alchemy-test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * `waitUntil` captures the caller's context and provides it to the Effect it
 * runs. `blockConcurrencyWhile` and `storage.transaction` run their closures
 * through a bare `Effect.runPromise` on the raw platform promise, so a service
 * provided to the calling fiber (a request-scoped deadline, a tracer, an alarm
 * floor) must reach those closures the same way.
 */
class Marker extends Context.Service<Marker, { readonly value: string }>()(
  "test/Marker",
) {}

const readMarker = Effect.map(Marker, (marker) => marker.value);

describe("Durable Object callbacks run with the caller's context", () => {
  it.effect("blockConcurrencyWhile provides the calling fiber's services", () =>
    Effect.gen(function* () {
      const state = fromDurableObjectState({
        id: { toString: () => "id" },
        storage: { sql: {} },
        blockConcurrencyWhile: <T>(callback: () => Promise<T>) => callback(),
      } as never);

      const value = yield* state.blockConcurrencyWhile(() => readMarker);

      expect(value).toBe("inside the gate");
    }).pipe(
      Effect.provideService(Marker, { value: "inside the gate" }),
      Effect.provide(RuntimeContext.phantom),
    ),
  );

  it.effect("storage.transaction provides the calling fiber's services", () =>
    Effect.gen(function* () {
      const txn = { getAlarm: () => Promise.resolve(42) };
      const storage = fromDurableObjectStorage({
        sql: {},
        transaction: <T>(closure: (txn: unknown) => Promise<T>) => closure(txn),
      } as never);

      const value = yield* storage.transaction((transaction) =>
        Effect.all([readMarker, transaction.getAlarm()]),
      );

      expect(value).toEqual(["inside the transaction", 42]);
    }).pipe(
      Effect.provideService(Marker, { value: "inside the transaction" }),
      Effect.provide(RuntimeContext.phantom),
    ),
  );
});
