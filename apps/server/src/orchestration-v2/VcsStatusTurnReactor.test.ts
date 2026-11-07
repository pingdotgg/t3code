import {
  ProjectId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as VcsStatusTurnReactor from "./VcsStatusTurnReactor.ts";

const AT = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const WORKTREE_THREAD = ThreadId.make("thread-worktree");
const ROOT_THREAD = ThreadId.make("thread-root");
const OTHER_ROOT_THREAD = ThreadId.make("thread-root-other");
const PROJECT = ProjectId.make("project-1");

const itemEvent = (
  threadId: ThreadId,
  item: {
    readonly type: "file_change" | "command_execution" | "reasoning";
    readonly status: string;
  },
) =>
  ({
    type: "turn-item.updated",
    threadId,
    payload: {
      ...item,
      id: TurnItemId.make(`item-${item.type}`),
      threadId,
      updatedAt: AT,
      ...(item.type === "file_change" ? { fileName: "a.ts" } : {}),
      ...(item.type === "command_execution" ? { input: "git commit" } : {}),
    },
  }) as unknown as OrchestrationV2DomainEvent;

const layerFor = (input: {
  readonly events: Stream.Stream<OrchestrationV2DomainEvent>;
  readonly refreshWatchedStatus: (
    cwd: string,
    options: { readonly includeDivergence: boolean },
  ) => Effect.Effect<void>;
}) =>
  VcsStatusTurnReactor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: input.events }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: (threadId) =>
            Effect.succeed({
              projectId: PROJECT,
              worktreePath: threadId === WORKTREE_THREAD ? "/worktree" : null,
            } as never),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () => Effect.succeedSome({ workspaceRoot: "/root" } as never),
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshWatchedStatus: input.refreshWatchedStatus,
        }),
      ),
    ),
  );

const run = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  Effect.gen(function* () {
    const refreshed = yield* Queue.unbounded<string>();
    const consumed = yield* Deferred.make<void>();
    const layer = layerFor({
      events: Stream.concat(
        Stream.fromIterable(events),
        Stream.fromEffect(Deferred.succeed(consumed, undefined)).pipe(Stream.drain),
      ),
      refreshWatchedStatus: (cwd, { includeDivergence }) =>
        Queue.offer(refreshed, `${cwd} divergence=${includeDivergence}`).pipe(Effect.asVoid),
    });
    return yield* Effect.gen(function* () {
      const reactor = yield* VcsStatusTurnReactor.VcsStatusTurnReactor;
      yield* reactor.start();
      yield* Deferred.await(consumed);
      yield* TestClock.adjust("1 second");
      return yield* Queue.clear(refreshed);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped);

describe("VcsStatusTurnReactor", () => {
  it.effect("refreshes each checkout once for a burst across its threads", () =>
    Effect.gen(function* () {
      const refreshed = yield* run([
        itemEvent(WORKTREE_THREAD, { type: "file_change", status: "completed" }),
        itemEvent(WORKTREE_THREAD, { type: "file_change", status: "completed" }),
        itemEvent(ROOT_THREAD, { type: "file_change", status: "completed" }),
        itemEvent(OTHER_ROOT_THREAD, { type: "command_execution", status: "failed" }),
      ]);
      assert.sameMembers([...refreshed], ["/worktree divergence=false", "/root divergence=true"]);
    }),
  );

  it.effect("waits for tools to finish and ignores items that cannot change files", () =>
    Effect.gen(function* () {
      const refreshed = yield* run([
        itemEvent(WORKTREE_THREAD, { type: "file_change", status: "running" }),
        itemEvent(WORKTREE_THREAD, { type: "reasoning", status: "completed" }),
      ]);
      assert.lengthOf([...refreshed], 0);
    }),
  );

  it.effect("lets a running refresh finish, then refreshes for what landed during it", () =>
    Effect.gen(function* () {
      const edit = itemEvent(WORKTREE_THREAD, { type: "file_change", status: "completed" });
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const consumed = yield* Deferred.make<void>();
      const finished = yield* Queue.unbounded<"finished" | "interrupted">();
      const layer = layerFor({
        events: Stream.concat(
          Stream.make(edit),
          Stream.fromEffect(Deferred.await(started).pipe(Effect.as(edit))),
        ).pipe(
          Stream.concat(
            Stream.fromEffect(Deferred.succeed(consumed, undefined)).pipe(Stream.drain),
          ),
        ),
        refreshWatchedStatus: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Queue.offer(finished, "finished")),
            Effect.onInterrupt(() => Queue.offer(finished, "interrupted")),
            Effect.asVoid,
          ),
      });
      yield* Effect.gen(function* () {
        const reactor = yield* VcsStatusTurnReactor.VcsStatusTurnReactor;
        yield* reactor.start();
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(consumed);
        yield* Deferred.succeed(release, undefined);
        assert.equal(yield* Queue.take(finished), "finished");
        yield* TestClock.adjust("1 second");
        assert.equal(yield* Queue.take(finished), "finished");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
  );
});
