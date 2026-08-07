import { assert, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import { ThreadId, WorktreeMutationError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as WorktreeDeletionCleanup from "./WorktreeDeletionCleanup.ts";
import * as WorktreeService from "./WorktreeService.ts";

const threadId = ThreadId.make("thread:worktree-deletion-cleanup");

const deletionEvent = (worktreePath: string | null) =>
  ({
    type: "thread.deleted",
    threadId,
    payload: { worktreePath },
  }) as unknown as OrchestrationV2DomainEvent;

const makeLayer = (
  pruneOrphanedWorktree: WorktreeService.WorktreeService["Service"]["pruneOrphanedWorktree"],
  options: {
    readonly deleteOrphanedImmediately: boolean;
    readonly events?: Stream.Stream<OrchestrationV2DomainEvent, unknown>;
  },
) => {
  const worktrees = Layer.succeed(
    WorktreeService.WorktreeService,
    WorktreeService.WorktreeService.of({
      listWorktrees: () => Effect.succeed({ worktrees: [] }),
      pruneWorktrees: () => Effect.succeed({ removed: [], skipped: [] }),
      pruneOrphanedWorktree,
      reviveWorktree: () => Effect.succeed({ revived: false }),
    }),
  );
  return WorktreeDeletionCleanup.layerWithEventStream(options.events ?? Stream.empty).pipe(
    Layer.provide(worktrees),
    Layer.provide(
      ServerSettings.layerTest({
        worktrees: {
          autoPruneAfterDays: null,
          deleteOrphanedImmediately: options.deleteOrphanedImmediately,
        },
      }),
    ),
  );
};

it.effect("prunes only non-null worktree paths while immediate orphan cleanup is enabled", () =>
  Effect.gen(function* () {
    const pruned: string[] = [];
    const prune = (path: string) =>
      Effect.sync(() => {
        pruned.push(path);
        return true;
      });

    yield* Effect.gen(function* () {
      const cleanup = yield* WorktreeDeletionCleanup.WorktreeDeletionCleanup;
      yield* cleanup.enqueue({ threadId, worktreePath: "/worktrees/disabled" });
      yield* cleanup.drain;
    }).pipe(
      Effect.provide(
        makeLayer(prune, {
          deleteOrphanedImmediately: false,
        }),
      ),
    );

    yield* Effect.gen(function* () {
      const cleanup = yield* WorktreeDeletionCleanup.WorktreeDeletionCleanup;
      yield* cleanup.enqueue({ threadId, worktreePath: null });
      yield* cleanup.enqueue({ threadId, worktreePath: "/worktrees/orphan" });
      yield* cleanup.drain;
    }).pipe(
      Effect.provide(
        makeLayer(prune, {
          deleteOrphanedImmediately: true,
        }),
      ),
    );

    assert.deepEqual(pruned, ["/worktrees/orphan"]);
  }),
);

it.effect("keeps processing deletion cleanup after an individual failure", () =>
  Effect.gen(function* () {
    const attempted: string[] = [];
    const prune = (path: string) =>
      Effect.suspend(() => {
        attempted.push(path);
        if (attempted.length === 1) {
          return Effect.fail(
            new WorktreeMutationError({
              operation: "prune",
              path,
              message: "simulated removal failure",
            }),
          );
        }
        return Effect.succeed(true);
      });

    yield* Effect.gen(function* () {
      const cleanup = yield* WorktreeDeletionCleanup.WorktreeDeletionCleanup;
      yield* cleanup.enqueue({ threadId, worktreePath: "/worktrees/first" });
      yield* cleanup.enqueue({ threadId, worktreePath: "/worktrees/second" });
      yield* cleanup.drain;
    }).pipe(
      Effect.provide(
        makeLayer(prune, {
          deleteOrphanedImmediately: true,
        }),
      ),
    );

    assert.deepEqual(attempted, ["/worktrees/first", "/worktrees/second"]);
  }),
);

it.effect("subscribes once and routes thread deletion events to cleanup", () =>
  Effect.gen(function* () {
    const observedPath = yield* Deferred.make<string>();
    const pruned: string[] = [];
    const prune = (path: string) =>
      Effect.sync(() => pruned.push(path)).pipe(
        Effect.andThen(Deferred.succeed(observedPath, path)),
        Effect.as(true),
      );
    const layer = makeLayer(prune, {
      deleteOrphanedImmediately: true,
      events: Stream.fromIterable([deletionEvent("/worktrees/from-event")]),
    });

    yield* Effect.gen(function* () {
      const cleanup = yield* WorktreeDeletionCleanup.WorktreeDeletionCleanup;
      yield* cleanup.start();
      yield* cleanup.start();
      assert.equal(yield* Deferred.await(observedPath), "/worktrees/from-event");
      yield* cleanup.drain;
    }).pipe(Effect.provide(layer));

    assert.deepEqual(pruned, ["/worktrees/from-event"]);
  }),
);

it.effect("restarts the domain event subscription after a stream failure", () =>
  Effect.gen(function* () {
    const firstAttemptStarted = yield* Deferred.make<void>();
    const recoveredPath = yield* Deferred.make<string>();
    const attempts = yield* Ref.make(0);
    const events: Stream.Stream<OrchestrationV2DomainEvent, string> = Stream.unwrap(
      Ref.getAndUpdate(attempts, (count) => count + 1).pipe(
        Effect.map(
          (attempt): Stream.Stream<OrchestrationV2DomainEvent, string> =>
            attempt === 0
              ? Stream.concat(
                  Stream.fromEffect(Deferred.succeed(firstAttemptStarted, undefined)).pipe(
                    Stream.drain,
                  ),
                  Stream.fail("simulated subscription failure"),
                )
              : Stream.fromIterable([deletionEvent("/worktrees/recovered")]),
        ),
      ),
    );
    const prune = (path: string) => Deferred.succeed(recoveredPath, path).pipe(Effect.as(true));
    const layer = makeLayer(prune, {
      deleteOrphanedImmediately: true,
      events,
    });

    yield* Effect.gen(function* () {
      const cleanup = yield* WorktreeDeletionCleanup.WorktreeDeletionCleanup;
      yield* cleanup.start();
      yield* cleanup.start();
      yield* Deferred.await(firstAttemptStarted);
      yield* TestClock.adjust("1 second");
      assert.equal(yield* Deferred.await(recoveredPath), "/worktrees/recovered");
      yield* cleanup.drain;
      assert.equal(yield* Ref.get(attempts), 2);
    }).pipe(Effect.provide(layer));
  }),
);
