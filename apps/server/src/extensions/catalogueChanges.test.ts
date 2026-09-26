import { expect, it } from "@effect/vitest";
import { AuthOrchestrationReadScope, WS_METHODS } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import { make } from "./catalogueChanges.ts";

it.effect(
  "replays the current version on initial connection and reconnect, with a new epoch after restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const catalogue = yield* make;
        const initial = yield* catalogue.changes.pipe(Stream.take(1), Stream.runCollect);
        expect(initial).toHaveLength(1);
        expect(initial[0]?.revision).toBe(0);
        expect(Object.keys(initial[0]!)).toEqual(["epoch", "revision"]);
        yield* catalogue.publish;
        yield* catalogue.publish;
        const reconnect = yield* catalogue.changes.pipe(Stream.take(1), Stream.runCollect);
        expect(reconnect).toEqual([{ epoch: initial[0]!.epoch, revision: 2 }]);
        const restarted = yield* make;
        const fresh = yield* restarted.changes.pipe(Stream.take(1), Stream.runCollect);
        expect(fresh[0]?.epoch).not.toBe(initial[0]?.epoch);
        expect(fresh[0]?.revision).toBe(0);
      }),
    ),
);

it.effect(
  "delivers a mutation receipt to both connected clients without a snapshot subscription gap",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const catalogue = yield* make;
        const firstReady = yield* Deferred.make<void>();
        const secondReady = yield* Deferred.make<void>();
        const subscribe = (ready: Deferred.Deferred<void>) =>
          catalogue.changes.pipe(
            Stream.tap((event) =>
              event.revision === 0 ? Deferred.succeed(ready, undefined) : Effect.void,
            ),
            Stream.take(2),
            Stream.runCollect,
            Effect.forkChild,
          );
        const first = yield* subscribe(firstReady);
        const second = yield* subscribe(secondReady);
        yield* Deferred.await(firstReady);
        yield* Deferred.await(secondReady);
        yield* catalogue.publish;
        const a = yield* Fiber.join(first);
        const b = yield* Fiber.join(second);
        expect(a.map((event) => event.revision)).toEqual([0, 1]);
        expect(b).toEqual(a);
      }),
    ),
);

it.effect("coalesces a burst for a stalled client while preserving the latest invalidation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const catalogue = yield* make;
      const ready = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const client = yield* catalogue.changes.pipe(
        Stream.tap((event) =>
          event.revision === 0
            ? Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(resume)))
            : Effect.void,
        ),
        Stream.takeUntil((event) => event.revision === 1000),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(ready);
      for (let i = 0; i < 1000; i++) yield* catalogue.publish;
      yield* Deferred.succeed(resume, undefined);
      const received = yield* Fiber.join(client);
      expect(received[0]?.revision).toBe(0);
      expect(received.at(-1)?.revision).toBe(1000);
      // The stream may already have pulled one update before downstream stalls.
      expect(received.length).toBeLessThanOrEqual(3);
    }),
  ),
);

it("requires authenticated orchestration read scope for catalogue subscriptions", () => {
  expect(requiredScopeForRpcMethod(WS_METHODS.subscribeExtensionCatalogue)).toBe(
    AuthOrchestrationReadScope,
  );
});
