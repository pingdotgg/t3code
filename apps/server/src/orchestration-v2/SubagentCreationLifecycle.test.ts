import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Lifecycle tests do not start providers"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const infrastructure = Layer.mergeAll(
  ProviderReplayHarness.layerWithRegistry(
    { name: "subagent-creation-lifecycle" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ThreadCommandExecutor.layer,
  IdAllocator.layer,
);
const layerTest = ProviderEventIngestor.layer.pipe(Layer.provideMerge(infrastructure));

const fixture = Effect.fnUntraced(function* (name: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
  const threadId = ThreadId.make(`parent:${name}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${name}`),
    threadId,
    projectId: ProjectId.make(`project:${name}`),
    title: name,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const parent = yield* projections.getThread(threadId);
  const child: OrchestrationV2AppThread = {
    ...parent,
    id: ThreadId.make(`child:${name}`),
    lineage: { parentThreadId: threadId, relationshipToParent: "subagent", rootThreadId: threadId },
  };
  const lifecycle = (type: "thread.archive" | "thread.unarchive" | "thread.delete") =>
    orchestrator.dispatch({ type, commandId: CommandId.make(`${type}:${name}`), threadId });
  const ingest = (appThread = child) =>
    ingestor.ingestNormalized({
      providerSessionId: ProviderSessionId.make(`session:${name}`),
      providerInstanceId: instanceId,
      threadId,
      event: { type: "app_thread.created", driver, appThread },
    });
  return { orchestrator, projections, threadId, child, lifecycle, ingest };
});

it.layer(layerTest)("subagent creation lifecycle", (it) => {
  it.effect.each(["active", "archived", "deleted", "archived-deleted", "restored"] as const)(
    "inherits persisted %s parent state while keeping forks independent",
    (state) =>
      Effect.gen(function* () {
        const f = yield* fixture(state);
        if (state !== "active" && state !== "deleted") yield* f.lifecycle("thread.archive");
        if (state === "deleted" || state === "archived-deleted")
          yield* f.lifecycle("thread.delete");
        if (state === "restored") yield* f.lifecycle("thread.unarchive");
        const parent = yield* f.projections.getThread(f.threadId);
        const stale = DateTime.makeUnsafe("2020-01-01T00:00:00Z");
        const offered = { ...f.child, archivedAt: stale };
        yield* f.ingest(offered);
        const child = yield* f.projections.getThread(offered.id);
        assert.deepEqual(child.archivedAt, parent.archivedAt);
        assert.deepEqual(child.deletedAt, parent.deletedAt);
        const fork = {
          ...offered,
          id: ThreadId.make(`fork:${state}`),
          lineage: { ...offered.lineage, relationshipToParent: "fork" as const },
        };
        yield* f.ingest(fork);
        const savedFork = yield* f.projections.getThread(fork.id);
        assert.deepEqual(savedFork.archivedAt, stale);
        assert.isNull(savedFork.deletedAt);
        // Native replays may refresh metadata, but must preserve the saved child's lifecycle.
        if (state === "archived") yield* f.lifecycle("thread.unarchive");
        yield* f.ingest({ ...offered, title: "Refreshed", deletedAt: stale });
        const refreshed = yield* f.projections.getThread(offered.id);
        assert.equal(refreshed.title, "Refreshed");
        assert.deepEqual(refreshed.archivedAt, child.archivedAt);
        assert.deepEqual(refreshed.deletedAt, child.deletedAt);
        assert.isEmpty(yield* f.ingest({ ...offered, title: "Refreshed" }));
        const deletedChild = {
          ...offered,
          id: ThreadId.make(`deleted-child:${state}`),
          deletedAt: stale,
        };
        yield* f.ingest(deletedChild);
        assert.deepEqual((yield* f.projections.getThread(deletedChild.id)).deletedAt, stale);
      }),
  );

  it.effect.each(["thread.archive", "thread.delete"] as const)(
    "serializes native creation behind an ordinary %s command",
    (operation) =>
      Effect.gen(function* () {
        const f = yield* fixture(`race:${operation}`);
        const sink = yield* EventSink.EventSinkV2;
        const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const ready = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const creationLock = yield* Deferred.make<ThreadId>();
        const commit = sink.commitCommand;
        const lock = executor.withLock;
        const commitSpy = vi
          .spyOn(sink, "commitCommand")
          .mockImplementation((input) =>
            input.commandType === operation
              ? Deferred.succeed(ready, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(commit(input)),
                )
              : commit(input),
          );
        yield* Effect.gen(function* () {
          const parentFiber = yield* f
            .lifecycle(operation)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(ready);
          const observe: typeof executor.withLock = (key, effect) =>
            Deferred.succeed(creationLock, key).pipe(Effect.andThen(lock(key, effect)));
          const lockSpy = vi.spyOn(executor, "withLock").mockImplementation(observe);
          yield* Effect.gen(function* () {
            const childFiber = yield* f.ingest().pipe(Effect.forkChild({ startImmediately: true }));
            const firstLock = yield* Deferred.await(creationLock);
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(parentFiber);
            yield* Fiber.join(childFiber);
            assert.equal(firstLock, f.threadId);
            const parent = yield* f.projections.getThread(f.threadId);
            const child = yield* f.projections.getThread(f.child.id);
            assert.deepEqual(child.archivedAt, parent.archivedAt);
            assert.deepEqual(child.deletedAt, parent.deletedAt);
          }).pipe(Effect.ensuring(Effect.sync(() => lockSpy.mockRestore())));
        }).pipe(Effect.ensuring(Effect.sync(() => commitSpy.mockRestore())));
      }),
  );

  it.effect.each(["thread.archive", "thread.delete"] as const)(
    "rejects fresh delegation after %s and preserves command receipts",
    (operation) =>
      Effect.gen(function* () {
        const f = yield* fixture(`delegate:${operation}`);
        yield* f.orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`message:${operation}`),
          threadId: f.threadId,
          messageId: MessageId.make(`message:${operation}`),
          text: "Delegate work",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const run = (yield* f.projections.getThreadRecords(f.threadId, ["runs"])).runs[0]!;
        const command = {
          type: "delegated_task.request" as const,
          commandId: CommandId.make(`delegate:${operation}`),
          parentThreadId: f.threadId,
          parentRunId: run.id,
          parentNodeId: run.rootNodeId!,
          task: "Inspect the project",
          modelSelection,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          createdBy: "agent" as const,
          creationSource: "mcp" as const,
        };
        const accepted = yield* f.orchestrator.dispatch(command);
        yield* f.lifecycle(operation);
        const replayed = yield* f.orchestrator.dispatch(command);
        assert.equal(replayed.sequence, accepted.sequence);
        assert.deepEqual(
          replayed.storedEvents.map((e) => e.event.id),
          accepted.storedEvents.map((e) => e.event.id),
        );
        const rejected = { ...command, commandId: CommandId.make(`rejected:${operation}`) };
        const error = yield* f.orchestrator.dispatch(rejected).pipe(Effect.flip);
        assert.equal(error._tag, "OrchestratorDispatchError");
        assert.equal(
          error.cause,
          `Parent thread ${f.threadId} is ${operation === "thread.delete" ? "deleted" : "archived"}.`,
        );
        if (operation === "thread.archive") yield* f.lifecycle("thread.unarchive");
        const replay = yield* f.orchestrator.dispatch(rejected).pipe(Effect.flip);
        assert.equal(replay._tag, "OrchestratorCommandPreviouslyRejectedError");
        const parent = yield* f.projections.getThreadRecords(f.threadId, ["subagents"]);
        assert.lengthOf(parent.subagents, 1);
        if (operation === "thread.archive") {
          yield* f.orchestrator.dispatch({
            ...command,
            commandId: CommandId.make("restored-delegation"),
          });
          assert.lengthOf(
            (yield* f.projections.getThreadRecords(f.threadId, ["subagents"])).subagents,
            2,
          );
        }
      }),
  );
});
