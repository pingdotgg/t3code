import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Deferred, Effect } from "effect";

import { makeDrainableWorker, makeKeyedDrainableWorker } from "./DrainableWorker.ts";

describe("makeDrainableWorker", () => {
  it.live("waits for work enqueued during active processing before draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const worker = yield* makeDrainableWorker(
          (item: string) =>
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
          { capacity: 1 },
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

  it.live("applies backpressure when the queue reaches capacity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const thirdOfferStarted = yield* Deferred.make<void>();
        const thirdEnqueued = yield* Deferred.make<void>();
        const processed: string[] = [];

        const worker = yield* makeDrainableWorker(
          (item: string) =>
            Effect.gen(function* () {
              if (item === "first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirst);
              }
              processed.push(item);
            }),
          { capacity: 1 },
        );

        yield* worker.enqueue("first");
        yield* Deferred.await(firstStarted);
        yield* worker.enqueue("second");
        yield* Effect.forkChild(
          Deferred.succeed(thirdOfferStarted, undefined).pipe(
            Effect.andThen(
              worker
                .enqueue("third")
                .pipe(
                  Effect.tap(() => Deferred.succeed(thirdEnqueued, undefined).pipe(Effect.orDie)),
                ),
            ),
          ),
        );
        yield* Deferred.await(thirdOfferStarted);

        expect(yield* Deferred.isDone(thirdEnqueued)).toBe(false);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(thirdEnqueued);
        yield* worker.drain;

        expect(processed).toEqual(["first", "second", "third"]);
      }),
    ),
  );

  it.live("processes up to the configured concurrency and drains all work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();

        const worker = yield* makeDrainableWorker(
          (item: string) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(
                item === "first" ? firstStarted : secondStarted,
                undefined,
              ).pipe(Effect.orDie);
              yield* Deferred.await(release);
            }),
          { capacity: 2, concurrency: 2 },
        );

        yield* worker.enqueue("first");
        yield* worker.enqueue("second");
        yield* Deferred.await(firstStarted);
        yield* Deferred.await(secondStarted);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );
        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(drained);
      }),
    ),
  );
});

describe("makeKeyedDrainableWorker", () => {
  interface Job {
    readonly id: string;
    readonly keys: ReadonlyArray<string>;
    readonly gate?: Deferred.Deferred<void>;
    readonly fail?: boolean;
  }

  const makeHarness = Effect.gen(function* () {
    const started: string[] = [];
    const finished: string[] = [];
    const worker = yield* makeKeyedDrainableWorker(
      (job: Job) =>
        Effect.gen(function* () {
          started.push(job.id);
          if (job.gate) yield* Deferred.await(job.gate);
          if (job.fail) return yield* Effect.die("boom");
          finished.push(job.id);
        }),
      (job) => job.keys,
    );
    return { started, finished, worker };
  });

  it.live("runs other keys while one key is blocked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, finished, worker } = yield* makeHarness;
        const gate = yield* Deferred.make<void>();
        yield* worker.enqueue({ id: "a1", keys: ["a"], gate });
        yield* worker.enqueue({ id: "b1", keys: ["b"] });
        yield* Effect.sleep("20 millis");

        expect(finished).toEqual(["b1"]);
        expect(started).toContain("a1");
        yield* Deferred.succeed(gate, undefined);
        yield* worker.drain;
        expect(finished).toEqual(["b1", "a1"]);
      }),
    ),
  );

  it.live("keeps strict enqueue order within a key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, finished, worker } = yield* makeHarness;
        const gate = yield* Deferred.make<void>();
        yield* worker.enqueue({ id: "a1", keys: ["a"], gate });
        yield* worker.enqueue({ id: "a2", keys: ["a"] });
        yield* worker.enqueue({ id: "a3", keys: ["a"] });
        yield* Effect.sleep("20 millis");

        expect(started).toEqual(["a1"]);
        yield* Deferred.succeed(gate, undefined);
        yield* worker.drain;
        expect(finished).toEqual(["a1", "a2", "a3"]);
      }),
    ),
  );

  it.live("orders a multi-key item against every key it names", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, finished, worker } = yield* makeHarness;
        const gateA = yield* Deferred.make<void>();
        yield* worker.enqueue({ id: "a1", keys: ["a"], gate: gateA });
        yield* worker.enqueue({ id: "fork", keys: ["b", "a"] });
        yield* worker.enqueue({ id: "b2", keys: ["b"] });
        yield* Effect.sleep("20 millis");

        expect(started).toEqual(["a1"]);
        yield* Deferred.succeed(gateA, undefined);
        yield* worker.drain;
        expect(finished).toEqual(["a1", "fork", "b2"]);
      }),
    ),
  );

  it.live("continues a key after an item dies", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { finished, worker } = yield* makeHarness;
        yield* worker.enqueue({ id: "a1", keys: ["a"], fail: true });
        yield* worker.enqueue({ id: "a2", keys: ["a"] });
        yield* worker.drain;
        expect(finished).toEqual(["a2"]);
      }),
    ),
  );

  it.live("drains only after every key is idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { worker } = yield* makeHarness;
        const gate = yield* Deferred.make<void>();
        yield* worker.enqueue({ id: "a1", keys: ["a"], gate });
        yield* worker.enqueue({ id: "b1", keys: ["b"] });
        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(Effect.andThen(Deferred.succeed(drained, undefined))),
        );
        yield* Effect.sleep("20 millis");

        expect(yield* Deferred.isDone(drained)).toBe(false);
        yield* Deferred.succeed(gate, undefined);
        yield* Deferred.await(drained);
      }),
    ),
  );
});
