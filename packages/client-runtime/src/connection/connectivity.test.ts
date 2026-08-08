import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ConnectionWakeups from "./wakeups.ts";
import * as Connectivity from "./connectivity.ts";

describe("followNetworkStatus", () => {
  it.effect("applies the current status when the follower starts", () =>
    Effect.gen(function* () {
      const applied = yield* Ref.make<ReadonlyArray<string>>([]);

      yield* Connectivity.followNetworkStatus({
        apply: (status) => Ref.update(applied, (current) => [...current, status]),
      });

      expect(yield* Ref.get(applied)).toEqual(["offline"]);
    }).pipe(
      Effect.provideService(
        Connectivity.Connectivity,
        Connectivity.Connectivity.of({ status: Effect.succeed("offline"), changes: Stream.never }),
      ),
      Effect.provideService(
        ConnectionWakeups.ConnectionWakeups,
        ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.never }),
      ),
      Effect.scoped,
    ),
  );

  it.effect("does not let a duplicate report invalidate an in-flight wakeup snapshot", () =>
    Effect.gen(function* () {
      const statusReads = yield* Ref.make(0);
      const wake = yield* Deferred.make<void>();
      const duplicate = yield* Deferred.make<void>();
      const duplicateHandled = yield* Deferred.make<void>();
      const secondReadStarted = yield* Deferred.make<void>();
      const releaseSecondRead = yield* Deferred.make<void>();
      const wakeHandled = yield* Deferred.make<void>();
      const applied = yield* Ref.make<ReadonlyArray<string>>([]);

      yield* Effect.gen(function* () {
        yield* Connectivity.followNetworkStatus({
          apply: (status) => Ref.update(applied, (current) => [...current, status]),
        });

        yield* Deferred.succeed(wake, undefined);
        yield* Deferred.await(secondReadStarted);
        yield* Deferred.succeed(duplicate, undefined);
        yield* Deferred.await(duplicateHandled);
        yield* Deferred.succeed(releaseSecondRead, undefined);
        yield* Deferred.await(wakeHandled);

        expect(yield* Ref.get(statusReads)).toBe(2);
        expect(yield* Ref.get(applied)).toEqual(["offline", "online"]);
      }).pipe(
        Effect.provideService(
          Connectivity.Connectivity,
          Connectivity.Connectivity.of({
            status: Ref.updateAndGet(statusReads, (count) => count + 1).pipe(
              Effect.flatMap((read) =>
                read === 1
                  ? Effect.succeed("offline" as const)
                  : Deferred.succeed(secondReadStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseSecondRead)),
                      Effect.as("online" as const),
                    ),
              ),
            ),
            changes: Stream.fromEffect(
              Deferred.await(duplicate).pipe(Effect.as("offline" as const)),
            ).pipe(
              Stream.concat(
                Stream.fromEffect(
                  Deferred.succeed(duplicateHandled, undefined).pipe(Effect.andThen(Effect.never)),
                ),
              ),
            ),
          }),
        ),
        Effect.provideService(
          ConnectionWakeups.ConnectionWakeups,
          ConnectionWakeups.ConnectionWakeups.of({
            changes: Stream.fromEffect(
              Deferred.await(wake).pipe(Effect.as("application-active" as const)),
            ).pipe(
              Stream.concat(
                Stream.fromEffect(
                  Deferred.succeed(wakeHandled, undefined).pipe(Effect.andThen(Effect.never)),
                ),
              ),
            ),
          }),
        ),
        Effect.scoped,
      );
    }),
  );

  it.effect("lets a wakeup refresh supersede the pending initial snapshot", () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0);
      const firstReadStarted = yield* Deferred.make<void>();
      const releaseFirstRead = yield* Deferred.make<void>();
      const wake = yield* Deferred.make<void>();
      const onlineApplied = yield* Deferred.make<void>();

      yield* Effect.gen(function* () {
        const follower = yield* Connectivity.followNetworkStatus({
          apply: (status) =>
            status === "online"
              ? Deferred.succeed(onlineApplied, undefined).pipe(Effect.asVoid)
              : Effect.void,
        }).pipe(Effect.forkChild);

        yield* Deferred.await(firstReadStarted);
        yield* Deferred.succeed(wake, undefined);
        yield* Deferred.await(onlineApplied);
        yield* Deferred.succeed(releaseFirstRead, undefined);
        yield* Fiber.join(follower);

        expect(yield* Ref.get(reads)).toBe(2);
      }).pipe(
        Effect.provideService(
          Connectivity.Connectivity,
          Connectivity.Connectivity.of({
            status: Ref.updateAndGet(reads, (count) => count + 1).pipe(
              Effect.flatMap((read) =>
                read === 1
                  ? Deferred.succeed(firstReadStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseFirstRead)),
                      Effect.as("offline" as const),
                    )
                  : Effect.succeed("online" as const),
              ),
            ),
            changes: Stream.never,
          }),
        ),
        Effect.provideService(
          ConnectionWakeups.ConnectionWakeups,
          ConnectionWakeups.ConnectionWakeups.of({
            changes: Stream.fromEffect(
              Deferred.await(wake).pipe(Effect.as("application-active" as const)),
            ).pipe(Stream.concat(Stream.never)),
          }),
        ),
        Effect.scoped,
      );
    }),
  );
});
