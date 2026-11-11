import { fromDurableObjectState } from "@alchemy.run/cloudflare/Workers/DurableObjectState";
import { fromDurableObjectStorage } from "@alchemy.run/cloudflare/Workers/DurableObjectStorage";
import { describe, expect, it } from "@alchemy.run/test";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

/**
 * `waitUntil` captures the caller's context and provides it to the Effect it
 * runs. `blockConcurrencyWhile` and `storage.transaction` run their closures
 * through a bare `Effect.runPromise` on the raw platform promise, so a service
 * provided to the calling fiber (a request-scoped deadline, a tracer, an alarm
 * floor) must reach those closures the same way.
 */
class Marker extends Context.Service<Marker, { readonly value: string }>()("test/Marker") {}

const readMarker = Effect.map(Marker, (marker) => marker.value);

describe(
  "Durable Object callbacks run with the caller's context",
  {
    tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"],
  },
  () => {
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

    it.live("storage.transaction interrupts a callback that synchronously cancels its caller", () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
        let cleaned = false;
        const storage = fromDurableObjectStorage({
          sql: {},
          // Native storage starts the callback after its caller has suspended.
          transaction: <T>(closure: (txn: unknown) => Promise<T>) =>
            Promise.resolve().then(() => closure({})),
        } as never);

        const caller = yield* Effect.withFiber((parent) =>
          storage.transaction(() =>
            Effect.withFiber((callback) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, callback);
                yield* Effect.sync(() => parent.interruptUnsafe());
                yield* Effect.never;
              }),
            ).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  cleaned = true;
                }),
              ),
            ),
          ),
        ).pipe(Effect.forkScoped);
        const callback = yield* Deferred.await(entered);

        yield* Effect.gen(function* () {
          const exit = yield* Fiber.await(caller).pipe(Effect.timeout("1 second"));
          expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
          expect(cleaned).toBe(true);
        }).pipe(
          // A regression must fail without leaving the callback stuck.
          Effect.ensuring(Fiber.interrupt(callback)),
        );
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );
  },
);
