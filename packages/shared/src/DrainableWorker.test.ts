import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";

import { makeDrainableWorker } from "./DrainableWorker.ts";

const captureErrorLogs = () => {
  const loggedErrors: Array<unknown> = [];
  const logger = Logger.make(({ logLevel, cause }) => {
    if (logLevel === "Error") loggedErrors.push(Cause.squash(cause));
  });
  return { loggedErrors, loggerLayer: Logger.layer([logger], { mergeWithExisting: false }) };
};

describe("makeDrainableWorker", () => {
  it.effect("logs a failed or defective item and keeps processing later items", () => {
    const { loggedErrors, loggerLayer } = captureErrorLogs();

    return Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const workerFiber = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
        const worker = yield* makeDrainableWorker((item: string) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(workerFiber, yield* Effect.fiber);
            if (item === "fail") return yield* Effect.fail("typed failure");
            if (item === "die") return yield* Effect.die("defect");
            if (item === "interrupt") return yield* Effect.interrupt;
            processed.push(item);
          }),
        );

        yield* worker.enqueue("fail");
        yield* worker.enqueue("die");
        yield* worker.enqueue("interrupt");
        yield* worker.enqueue("ok");

        // A stopped worker never drains; its exit settles the race instead of a hang.
        yield* Effect.raceFirst(worker.drain, Fiber.await(yield* Deferred.await(workerFiber)));

        expect(processed).toEqual(["ok"]);
        // The item that interrupted itself was cancelled, not failed.
        expect(loggedErrors).toEqual(["typed failure", "defect"]);
      }),
    ).pipe(Effect.provide(loggerLayer));
  });

  it.effect("stops quietly when its scope closes during an item", () => {
    const { loggedErrors, loggerLayer } = captureErrorLogs();

    return Effect.gen(function* () {
      const scope = yield* Scope.make();
      const processed: string[] = [];
      const workerFiber = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
      const worker = yield* makeDrainableWorker((item: string) =>
        Effect.gen(function* () {
          processed.push(item);
          yield* Deferred.succeed(workerFiber, yield* Effect.fiber);
          return yield* Effect.never;
        }),
      ).pipe(Scope.provide(scope));

      yield* worker.enqueue("block");
      yield* worker.enqueue("later");
      const fiber = yield* Deferred.await(workerFiber);
      yield* Scope.close(scope, Exit.void);

      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
      expect(processed).toEqual(["block"]);
      expect(loggedErrors).toEqual([]);

      // Queued and late items are dropped with the queue, so drain resolves at once.
      yield* worker.enqueue("after close");
      const drained = yield* Effect.forkChild(worker.drain, { startImmediately: true });
      expect(drained.pollUnsafe()).toEqual(Exit.void);
      expect(processed).toEqual(["block"]);
    }).pipe(Effect.provide(loggerLayer));
  });

  it.live("waits for work enqueued during active processing before draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const worker = yield* makeDrainableWorker((item: string) =>
          Effect.gen(function* () {
            if (item === "first") {
              yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseFirst);
            }

            if (item === "second") {
              yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseSecond);
            }

            processed.push(item);
          }),
        );

        yield* worker.enqueue("first");
        yield* Deferred.await(firstStarted);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );

        yield* worker.enqueue("second");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);

        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["first", "second"]);
      }),
    ),
  );
});
