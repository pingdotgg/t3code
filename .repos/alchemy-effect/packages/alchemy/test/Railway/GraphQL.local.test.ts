import * as railway from "@distilled.cloud/railway";
import {
  ResourceDeletionPending,
  waitUntilDeleted,
} from "@/Railway/GraphQL.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

describe("Railway deletion confirmation", () => {
  it.effect(
    "fails with resource identity when bounded polls never confirm absence",
    () =>
      Effect.gen(function* () {
        let reads = 0;
        const absent = Effect.sync(() => {
          reads++;
          return false;
        });
        const fiber = yield* waitUntilDeleted(
          "Railway.Project",
          "project-1",
          absent,
        ).pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));

        yield* TestClock.adjust("8 seconds");
        const error = yield* Fiber.join(fiber);
        expect(error).toBeInstanceOf(ResourceDeletionPending);
        expect(error._tag).toBe("Railway.ResourceDeletionPending");
        expect(error.resourceType).toBe("Railway.Project");
        expect(error.resourceId).toBe("project-1");
        expect(reads).toBe(9);
      }),
  );

  it.effect("succeeds immediately when the first read confirms absence", () =>
    Effect.gen(function* () {
      let reads = 0;
      const result = yield* waitUntilDeleted(
        "Railway.Service",
        "service-1",
        Effect.sync(() => {
          reads++;
          return true;
        }),
      );
      expect(result).toBeUndefined();
      expect(reads).toBe(1);
    }),
  );

  it.effect("stops polling once a later read confirms absence", () =>
    Effect.gen(function* () {
      let reads = 0;
      const fiber = yield* waitUntilDeleted(
        "Railway.Group",
        "group-1",
        Effect.sync(() => ++reads === 3),
        4,
      ).pipe(Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust("2 seconds");
      expect(yield* Fiber.join(fiber)).toBeUndefined();
      yield* TestClock.adjust("10 seconds");
      expect(reads).toBe(3);
    }),
  );

  it.effect(
    "preserves the query's typed aggregate failure during polling",
    () =>
      Effect.gen(function* () {
        const denied = new railway.RailwayForbidden({
          message: "Not Authorized",
          path: ["project"],
        });
        const failure = new railway.GraphQLFailure({
          errors: [denied],
          data: { project: null },
          status: 200,
        });
        let reads = 0;
        const absent = Effect.suspend(() =>
          ++reads === 1 ? Effect.succeed(false) : Effect.fail(failure),
        );
        const fiber = yield* waitUntilDeleted(
          "Railway.Project",
          "project-1",
          absent,
        ).pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));

        yield* TestClock.adjust("1 second");
        const error = yield* Fiber.join(fiber);
        expect(error).toBe(failure);
        expect(railway.isErrorTag(error, "RailwayForbidden")).toBe(true);
        yield* TestClock.adjust("10 seconds");
        expect(reads).toBe(2);
      }),
  );
});
