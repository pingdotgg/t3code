import { assert, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent, OrchestrationV2StoredEvent } from "@t3tools/contracts";
import { ThreadId, WorktreeMutationError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as EventSink from "../orchestration-v2/EventSink.ts";
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

const storedDeletionEvent = (sequence: number, worktreePath: string | null) =>
  ({
    sequence,
    commandId: null,
    event: deletionEvent(worktreePath),
  }) satisfies OrchestrationV2StoredEvent;

interface TestEventSource {
  readonly latestSequence: Effect.Effect<number, EventSink.EventSinkV2Error>;
  readonly streamStoredEventsFrom: (
    afterSequence: number,
  ) => Stream.Stream<OrchestrationV2StoredEvent, EventSink.EventSinkV2Error>;
}

const makeLayer = (
  pruneOrphanedWorktree: WorktreeService.WorktreeService["Service"]["pruneOrphanedWorktree"],
  options: {
    readonly deleteOrphanedImmediately: boolean;
    readonly eventSource?: TestEventSource;
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
  const eventSource = options.eventSource ?? {
    latestSequence: Effect.succeed(0),
    streamStoredEventsFrom: () => Stream.empty,
  };
  return WorktreeDeletionCleanup.layer.pipe(
    Layer.provide(worktrees),
    Layer.provide(
      Layer.mock(EventSink.EventSinkV2)({
        latestSequence: () => eventSource.latestSequence,
        stream: (input) => eventSource.streamStoredEventsFrom(input?.afterSequence ?? 0),
      }),
    ),
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
              stage: "revalidate_inventory",
              path,
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

it.effect("preserves deletion cleanup interruption", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.interrupt.pipe(
      WorktreeDeletionCleanup.__testing.recoverDeletionFailure({
        threadId,
        worktreePath: "/worktrees/interrupted",
      }),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
    }
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
      eventSource: {
        latestSequence: Effect.succeed(0),
        streamStoredEventsFrom: (afterSequence) =>
          Stream.fromIterable([storedDeletionEvent(1, "/worktrees/from-event")]).pipe(
            Stream.filter((stored) => stored.sequence > afterSequence),
          ),
      },
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

it.effect("resumes stored deletion events from the last consumed sequence after a failure", () =>
  Effect.gen(function* () {
    const firstAttemptFailed = yield* Deferred.make<void>();
    const recoveredPath = yield* Deferred.make<string>();
    const attempts = yield* Ref.make(0);
    const requestedAfterSequences = yield* Ref.make<ReadonlyArray<number>>([]);
    const storedEvents = yield* Ref.make<ReadonlyArray<OrchestrationV2StoredEvent>>([
      storedDeletionEvent(1, "/worktrees/before-failure"),
    ]);
    const eventSource: TestEventSource = {
      latestSequence: Effect.succeed(0),
      streamStoredEventsFrom: (afterSequence) =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* Ref.update(requestedAfterSequences, (current) => [...current, afterSequence]);
            const attempt = yield* Ref.getAndUpdate(attempts, (count) => count + 1);
            const available = (yield* Ref.get(storedEvents)).filter(
              (stored) => stored.sequence > afterSequence,
            );
            return attempt === 0
              ? Stream.concat(
                  Stream.fromIterable(available),
                  Stream.fromEffect(Deferred.succeed(firstAttemptFailed, undefined)).pipe(
                    Stream.drain,
                    Stream.concat(
                      Stream.fail(
                        new EventSink.EventSinkStreamError({
                          afterSequence,
                          cause: "simulated subscription failure",
                        }),
                      ),
                    ),
                  ),
                )
              : Stream.fromIterable(available);
          }),
        ),
    };
    const pruned: string[] = [];
    const prune = (path: string) =>
      Effect.sync(() => pruned.push(path)).pipe(
        Effect.andThen(
          path === "/worktrees/recovered"
            ? Deferred.succeed(recoveredPath, path)
            : Effect.succeed(false),
        ),
        Effect.as(true),
      );
    const layer = makeLayer(prune, {
      deleteOrphanedImmediately: true,
      eventSource,
    });

    yield* Effect.gen(function* () {
      const cleanup = yield* WorktreeDeletionCleanup.WorktreeDeletionCleanup;
      yield* cleanup.start();
      yield* cleanup.start();
      yield* Deferred.await(firstAttemptFailed);
      yield* Ref.set(storedEvents, [
        storedDeletionEvent(1, "/worktrees/before-failure"),
        storedDeletionEvent(2, "/worktrees/recovered"),
      ]);
      yield* TestClock.adjust("1 second");
      assert.equal(yield* Deferred.await(recoveredPath), "/worktrees/recovered");
      yield* cleanup.drain;
      assert.equal(yield* Ref.get(attempts), 2);
      assert.deepEqual(yield* Ref.get(requestedAfterSequences), [0, 1]);
      assert.deepEqual(pruned, ["/worktrees/before-failure", "/worktrees/recovered"]);
    }).pipe(Effect.provide(layer));
  }),
);
