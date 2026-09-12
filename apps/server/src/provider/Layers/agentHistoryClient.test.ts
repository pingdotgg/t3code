import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { makeAgentHistoryClient } from "./agentHistoryClient.ts";

describe("saved history transport lifetime", () => {
  it.effect(
    "shares concurrent and repeated reads, isolates directories, and releases idle clients",
    () =>
      Effect.gen(function* () {
        const opened: string[] = [];
        const closed: string[] = [];
        yield* Effect.scoped(
          Effect.gen(function* () {
            const use = yield* makeAgentHistoryClient((cwd) =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  opened.push(cwd);
                  return cwd;
                }),
                (cwd) =>
                  Effect.sync(() => {
                    closed.push(cwd);
                  }),
              ),
            );
            yield* Effect.all([use("a", Effect.succeed), use("a", Effect.succeed)], {
              concurrency: "unbounded",
            });
            yield* use("a", Effect.succeed);
            yield* use("b", Effect.succeed);
            expect(opened).toEqual(["a", "b"]);
            expect(closed).toEqual([]);
            yield* TestClock.adjust("31 seconds");
            expect(closed.sort()).toEqual(["a", "b"]);
            yield* use("a", Effect.succeed);
            expect(opened).toEqual(["a", "b", "a"]);
          }),
        );
        expect(closed).toEqual(["a", "b", "a"]);
      }),
  );

  it.effect("invalidates failed reads and retries on a fresh client", () =>
    Effect.gen(function* () {
      let opened = 0;
      let closed = 0;
      const use = yield* makeAgentHistoryClient(() =>
        Effect.acquireRelease(
          Effect.sync(() => ++opened),
          () =>
            Effect.sync(() => {
              closed++;
            }),
        ),
      );
      yield* use("a", () => Effect.fail("disconnected")).pipe(Effect.flip);
      expect(closed).toBe(1);
      expect(yield* use("a", Effect.succeed)).toBe(2);
    }),
  );

  it.effect("cleans up a transport whose initialization never completes", () =>
    Effect.gen(function* () {
      let closed = 0;
      const started = yield* Deferred.make<void>();
      const use = yield* makeAgentHistoryClient(() =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed++;
            }),
          );
          yield* Deferred.succeed(started, undefined);
          return yield* Effect.never;
        }),
      );
      const pending = yield* use("a", Effect.succeed).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("21 seconds");
      expect((yield* Fiber.await(pending))._tag).toBe("Failure");
      expect(closed).toBe(1);
    }),
  );
  it.effect("releases a timed-out read before returning and permits a fresh lookup", () =>
    Effect.gen(function* () {
      let closed = 0;
      const started = yield* Deferred.make<void>();
      const use = yield* makeAgentHistoryClient(() =>
        Effect.acquireRelease(Effect.succeed("client"), () =>
          Effect.sync(() => {
            closed++;
          }),
        ),
      );
      const pending = yield* use("a", () =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("21 seconds");
      const result = yield* Fiber.await(pending);
      expect(result._tag).toBe("Failure");
      expect(closed).toBe(1);
      expect(yield* use("a", Effect.succeed)).toBe("client");
    }),
  );
});
