import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { withWorkspaceLease } from "./workspaceLease.ts";

it.effect("lets the holder take its lease again while others wait", () =>
  Effect.gen(function* () {
    const order: Array<string> = [];
    const holding = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holder = yield* Effect.forkChild(
      withWorkspaceLease(
        "/worktree",
        Effect.gen(function* () {
          // A nested take by the holder, such as removal opening a terminal
          // in the checkout, runs instead of waiting on itself.
          yield* withWorkspaceLease(
            "/worktree",
            Effect.sync(() => order.push("holder nested")),
          );
          yield* Deferred.succeed(holding, undefined);
          yield* Deferred.await(release);
          order.push("holder done");
        }),
      ),
    );
    yield* Deferred.await(holding);
    const other = yield* Effect.forkChild(
      withWorkspaceLease(
        "/worktree",
        Effect.sync(() => order.push("other")),
      ),
    );
    yield* Effect.yieldNow;
    assert.deepEqual(order, ["holder nested"]);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    yield* Fiber.join(other);
    assert.deepEqual(order, ["holder nested", "holder done", "other"]);
  }),
);
