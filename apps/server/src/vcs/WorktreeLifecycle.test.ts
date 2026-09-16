import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { layer, WorktreeLifecycle } from "./WorktreeLifecycle.ts";

it.effect("serializes worktree mutations and publishes inventory revisions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const lifecycle = yield* WorktreeLifecycle;
      const firstEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondQueued = yield* Deferred.make<void>();
      const secondEntered = yield* Deferred.make<void>();

      const initialChange = yield* Stream.runHead(lifecycle.changes);
      assert.deepEqual(Option.getOrThrow(initialChange), { revision: 0 });

      const first = yield* lifecycle
        .withMutationPermit(
          Deferred.succeed(firstEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirst)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstEntered);

      const second = yield* Deferred.succeed(secondQueued, undefined).pipe(
        Effect.andThen(lifecycle.withMutationPermit(Deferred.succeed(secondEntered, undefined))),
        Effect.forkChild,
      );
      yield* Deferred.await(secondQueued);
      assert.isTrue(Option.isNone(yield* Deferred.poll(secondEntered)));

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.isTrue(Option.isSome(yield* Deferred.poll(secondEntered)));

      yield* lifecycle.markInventoryChanged;
      const changed = yield* Stream.runHead(lifecycle.changes);
      assert.deepEqual(Option.getOrThrow(changed), { revision: 1 });
    }),
  ).pipe(Effect.provide(layer)),
);
