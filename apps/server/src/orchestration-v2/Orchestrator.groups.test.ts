import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for group metadata"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "groups" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const projectId = ProjectId.make("project:groups");

const harness = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const threadId = (name: string) => ThreadId.make(`thread:groups-${name}`);
  const create = (name: string, groupParentThreadId?: ThreadId) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-${name}`),
      threadId: threadId(name),
      projectId,
      title: name,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      ...(groupParentThreadId === undefined ? {} : { groupParentThreadId }),
    });
  const attach = (name: string, parent: ThreadId, orderKey?: string) =>
    orchestrator.dispatch({
      type: "thread.group.attach",
      commandId: CommandId.make(`attach-${name}-to-${parent}-${orderKey ?? "end"}`),
      threadId: threadId(name),
      parentThreadId: parent,
      ...(orderKey === undefined ? {} : { orderKey }),
    });
  const detach = (name: string, attempt = 1) =>
    orchestrator.dispatch({
      type: "thread.group.detach",
      commandId: CommandId.make(`detach-${name}-${attempt}`),
      threadId: threadId(name),
    });
  const group = (name: string) =>
    projections.getThreadShell(threadId(name)).pipe(
      Effect.map((shell) => ({
        parent: shell?.groupParentThreadId ?? null,
        orderKey: shell?.groupOrderKey ?? null,
        launchedBy: shell?.groupLaunchedByThreadId ?? null,
      })),
    );
  const eventTypes = (result: {
    readonly storedEvents: ReadonlyArray<{ event: { type: string } }>;
  }) => result.storedEvents.map((stored) => stored.event.type);
  return {
    orchestrator,
    projections,
    eventSink,
    threadId,
    create,
    attach,
    detach,
    group,
    eventTypes,
  };
});

it.effect("attach sets parent and appends order", () =>
  Effect.gen(function* () {
    const { threadId, create, attach, group } = yield* harness;
    yield* create("p");
    yield* create("a");
    yield* create("b");
    yield* attach("a", threadId("p"));
    yield* attach("b", threadId("p"));
    const a = yield* group("a");
    const b = yield* group("b");
    assert.equal(a.parent, threadId("p"));
    assert.equal(b.parent, threadId("p"));
    assert.ok(a.orderKey !== null && b.orderKey !== null && b.orderKey > a.orderKey);
    assert.isNull(a.launchedBy);
    assert.deepEqual(yield* group("p"), { parent: null, orderKey: null, launchedBy: null });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("attach to a worker flattens to its parent", () =>
  Effect.gen(function* () {
    const { threadId, create, attach, group } = yield* harness;
    yield* create("p");
    yield* create("w");
    yield* create("x");
    yield* attach("w", threadId("p"));
    yield* attach("x", threadId("w"));
    assert.equal((yield* group("x")).parent, threadId("p"));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("attaching a parent moves its workers", () =>
  Effect.gen(function* () {
    const { threadId, create, attach, group, eventTypes } = yield* harness;
    yield* create("p");
    yield* create("w");
    yield* create("q");
    yield* attach("w", threadId("p"));
    const moved = yield* attach("p", threadId("q"));
    assert.deepEqual(eventTypes(moved), ["thread.group-attached", "thread.group-attached"]);
    const p = yield* group("p");
    const w = yield* group("w");
    assert.equal(p.parent, threadId("q"));
    assert.equal(w.parent, threadId("q"));
    assert.ok(p.orderKey !== null && w.orderKey !== null && w.orderKey > p.orderKey);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("attach rejects self, subagent and missing parent", () =>
  Effect.gen(function* () {
    const { orchestrator, projections, eventSink, threadId, create, attach, group } =
      yield* harness;
    yield* create("p");
    yield* create("sub");
    const subagent = yield* projections.getThread(threadId("sub"));
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("event:groups-sub-lineage"),
          type: "thread.metadata-updated",
          threadId: subagent.id,
          occurredAt: subagent.updatedAt,
          payload: {
            ...subagent,
            lineage: {
              parentThreadId: threadId("p"),
              relationshipToParent: "subagent",
              rootThreadId: threadId("p"),
            },
          },
        },
      ],
    });
    const before = yield* orchestrator.getThreadEventSequence(threadId("p"));
    const outcomes = [
      yield* Effect.result(attach("p", threadId("p"))),
      yield* Effect.result(attach("sub", threadId("p"))),
      yield* Effect.result(attach("p", threadId("sub"))),
      yield* Effect.result(attach("p", threadId("missing"))),
    ];
    assert.ok(outcomes.every(Result.isFailure));
    assert.equal(yield* orchestrator.getThreadEventSequence(threadId("p")), before);
    assert.deepEqual(yield* group("p"), { parent: null, orderKey: null, launchedBy: null });
    assert.deepEqual(yield* group("sub"), { parent: null, orderKey: null, launchedBy: null });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("attach to a worker of an archived lead joins that lead", () =>
  Effect.gen(function* () {
    const { orchestrator, threadId, create, attach, group } = yield* harness;
    yield* create("p");
    yield* create("w");
    yield* create("x");
    yield* attach("w", threadId("p"));
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive-p"),
      threadId: threadId("p"),
    });
    yield* attach("x", threadId("w"));
    assert.equal((yield* group("x")).parent, threadId("p"));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("attach to a worker whose lead is deleted makes the worker the parent", () =>
  Effect.gen(function* () {
    const { orchestrator, projections, eventSink, threadId, create, attach, group } =
      yield* harness;
    yield* create("p");
    yield* create("w");
    yield* create("x");
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete-p"),
      threadId: threadId("p"),
    });
    // Deleting a lead detaches its workers; a stale membership still has to resolve safely.
    const worker = yield* projections.getThread(threadId("w"));
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("event:groups-w-stale-membership"),
          type: "thread.metadata-updated",
          threadId: worker.id,
          occurredAt: worker.updatedAt,
          payload: { ...worker, groupParentThreadId: threadId("p"), groupOrderKey: "n" },
        },
      ],
    });
    yield* attach("x", threadId("w"));
    assert.equal((yield* group("x")).parent, threadId("w"));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("attach rejects an invalid order key", () =>
  Effect.gen(function* () {
    const { orchestrator, threadId, create, attach, group } = yield* harness;
    yield* create("p");
    yield* create("w");
    const before = yield* orchestrator.getThreadEventSequence(threadId("w"));
    const outcomes = [
      yield* Effect.result(attach("w", threadId("p"), "A")),
      yield* Effect.result(attach("w", threadId("p"), "a")),
    ];
    assert.ok(outcomes.every(Result.isFailure));
    assert.equal(yield* orchestrator.getThreadEventSequence(threadId("w")), before);
    assert.deepEqual(yield* group("w"), { parent: null, orderKey: null, launchedBy: null });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reorder rejects an invalid order key", () =>
  Effect.gen(function* () {
    const { orchestrator, threadId, create, attach, group } = yield* harness;
    yield* create("p");
    yield* create("w");
    yield* attach("w", threadId("p"), "n");
    const before = yield* orchestrator.getThreadEventSequence(threadId("w"));
    const reorder = (orderKey: string) =>
      Effect.result(
        orchestrator.dispatch({
          type: "thread.group.reorder",
          commandId: CommandId.make(`reorder-w-${orderKey}`),
          threadId: threadId("w"),
          orderKey,
        }),
      );
    assert.ok(Result.isFailure(yield* reorder("A")));
    assert.ok(Result.isFailure(yield* reorder("a")));
    assert.equal(yield* orchestrator.getThreadEventSequence(threadId("w")), before);
    assert.equal((yield* group("w")).orderKey, "n");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("detach clears membership; detaching a non-member is a no-op", () =>
  Effect.gen(function* () {
    const { threadId, create, attach, detach, group, eventTypes } = yield* harness;
    yield* create("p");
    yield* create("w");
    assert.deepEqual(eventTypes(yield* detach("w")), []);
    yield* attach("w", threadId("p"));
    assert.deepEqual(eventTypes(yield* attach("w", threadId("p"), "zz")), []);
    assert.deepEqual(eventTypes(yield* detach("w", 2)), ["thread.group-detached"]);
    assert.deepEqual(yield* group("w"), { parent: null, orderKey: null, launchedBy: null });
    assert.deepEqual(eventTypes(yield* detach("w", 3)), []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("delete detaches members", () =>
  Effect.gen(function* () {
    const { orchestrator, threadId, create, attach, group, eventTypes } = yield* harness;
    yield* create("p");
    yield* create("w");
    yield* attach("w", threadId("p"));
    const deleted = yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete-p"),
      threadId: threadId("p"),
    });
    assert.include(eventTypes(deleted), "thread.group-detached");
    assert.include(eventTypes(deleted), "thread.deleted");
    assert.deepEqual(yield* group("w"), { parent: null, orderKey: null, launchedBy: null });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("archive keeps membership", () =>
  Effect.gen(function* () {
    const { orchestrator, threadId, create, attach, group } = yield* harness;
    yield* create("p");
    yield* create("w");
    yield* attach("w", threadId("p"));
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive-p"),
      threadId: threadId("p"),
    });
    assert.equal((yield* group("w")).parent, threadId("p"));
    yield* orchestrator.dispatch({
      type: "thread.unarchive",
      commandId: CommandId.make("unarchive-p"),
      threadId: threadId("p"),
    });
    assert.equal((yield* group("w")).parent, threadId("p"));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("create under a worker flattens to its parent", () =>
  Effect.gen(function* () {
    const { threadId, create, attach, group, eventTypes } = yield* harness;
    yield* create("p");
    yield* create("w");
    yield* attach("w", threadId("p"));
    const created = yield* create("n", threadId("w"));
    assert.include(eventTypes(created), "thread.group-attached");
    const n = yield* group("n");
    const w = yield* group("w");
    assert.equal(n.parent, threadId("p"));
    assert.equal(n.launchedBy, threadId("w"));
    assert.ok(n.orderKey !== null && w.orderKey !== null && n.orderKey > w.orderKey);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("create with an invalid group parent still creates the thread", () =>
  Effect.gen(function* () {
    const { projections, threadId, create, group } = yield* harness;
    yield* create("n", threadId("missing"));
    assert.equal((yield* projections.getThreadShell(threadId("n")))?.id, threadId("n"));
    assert.deepEqual(yield* group("n"), { parent: null, orderKey: null, launchedBy: null });
  }).pipe(Effect.provide(layerTest)),
);
