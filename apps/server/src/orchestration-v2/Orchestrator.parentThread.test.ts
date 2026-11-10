import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as McpGatewayBroker from "../mcp/McpGatewayBroker.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectionStoreV2, layer as projectionLayer } from "./ProjectionStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeSubagentChildThread } from "@t3tools/provider-core/server/subagentProjection";
import * as RemoteParentSettlement from "./RemoteParentSettlement.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for thread parents"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = Sqlite.layerMemory;
/** Runs what the commands so far left in the outbox, settlement cascades among them. */
const drainEffects = Effect.gen(function* () {
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  yield* worker.drain();
});
const testLayer = Layer.mergeAll(
  database,
  projectionLayer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "parent-thread" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

/**
 * The turn items a finished run leaves open. The effect worker is off in these
 * tests, so workspace preparation never completes on its own; a real run
 * cannot complete before it does.
 */
const finishOpenTurnItems = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const now = yield* DateTime.now;
    const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"]);
    return turnItems
      .filter((item) => item.status === "running" || item.status === "pending")
      .map((item) => ({
        id: EventId.make(`event:finish:${item.id}`),
        type: "turn-item.updated" as const,
        threadId,
        ...(item.runId === null ? {} : { runId: item.runId }),
        providerInstanceId: instanceId,
        occurredAt: now,
        payload: { ...item, status: "completed" as const, completedAt: now, updatedAt: now },
      }));
  });

it.effect("links chats under a parent, rejects cycles and missing parents, and detaches", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* ProjectionStoreV2;
    const create = (id: string, parentThreadId?: string) =>
      orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${id}`),
        threadId: ThreadId.make(id),
        projectId: ProjectId.make("project:parents"),
        title: id,
        modelSelection: { instanceId, model: "gpt-5.1-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "agent",
        creationSource: "mcp",
        ...(parentThreadId === undefined ? {} : { parentThreadId: ThreadId.make(parentThreadId) }),
      });
    const setParent = (id: string, parentThreadId: string | null) =>
      orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`parent:${id}:${parentThreadId}`),
        threadId: ThreadId.make(id),
        parentThreadId: parentThreadId === null ? null : ThreadId.make(parentThreadId),
      });
    const parentOf = (id: string) =>
      projections
        .getThreadShell(ThreadId.make(id))
        .pipe(Effect.map((shell) => shell?.parentThreadId ?? null));

    yield* create("coordinator");
    yield* create("tests", "coordinator");
    yield* create("deps", "tests");
    assert.equal(yield* parentOf("deps"), "tests");

    const missing = yield* create("orphan", "nowhere").pipe(Effect.flip);
    assert.include(String(missing.cause), "Parent chat nowhere does not exist");
    const cycle = yield* setParent("coordinator", "deps").pipe(Effect.flip);
    assert.include(String(cycle.cause), "cannot move under one of its own sub-runs");
    assert.isNull(yield* parentOf("coordinator"));

    yield* setParent("deps", "coordinator");
    assert.equal(yield* parentOf("deps"), "coordinator");
    yield* setParent("deps", null);
    assert.isNull(yield* parentOf("deps"));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("set, re-parent, and clear are atomic and idempotent; rejected moves write nothing", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* ProjectionStoreV2;
    const sink = yield* EventSinkV2;
    const create = (id: string) =>
      orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${id}`),
        threadId: ThreadId.make(id),
        projectId: ProjectId.make("project:parents"),
        title: id,
        modelSelection: { instanceId, model: "gpt-5.1-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    let attempt = 0;
    const setParent = (id: string, parentThreadId: string | null) =>
      orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`parent:${id}:${parentThreadId}:${(attempt += 1)}`),
        threadId: ThreadId.make(id),
        parentThreadId: parentThreadId === null ? null : ThreadId.make(parentThreadId),
      });
    const shell = (id: string) =>
      projections.getThread(ThreadId.make(id)).pipe(
        Effect.map((thread) => ({
          parentThreadId: thread.parentThreadId ?? null,
          parentEnvironmentId: thread.parentEnvironmentId ?? null,
          updatedAt: thread.updatedAt,
        })),
      );
    const sequenceOf = (id: string) => orchestrator.getThreadEventSequence(ThreadId.make(id));
    // A rejected move persists no event and leaves the link as it was.
    const rejects = (id: string, parentThreadId: string | null, message: string) =>
      Effect.gen(function* () {
        const before = yield* shell(id);
        const sequence = yield* sequenceOf(id);
        const error = yield* setParent(id, parentThreadId).pipe(Effect.flip);
        assert.include(String(error.cause), message);
        assert.deepEqual(yield* shell(id), before);
        assert.equal(yield* sequenceOf(id), sequence);
      });

    yield* create("github-chat");
    yield* create("other-chat");
    yield* create("glm-chat");
    const created = yield* shell("glm-chat");
    yield* TestClock.adjust("1 minute");

    // Set: one event carries the whole link; nesting is not chat activity.
    yield* setParent("glm-chat", "github-chat");
    assert.deepEqual(yield* shell("glm-chat"), {
      ...created,
      parentThreadId: ThreadId.make("github-chat"),
    });
    // Idempotent: repeating the move leaves the same state.
    yield* setParent("glm-chat", "github-chat");
    assert.deepEqual(yield* shell("glm-chat"), {
      ...created,
      parentThreadId: ThreadId.make("github-chat"),
    });
    // Re-parent, then clear, then clear again.
    yield* setParent("glm-chat", "other-chat");
    assert.equal((yield* shell("glm-chat")).parentThreadId, "other-chat");
    yield* setParent("glm-chat", null);
    yield* setParent("glm-chat", null);
    assert.deepEqual(yield* shell("glm-chat"), created);

    yield* setParent("glm-chat", "github-chat");
    yield* rejects("glm-chat", "glm-chat", "A chat cannot be its own parent");
    yield* rejects("github-chat", "glm-chat", "cannot move under one of its own sub-runs");
    yield* rejects("glm-chat", "ghost", "Parent chat ghost does not exist");
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive:other-chat"),
      threadId: ThreadId.make("other-chat"),
    });
    yield* rejects("glm-chat", "other-chat", "Parent chat other-chat is archived");

    // A delegated subagent stays with the chat that delegated it.
    const delegator = yield* projections.getThread(ThreadId.make("github-chat"));
    const subagent = yield* projections.getThread(ThreadId.make("glm-chat"));
    const now = yield* DateTime.now;
    yield* create("subagent-chat");
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:make-subagent"),
          type: "thread.metadata-updated",
          threadId: ThreadId.make("subagent-chat"),
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            ...(yield* projections.getThread(ThreadId.make("subagent-chat"))),
            parentThreadId: delegator.id,
            lineage: {
              parentThreadId: delegator.id,
              relationshipToParent: "subagent",
              rootThreadId: delegator.id,
            },
          },
        },
      ],
    });
    assert.equal(subagent.lineage.relationshipToParent, null);
    yield* rejects("subagent-chat", null, "only child chats can move");
    yield* rejects("subagent-chat", "glm-chat", "only child chats can move");
    // Re-stating its own parent is still a no-op success.
    yield* setParent("subagent-chat", "github-chat");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("deleting a parent detaches its sub-runs, and startup repair heals broken links", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* ProjectionStoreV2;
    const sink = yield* EventSinkV2;
    const create = (id: string, parentThreadId?: string) =>
      orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${id}`),
        threadId: ThreadId.make(id),
        projectId: ProjectId.make("project:parents"),
        title: id,
        modelSelection: { instanceId, model: "gpt-5.1-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
        ...(parentThreadId === undefined ? {} : { parentThreadId: ThreadId.make(parentThreadId) }),
      });
    const parentOf = (id: string) =>
      projections
        .getThread(ThreadId.make(id))
        .pipe(Effect.map((thread) => thread.parentThreadId ?? null));
    // Writes a link directly, as data left behind by an older server would be.
    const corrupt = (id: string, parentThreadId: string) =>
      Effect.gen(function* () {
        const thread = yield* projections.getThread(ThreadId.make(id));
        yield* sink.write({
          events: [
            {
              id: EventId.make(`event:corrupt:${id}`),
              type: "thread.metadata-updated",
              threadId: thread.id,
              providerInstanceId: instanceId,
              occurredAt: yield* DateTime.now,
              payload: { ...thread, parentThreadId: ThreadId.make(parentThreadId) },
            },
          ],
        });
      });

    yield* create("doomed");
    yield* create("left-behind", "doomed");
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete:doomed"),
      threadId: ThreadId.make("doomed"),
    });
    assert.isNull(yield* parentOf("left-behind"));

    yield* create("healthy-parent");
    yield* create("healthy-child", "healthy-parent");
    yield* create("dangling");
    yield* corrupt("dangling", "gone-thread");
    yield* create("selfie");
    yield* corrupt("selfie", "selfie");
    yield* create("loop-a");
    yield* create("loop-b", "loop-a");
    yield* corrupt("loop-a", "loop-b");

    assert.deepEqual(yield* orchestrator.repairThreadParents, [
      ThreadId.make("dangling"),
      ThreadId.make("loop-a"),
      ThreadId.make("selfie"),
    ]);
    assert.isNull(yield* parentOf("dangling"));
    assert.isNull(yield* parentOf("selfie"));
    assert.isNull(yield* parentOf("loop-a"));
    assert.equal(yield* parentOf("loop-b"), "loop-a");
    assert.equal(yield* parentOf("healthy-child"), "healthy-parent");
    // A second pass finds nothing left to heal.
    assert.deepEqual(yield* orchestrator.repairThreadParents, []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("links chats under a parent on another environment and clears it on relink", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* ProjectionStoreV2;
    const remote = EnvironmentId.make("environment-pc");
    const linkOf = (id: string) =>
      projections.getThreadShell(ThreadId.make(id)).pipe(
        Effect.map((shell) => ({
          parentThreadId: shell?.parentThreadId ?? null,
          parentEnvironmentId: shell?.parentEnvironmentId ?? null,
        })),
      );
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create:remote-child"),
      threadId: ThreadId.make("remote-child"),
      projectId: ProjectId.make("project:parents"),
      title: "remote-child",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "agent",
      creationSource: "mcp",
      // The coordinating chat lives on the other machine, so this server cannot look it up.
      parentThreadId: ThreadId.make("pc-coordinator"),
      parentEnvironmentId: remote,
    });
    assert.deepEqual(yield* linkOf("remote-child"), {
      parentThreadId: ThreadId.make("pc-coordinator"),
      parentEnvironmentId: remote,
    });

    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create:local-parent"),
      threadId: ThreadId.make("local-parent"),
      projectId: ProjectId.make("project:parents"),
      title: "local-parent",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("relink:remote-child"),
      threadId: ThreadId.make("remote-child"),
      parentThreadId: ThreadId.make("local-parent"),
    });
    assert.deepEqual(yield* linkOf("remote-child"), {
      parentThreadId: ThreadId.make("local-parent"),
      parentEnvironmentId: null,
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "settling a chat settles idle sub-runs at every depth; unsettling returns only those",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const projections = yield* ProjectionStoreV2;
      const create = (id: string, parentThreadId?: string) =>
        orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${id}`),
          threadId: ThreadId.make(id),
          projectId: ProjectId.make("project:parents"),
          title: id,
          modelSelection: { instanceId, model: "gpt-5.1-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "agent",
          creationSource: "mcp",
          ...(parentThreadId === undefined
            ? {}
            : { parentThreadId: ThreadId.make(parentThreadId) }),
        });
      const settledAt = (id: string) =>
        projections.getThread(ThreadId.make(id)).pipe(Effect.map((thread) => thread.settledAt));

      yield* create("lead");
      yield* create("worker", "lead");
      yield* create("helper", "worker");
      yield* create("earlier", "lead");
      yield* threads.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle:earlier"),
        threadId: ThreadId.make("earlier"),
      });
      yield* drainEffects;
      const earlierAt = yield* settledAt("earlier");
      yield* TestClock.adjust("1 minute");

      yield* threads.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle:lead"),
        threadId: ThreadId.make("lead"),
      });
      yield* drainEffects;
      const leadAt = yield* settledAt("lead");
      assert.isNotNull(leadAt);
      assert.deepEqual(yield* settledAt("worker"), leadAt);
      assert.deepEqual(yield* settledAt("helper"), leadAt);
      assert.deepEqual(yield* settledAt("earlier"), earlierAt);

      yield* threads.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("unsettle:lead"),
        threadId: ThreadId.make("lead"),
        reason: "user",
      });
      yield* drainEffects;
      assert.isNull(yield* settledAt("lead"));
      assert.isNull(yield* settledAt("worker"));
      assert.isNull(yield* settledAt("helper"));
      assert.deepEqual(yield* settledAt("earlier"), earlierAt);
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          ThreadManagement.layer.pipe(
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
          ),
          testLayer,
        ),
      ),
    ),
);

it.effect(
  "settling a Captain settles its named child and grandchild ahead of its subagent listeners",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const projections = yield* ProjectionStoreV2;
      const sink = yield* EventSinkV2;
      const create = (id: string, parentThreadId?: string) =>
        orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${id}`),
          threadId: ThreadId.make(id),
          projectId: ProjectId.make("project:parents"),
          title: id,
          modelSelection: { instanceId, model: "gpt-5.1-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "agent",
          creationSource: "mcp",
          ...(parentThreadId === undefined
            ? {}
            : { parentThreadId: ThreadId.make(parentThreadId) }),
        });

      yield* create("captain");
      // A Captain's delegate_task listeners pile up under it long before most of its children.
      const listeners = ["listen:1", "listen:2", "listen:3"];
      for (const id of listeners) {
        yield* create(id, "captain");
        yield* orchestrator.dispatch({
          type: "thread.parent-link.repair",
          commandId: CommandId.make(`subagent:${id}`),
          threadId: ThreadId.make(id),
          parentThreadId: ThreadId.make("captain"),
          parentRelationship: "subagent",
        });
      }
      yield* create("mcp:named-child", "captain");
      yield* create("mcp:grandchild", "mcp:named-child");

      const before = yield* sink.latestSequence();
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle:captain"),
        threadId: ThreadId.make("captain"),
      });
      yield* drainEffects;
      const settled = Array.from(
        yield* sink
          .stream({ afterSequence: before, eventType: "thread.settled" })
          .pipe(Stream.take(6), Stream.runCollect),
        (stored) => stored.event.threadId,
      );
      assert.deepEqual(settled.slice(0, 3), ["captain", "mcp:named-child", "mcp:grandchild"]);
      assert.sameMembers(settled.slice(3), listeners);
      const captainAt = (yield* projections.getThread(ThreadId.make("captain"))).settledAt;
      for (const id of [...listeners, "mcp:named-child", "mcp:grandchild"]) {
        assert.deepEqual((yield* projections.getThread(ThreadId.make(id))).settledAt, captainAt);
      }
    }).pipe(Effect.provide(testLayer)),
);
it("a sub-run nests under the chat that spawned it, not that chat's parent", () => {
  const now = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
  const parentThread = {
    id: ThreadId.make("spawner"),
    parentThreadId: ThreadId.make("spawner-parent"),
    parentEnvironmentId: EnvironmentId.make("environment-pc"),
    pinnedAt: now,
    autoSettleDisabledAt: now,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "spawner" },
  } as unknown as OrchestrationV2AppThread;
  const child = makeSubagentChildThread({
    parentThread,
    childThreadId: ThreadId.make("sub-run"),
    parentNodeId: NodeId.make("task"),
    activeProviderThreadId: null,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    title: "sub-run",
    now,
    createdBy: "agent",
    creationSource: "mcp",
  });
  assert.equal(child.parentThreadId, "spawner");
  assert.isNull(child.parentEnvironmentId);
  assert.isNull(child.pinnedAt);
  assert.isNull(child.autoSettleDisabledAt);
});

it.effect("Agent child chats and delegated subagents stay unsettled on completion and reuse", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* ProjectionStoreV2;
    const sink = yield* EventSinkV2;
    const create = (id: string, parentThreadId?: string) =>
      orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${id}`),
        threadId: ThreadId.make(id),
        projectId: ProjectId.make("project:parents"),
        title: id,
        modelSelection: { instanceId, model: "gpt-5.1-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "agent",
        creationSource: "mcp",
        ...(parentThreadId === undefined ? {} : { parentThreadId: ThreadId.make(parentThreadId) }),
      });
    // Reusing a child chat or delegated subagent starts a new run in that thread.
    const send = (id: string, turn: number) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`send:${id}:${turn}`),
        threadId: ThreadId.make(id),
        messageId: MessageId.make(`message:${id}:${turn}`),
        text: `Task ${turn}`,
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "agent",
        creationSource: "mcp",
      });
    const completeLatestRun = (id: string) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(id);
        const run = (yield* projections.getThreadRecords(threadId, ["runs"])).runs.at(-1)!;
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            ...(yield* finishOpenTurnItems(threadId)),
            {
              id: EventId.make(`event:complete:${run.id}`),
              type: "run.updated",
              threadId,
              runId: run.id,
              ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: { ...run, status: "completed", completedAt: now },
            },
          ],
        });
      });
    const settledOverride = (id: string) =>
      projections.getThread(ThreadId.make(id)).pipe(Effect.map((thread) => thread.settledOverride));

    yield* create("orchestrator");
    yield* create("sub-run", "orchestrator");
    yield* create("delegated", "orchestrator");
    const delegated = yield* projections.getThread(ThreadId.make("delegated"));
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:delegated-lineage"),
          type: "thread.metadata-updated",
          threadId: delegated.id,
          occurredAt: delegated.updatedAt,
          payload: {
            ...delegated,
            lineage: {
              ...delegated.lineage,
              parentThreadId: ThreadId.make("orchestrator"),
              relationshipToParent: "subagent",
            },
          },
        },
      ],
    });
    yield* send("orchestrator", 1);
    yield* send("sub-run", 1);

    yield* completeLatestRun("orchestrator");
    yield* completeLatestRun("sub-run");
    const receipt = yield* orchestrator.dispatch({
      type: "thread.sub-run.settle",
      commandId: CommandId.make("completion:1"),
      threadId: ThreadId.make("sub-run"),
    });
    assert.equal(receipt.storedEvents.length, 0);
    assert.isNull(yield* settledOverride("sub-run"));
    assert.isNull(yield* settledOverride("orchestrator"));

    yield* send("sub-run", 2);
    assert.isNull(yield* settledOverride("sub-run"));

    yield* completeLatestRun("sub-run");
    yield* orchestrator.dispatch({
      type: "thread.sub-run.settle",
      commandId: CommandId.make("completion:2"),
      threadId: ThreadId.make("sub-run"),
    });
    assert.isNull(yield* settledOverride("sub-run"));
    for (const turn of [1, 2]) {
      yield* send("delegated", turn);
      yield* completeLatestRun("delegated");
      const delegatedReceipt = yield* orchestrator.dispatch({
        type: "thread.sub-run.settle",
        commandId: CommandId.make(`completion:delegated:${turn}`),
        threadId: delegated.id,
      });
      assert.equal(delegatedReceipt.storedEvents.length, 0);
      assert.isNull(yield* settledOverride("delegated"));
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a sub-run whose turn ended with background work still open stays active", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* ProjectionStoreV2;
    const sink = yield* EventSinkV2;
    const create = (id: string, parentThreadId?: string) =>
      orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${id}`),
        threadId: ThreadId.make(id),
        projectId: ProjectId.make("project:parents"),
        title: id,
        modelSelection: { instanceId, model: "gpt-5.1-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "agent",
        creationSource: "mcp",
        ...(parentThreadId === undefined ? {} : { parentThreadId: ThreadId.make(parentThreadId) }),
      });
    yield* create("lead");
    yield* create("sleeper", "lead");
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("send:sleeper"),
      threadId: ThreadId.make("sleeper"),
      messageId: MessageId.make("message:sleeper"),
      text: "Run sleep 90 in the background",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "agent",
      creationSource: "mcp",
    });
    const threadId = ThreadId.make("sleeper");
    // A child only settles by following a manually settled parent; settling
    // the lead while the sleeper still works defers the sleeper's settle.
    yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("settle:lead"),
      threadId: ThreadId.make("lead"),
    });
    yield* drainEffects;
    assert.isNull((yield* projections.getThread(threadId)).settledOverride);
    const run = (yield* projections.getThreadRecords(threadId, ["runs"])).runs.at(-1)!;
    const now = yield* DateTime.now;
    const command = (status: "running" | "completed") => ({
      id: EventId.make(`event:sleep:${status}`),
      type: "turn-item.updated" as const,
      threadId,
      runId: run.id,
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("item:sleep"),
        threadId,
        runId: run.id,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status,
        title: "sleep 90",
        startedAt: now,
        completedAt: status === "completed" ? now : null,
        updatedAt: now,
        type: "command_execution" as const,
        input: "sleep 90",
      },
    });
    // The turn ends while the command it started keeps running.
    yield* sink.write({
      events: [
        ...(yield* finishOpenTurnItems(threadId)),
        command("running"),
        {
          id: EventId.make(`event:complete:${run.id}`),
          type: "run.updated",
          threadId,
          runId: run.id,
          ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: { ...run, status: "completed", completedAt: now },
        },
      ],
    });
    const settle = (attempt: string) =>
      orchestrator.dispatch({
        type: "thread.sub-run.settle",
        commandId: CommandId.make(`settle:sleeper:${attempt}`),
        threadId,
      });
    const settledOverride = () =>
      projections.getThread(threadId).pipe(Effect.map((thread) => thread.settledOverride));
    assert.equal((yield* projections.getThreadShell(threadId))?.pendingBackgroundTasks?.length, 1);
    yield* settle("open");
    assert.isNull(yield* settledOverride());
    // Once the background work ends on its own, the finished child follows its settled parent.
    const before = yield* sink.latestSequence();
    yield* sink.write({ events: [command("completed")] });
    yield* sink.stream({ afterSequence: before, eventType: "thread.settled" }).pipe(
      Stream.filter((stored) => stored.event.threadId === threadId),
      Stream.runHead,
    );
    assert.equal(yield* settledOverride(), "settled");
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "a sub-run still working when its parent settles settles with the parent once its run completes",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const projections = yield* ProjectionStoreV2;
      const sink = yield* EventSinkV2;
      // User-linked sub-runs follow a settled parent too, not only agent-created ones.
      const create = (id: string, parentThreadId?: string) =>
        orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${id}`),
          threadId: ThreadId.make(id),
          projectId: ProjectId.make("project:parents"),
          title: id,
          modelSelection: { instanceId, model: "gpt-5.1-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
          ...(parentThreadId === undefined
            ? {}
            : { parentThreadId: ThreadId.make(parentThreadId) }),
        });
      const settledAt = (id: string) =>
        projections.getThread(ThreadId.make(id)).pipe(Effect.map((thread) => thread.settledAt));
      const waitForSettled = (id: string, afterSequence: number) =>
        sink.stream({ afterSequence, eventType: "thread.settled" }).pipe(
          Stream.filter((stored) => stored.event.threadId === id),
          Stream.runHead,
        );

      yield* create("card");
      yield* create("busy", "card");
      yield* create("busy-helper", "busy");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("send:busy"),
        threadId: ThreadId.make("busy"),
        messageId: MessageId.make("message:busy"),
        text: "Keep working",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });

      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle:card"),
        threadId: ThreadId.make("card"),
      });
      yield* drainEffects;
      const cardAt = yield* settledAt("card");
      assert.isNotNull(cardAt);
      // Settling never stops work: the busy sub-run and everything under it stay active.
      assert.isNull(yield* settledAt("busy"));
      assert.isNull(yield* settledAt("busy-helper"));

      yield* TestClock.adjust("1 minute");
      const before = yield* sink.latestSequence();
      const run = (yield* projections.getThreadRecords(ThreadId.make("busy"), ["runs"])).runs.at(
        -1,
      )!;
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          ...(yield* finishOpenTurnItems(ThreadId.make("busy"))),
          {
            id: EventId.make(`event:complete:${run.id}`),
            type: "run.updated",
            threadId: ThreadId.make("busy"),
            runId: run.id,
            ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: { ...run, status: "completed", completedAt: now },
          },
        ],
      });
      yield* waitForSettled("busy", before);
      yield* drainEffects;
      assert.deepEqual(yield* settledAt("busy"), cardAt);
      assert.deepEqual(yield* settledAt("busy-helper"), cardAt);

      // They settled with the card, so un-settling the card brings them back.
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("unsettle:card"),
        threadId: ThreadId.make("card"),
        reason: "user",
      });
      yield* drainEffects;
      assert.isNull(yield* settledAt("busy"));
      assert.isNull(yield* settledAt("busy-helper"));
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "settling reaches descendants under an already settled sub-run and follows them when they finish",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const projections = yield* ProjectionStoreV2;
      const sink = yield* EventSinkV2;
      const create = (id: string, parentThreadId?: string) =>
        orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${id}`),
          threadId: ThreadId.make(id),
          projectId: ProjectId.make("project:parents"),
          title: id,
          modelSelection: { instanceId, model: "gpt-5.1-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "agent",
          creationSource: "mcp",
          ...(parentThreadId === undefined
            ? {}
            : { parentThreadId: ThreadId.make(parentThreadId) }),
        });
      const settledAt = (id: string) =>
        projections.getThread(ThreadId.make(id)).pipe(Effect.map((thread) => thread.settledAt));

      yield* create("lead");
      yield* create("aged", "lead");
      yield* create("aged-idle", "aged");
      yield* create("aged-busy", "aged");
      // Age settlement never cascades, so the aged sub-run's own children stay active.
      const aged = yield* projections.getThread(ThreadId.make("aged"));
      yield* orchestrator.dispatch({
        type: "thread.auto-settle",
        commandId: CommandId.make("auto-settle:aged"),
        threadId: aged.id,
        snapshotAt: aged.updatedAt,
      });
      const agedAt = yield* settledAt("aged");
      assert.isNotNull(agedAt);
      assert.isNull(yield* settledAt("aged-idle"));
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("send:aged-busy"),
        threadId: ThreadId.make("aged-busy"),
        messageId: MessageId.make("message:aged-busy"),
        text: "Keep working",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "agent",
        creationSource: "mcp",
      });
      yield* TestClock.adjust("1 minute");

      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle:lead"),
        threadId: ThreadId.make("lead"),
      });
      yield* drainEffects;
      const leadAt = yield* settledAt("lead");
      assert.isNotNull(leadAt);
      assert.deepEqual(yield* settledAt("aged"), agedAt);
      assert.deepEqual(yield* settledAt("aged-idle"), leadAt);
      assert.isNull(yield* settledAt("aged-busy"));

      // The working grandchild follows the manual settle above its aged parent.
      const before = yield* sink.latestSequence();
      const run = (yield* projections.getThreadRecords(ThreadId.make("aged-busy"), [
        "runs",
      ])).runs.at(-1)!;
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          ...(yield* finishOpenTurnItems(ThreadId.make("aged-busy"))),
          {
            id: EventId.make(`event:complete:${run.id}`),
            type: "run.updated",
            threadId: ThreadId.make("aged-busy"),
            runId: run.id,
            ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: { ...run, status: "completed", completedAt: now },
          },
        ],
      });
      yield* sink.stream({ afterSequence: before, eventType: "thread.settled" }).pipe(
        Stream.filter((stored) => stored.event.threadId === "aged-busy"),
        Stream.runHead,
      );
      assert.deepEqual(yield* settledAt("aged-busy"), leadAt);

      // Un-settling the lead returns what settled with it; the aged card keeps its own clock.
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("unsettle:lead"),
        threadId: ThreadId.make("lead"),
        reason: "user",
      });
      yield* drainEffects;
      assert.deepEqual(yield* settledAt("aged"), agedAt);
      assert.isNull(yield* settledAt("aged-idle"));
      assert.isNull(yield* settledAt("aged-busy"));
    }).pipe(Effect.provide(testLayer)),
);

it.effect("a sub-run stopped after its parent settled follows the parent with its subtree", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* ProjectionStoreV2;
    const sink = yield* EventSinkV2;
    const create = (id: string, parentThreadId?: string) =>
      orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${id}`),
        threadId: ThreadId.make(id),
        projectId: ProjectId.make("project:parents"),
        title: id,
        modelSelection: { instanceId, model: "gpt-5.1-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
        ...(parentThreadId === undefined ? {} : { parentThreadId: ThreadId.make(parentThreadId) }),
      });
    const settledAt = (id: string) =>
      projections.getThread(ThreadId.make(id)).pipe(Effect.map((thread) => thread.settledAt));

    yield* create("card");
    yield* create("stopped", "card");
    yield* create("stopped-helper", "stopped");
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("send:stopped"),
      threadId: ThreadId.make("stopped"),
      messageId: MessageId.make("message:stopped"),
      text: "Keep working",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("settle:card"),
      threadId: ThreadId.make("card"),
    });
    yield* drainEffects;
    const cardAt = yield* settledAt("card");
    assert.isNull(yield* settledAt("stopped"));

    // The settle refusal tells the user to stop a working chat; stopping it finishes the cascade.
    const before = yield* sink.latestSequence();
    const run = (yield* projections.getThreadRecords(ThreadId.make("stopped"), ["runs"])).runs.at(
      -1,
    )!;
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        ...(yield* finishOpenTurnItems(ThreadId.make("stopped"))),
        {
          id: EventId.make(`event:interrupt:${run.id}`),
          type: "run.updated",
          threadId: ThreadId.make("stopped"),
          runId: run.id,
          ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: { ...run, status: "interrupted", completedAt: now },
        },
      ],
    });
    yield* sink.stream({ afterSequence: before, eventType: "thread.settled" }).pipe(
      Stream.filter((stored) => stored.event.threadId === "stopped"),
      Stream.runHead,
    );
    yield* drainEffects;
    assert.deepEqual(yield* settledAt("stopped"), cardAt);
    assert.deepEqual(yield* settledAt("stopped-helper"), cardAt);
  }).pipe(Effect.provide(testLayer)),
);

const pc = EnvironmentId.make("environment-pc");

/**
 * A connected app reaching `pc` that answers getThread from `threads`, and never answers for
 * one listed in `stalled`. Each call is recorded and announced on `asked`.
 */
const relayLayer = (input: {
  readonly threads: ReadonlyMap<string, Record<string, unknown>>;
  readonly asked: Array<string>;
  readonly onAsk?: (threadId: string) => Effect.Effect<void>;
}) =>
  Layer.effect(
    McpGatewayBroker.McpGatewayBroker,
    Effect.gen(function* () {
      const broker = yield* McpGatewayBroker.make;
      yield* broker.connect("desktop", { [pc]: ["read"] }).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const threadId = String(event.args[1]);
            input.asked.push(`${String(event.args[0])}:${threadId}`);
            yield* input.onAsk?.(threadId) ?? Effect.void;
            const thread = input.threads.get(threadId);
            // A thread missing from the fixture is one whose app never answers.
            if (thread === undefined) return;
            yield* broker.respond("desktop", {
              connectionId: event.connectionId,
              invocationId: event.invocationId,
              result: thread,
            });
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      return broker;
    }),
  ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const withRemoteParents = (relay: ReturnType<typeof relayLayer>) =>
  RemoteParentSettlement.layer.pipe(Layer.provideMerge(testLayer), Layer.provideMerge(relay));

/** A card as its own machine's app reports it from getThread. */
const remoteCard = (id: string, fields: Record<string, unknown>) => ({
  id,
  projectId: "project:pc",
  title: id,
  modelSelection: { instanceId: "codex", model: "gpt-5.1-codex" },
  runs: [],
  messages: [],
  parentThreadId: null,
  ...fields,
});

const createUnder = (id: string, parent?: { threadId: string; environmentId?: EnvironmentId }) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${id}`),
      threadId: ThreadId.make(id),
      projectId: ProjectId.make("project:parents"),
      title: id,
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "agent",
      creationSource: "mcp",
      ...(parent === undefined ? {} : { parentThreadId: ThreadId.make(parent.threadId) }),
      ...(parent?.environmentId === undefined ? {} : { parentEnvironmentId: parent.environmentId }),
    });
  });

const sendTo = (
  id: string,
  text: string,
  dispatchMode: { readonly type: "defer_start" | "start_immediately" | "queue_after_active" },
) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${id}:${text}`),
      threadId: ThreadId.make(id),
      messageId: MessageId.make(`message:${id}:${text}`),
      text,
      attachments: [],
      dispatchMode,
      createdBy: "agent",
      creationSource: "mcp",
    });
  });

/** Completes the thread's run at `index` (the latest by default) as its provider would. */
const completeRun = (id: string, index = -1) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const sink = yield* EventSinkV2;
    const run = (yield* projections.getThreadRecords(ThreadId.make(id), ["runs"])).runs.at(index)!;
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        ...(yield* finishOpenTurnItems(ThreadId.make(id))),
        {
          id: EventId.make(`event:complete:${run.id}`),
          type: "run.updated",
          threadId: ThreadId.make(id),
          runId: run.id,
          ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: { ...run, status: "completed", completedAt: now },
        },
      ],
    });
    return run;
  });

it.effect(
  "a sub-run under a card on another machine follows that card's manual settle once it finishes",
  () => {
    const pcCardSettledAt = "2026-10-22T09:00:00.000Z";
    const asked: Array<string> = [];
    const oldCardAsked = Deferred.makeUnsafe<void>();
    const relay = relayLayer({
      threads: new Map([
        [
          "pc-card",
          remoteCard("pc-card", { settledAt: pcCardSettledAt, settlementSource: "manual" }),
        ],
        // An environment from before settlementSource was reported.
        ["pc-old-card", remoteCard("pc-old-card", { settledAt: pcCardSettledAt })],
      ]),
      asked,
      onAsk: (threadId) =>
        threadId === "pc-old-card" ? Deferred.succeed(oldCardAsked, undefined) : Effect.void,
    });
    return Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const projections = yield* ProjectionStoreV2;
      const sink = yield* EventSinkV2;
      const settledAt = (id: string) =>
        projections.getThread(ThreadId.make(id)).pipe(Effect.map((thread) => thread.settledAt));

      yield* createUnder("remote-worker", { threadId: "pc-card", environmentId: pc });
      yield* createUnder("remote-worker-helper", { threadId: "remote-worker" });
      yield* sendTo("remote-worker", "Keep working", { type: "defer_start" });
      const before = yield* sink.latestSequence();
      yield* completeRun("remote-worker");
      yield* sink.stream({ afterSequence: before, eventType: "thread.settled" }).pipe(
        Stream.filter((stored) => stored.event.threadId === "remote-worker"),
        Stream.runHead,
      );
      yield* drainEffects;
      // Settled at the card's time, so un-settling the card there brings both back.
      const cardAt = DateTime.makeUnsafe(pcCardSettledAt);
      assert.deepEqual(yield* settledAt("remote-worker"), cardAt);
      assert.deepEqual(yield* settledAt("remote-worker-helper"), cardAt);
      assert.deepEqual(asked, [`${pc}:pc-card`]);

      // A sub-run never settles on a remote parent's word unless the command carries it.
      yield* createUnder("old-env-worker", { threadId: "pc-old-card", environmentId: pc });
      const receipt = yield* orchestrator.dispatch({
        type: "thread.sub-run.settle",
        commandId: CommandId.make("settle:old-env-worker"),
        threadId: ThreadId.make("old-env-worker"),
      });
      assert.equal(receipt.storedEvents.length, 0);
      // An environment that cannot say how its card settled leaves the sub-run as before.
      yield* sendTo("old-env-worker", "Keep working", { type: "defer_start" });
      yield* completeRun("old-env-worker");
      yield* Deferred.await(oldCardAsked);
      assert.isNull(yield* settledAt("old-env-worker"));
    }).pipe(Effect.provide(withRemoteParents(relay)));
  },
);

it.effect("a relay that never answers holds up no other thread's run endings", () => {
  const asked: Array<string> = [];
  const stalledAsked = Deferred.makeUnsafe<void>();
  // pc-card is missing from the fixture, so its app takes the call and never answers.
  const relay = relayLayer({
    threads: new Map(),
    asked,
    onAsk: () => Deferred.succeed(stalledAsked, undefined),
  });
  return Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const sink = yield* EventSinkV2;

    yield* createUnder("stalled-worker", { threadId: "pc-card", environmentId: pc });
    yield* sendTo("stalled-worker", "Keep working", { type: "defer_start" });
    yield* completeRun("stalled-worker");
    yield* Deferred.await(stalledAsked);

    // An unrelated thread with a follow-up queued behind its active run.
    yield* createUnder("busy");
    yield* sendTo("busy", "first", { type: "start_immediately" });
    yield* sendTo("busy", "second", { type: "queue_after_active" });
    const queued = (yield* projections.getThreadRecords(ThreadId.make("busy"), ["runs"])).runs.at(
      -1,
    )!;
    assert.equal(queued.status, "queued");
    const before = yield* sink.latestSequence();
    yield* completeRun("busy", 0);
    const started = yield* sink.stream({ afterSequence: before, eventType: "run.updated" }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" &&
          stored.event.payload.id === queued.id &&
          stored.event.payload.status !== "queued",
      ),
      Stream.runHead,
    );
    assert.isTrue(started._tag === "Some");
    assert.deepEqual(asked, [`${pc}:pc-card`]);
    assert.isNull((yield* projections.getThread(ThreadId.make("stalled-worker"))).settledAt);
  }).pipe(Effect.provide(withRemoteParents(relay)));
});

it.effect("age settlement applies to one card without cascading to child chats or subagents", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* ProjectionStoreV2;
    const create = (id: string, parentThreadId?: string) =>
      orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${id}`),
        threadId: ThreadId.make(id),
        projectId: ProjectId.make("project:parents"),
        title: id,
        modelSelection: { instanceId, model: "gpt-5.1-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
        ...(parentThreadId === undefined ? {} : { parentThreadId: ThreadId.make(parentThreadId) }),
      });
    const thread = (id: string) => projections.getThread(ThreadId.make(id));

    yield* create("merged");
    yield* create("idle", "merged");
    yield* create("idle-helper", "idle");
    yield* create("kept", "merged");
    yield* orchestrator.dispatch({
      type: "thread.unsettle",
      commandId: CommandId.make("keep:kept"),
      threadId: ThreadId.make("kept"),
      reason: "user",
    });
    yield* drainEffects;

    const parent = yield* thread("merged");
    const settledAt = DateTime.subtract(parent.updatedAt, { days: 1 });
    yield* orchestrator.dispatch({
      type: "thread.auto-settle",
      commandId: CommandId.make("auto-settle:merged"),
      threadId: ThreadId.make("merged"),
      snapshotAt: parent.updatedAt,
      settledAt,
    });

    assert.deepEqual((yield* thread("merged")).settledAt, settledAt);
    assert.isNull((yield* thread("idle")).settledAt);
    assert.isNull((yield* thread("idle-helper")).settledAt);
    assert.equal((yield* thread("kept")).settledOverride, "active");

    // A later child chat completion must not turn an inactivity settlement into a manual cascade.
    yield* create("later-child", "merged");
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("send:later-child"),
      threadId: ThreadId.make("later-child"),
      messageId: MessageId.make("message:later-child"),
      text: "Next task",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    const run = (yield* projections.getThreadRecords(ThreadId.make("later-child"), [
      "runs",
    ])).runs.at(-1)!;
    const now = yield* DateTime.now;
    const sink = yield* EventSinkV2;
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:later-child:complete"),
          type: "run.updated",
          threadId: ThreadId.make("later-child"),
          occurredAt: now,
          payload: { ...run, status: "completed", completedAt: now },
        },
      ],
    });
    const receipt = yield* orchestrator.dispatch({
      type: "thread.sub-run.settle",
      commandId: CommandId.make("completion:later-child"),
      threadId: ThreadId.make("later-child"),
    });
    assert.equal(receipt.storedEvents.length, 0);
    assert.isNull((yield* thread("later-child")).settledAt);
    // Matching idle timestamps are not evidence of a manual cascade.
    const idle = yield* thread("idle");
    yield* orchestrator.dispatch({
      type: "thread.auto-settle",
      commandId: CommandId.make("auto-settle:idle"),
      threadId: idle.id,
      snapshotAt: idle.updatedAt,
      settledAt,
    });
    yield* orchestrator.dispatch({
      type: "thread.unsettle",
      commandId: CommandId.make("unsettle:aged-parent"),
      threadId: parent.id,
      reason: "user",
    });
    yield* drainEffects;
    assert.isNull((yield* thread("merged")).settledAt);
    assert.deepEqual((yield* thread("idle")).settledAt, settledAt);
    yield* TestClock.adjust("1 day");
    const refreshedAt = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.unsettle",
      commandId: CommandId.make("unsettle:already-active"),
      threadId: parent.id,
      reason: "user",
    });
    yield* drainEffects;
    assert.deepEqual((yield* thread("merged")).unsettledAt, refreshedAt);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "automatic settlement rejects active descendants and stale snapshots; receipts are idempotent",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const projections = yield* ProjectionStoreV2;
      const sink = yield* EventSinkV2;
      const create = (id: string, parentThreadId?: string) =>
        orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${id}`),
          threadId: ThreadId.make(id),
          projectId: ProjectId.make("project:parents"),
          title: id,
          modelSelection: { instanceId, model: "gpt-5.1-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
          ...(parentThreadId === undefined
            ? {}
            : { parentThreadId: ThreadId.make(parentThreadId) }),
        });
      const automatic = (id: string, snapshotAt: DateTime.Utc) => ({
        type: "thread.auto-settle" as const,
        commandId: CommandId.make(`auto:${id}`),
        threadId: ThreadId.make(id),
        snapshotAt,
      });
      const dispatchMessage = (id: string) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`send:${id}`),
          threadId: ThreadId.make(id),
          messageId: MessageId.make(`message:${id}`),
          text: "Work",
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });

      for (const activity of ["queued", "running", "approval", "user_input", "monitor"] as const) {
        const parentId = `parent:${activity}`;
        const childId = `child:${activity}`;
        yield* create(parentId);
        const middleId = `middle:${activity}`;
        yield* create(middleId, parentId);
        yield* create(childId, middleId);
        const child = yield* projections.getThread(ThreadId.make(childId));
        const now = yield* DateTime.now;
        if (activity === "queued" || activity === "running") {
          yield* dispatchMessage(childId);
          if (activity === "running") {
            const run = (yield* projections.getThreadRecords(child.id, ["runs"])).runs.at(-1)!;
            yield* sink.write({
              events: [
                {
                  id: EventId.make("running:run"),
                  type: "run.updated",
                  threadId: child.id,
                  occurredAt: now,
                  payload: { ...run, status: "running", startedAt: now },
                },
              ],
            });
          }
        } else if (activity === "approval" || activity === "user_input") {
          yield* sink.write({
            events: [
              {
                id: EventId.make(`request:${activity}`),
                type: "runtime-request.updated",
                threadId: child.id,
                occurredAt: now,
                payload: {
                  id: RuntimeRequestId.make(`request:${activity}`),
                  nodeId: NodeId.make(`node:${activity}`),
                  providerTurnId: null,
                  nativeRequestRef: null,
                  kind: activity === "approval" ? "command" : "user_input",
                  status: "pending",
                  responseCapability: { type: "not_resumable", reason: "Process stopped" },
                  createdAt: now,
                  resolvedAt: null,
                },
              },
            ],
          });
        } else {
          yield* sink.write({
            events: [
              {
                id: EventId.make("monitor:lineage"),
                type: "thread.metadata-updated",
                threadId: child.id,
                occurredAt: now,
                payload: {
                  ...child,
                  lineage: {
                    ...child.lineage,
                    parentThreadId: ThreadId.make(middleId),
                    relationshipToParent: "subagent",
                  },
                },
              },
            ],
          });
          yield* dispatchMessage(childId);
          const run = (yield* projections.getThreadRecords(child.id, ["runs"])).runs.at(-1)!;
          yield* sink.write({
            events: [
              {
                id: EventId.make("monitor:run-completed"),
                type: "run.updated",
                threadId: child.id,
                occurredAt: now,
                payload: { ...run, status: "completed", completedAt: now },
              },
              {
                id: EventId.make("monitor:roster"),
                type: "provider-thread.updated",
                threadId: child.id,
                occurredAt: now,
                payload: {
                  id: ProviderThreadId.make("monitor:provider-thread"),
                  appThreadId: child.id,
                  ownerNodeId: null,
                  driver: ProviderDriverKind.make("codex"),
                  providerInstanceId: instanceId,
                  providerSessionId: null,
                  nativeThreadRef: null,
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                  pendingBackgroundTasks: [
                    { taskId: "monitor:task", kind: "monitor", awaited: true },
                  ],
                },
              },
            ],
          });
        }
        assert.isTrue(yield* projections.hasActiveDescendants(ThreadId.make(parentId)));
        const parent = yield* projections.getThread(ThreadId.make(parentId));
        const sequence = yield* sink.latestSequence();
        yield* orchestrator.dispatch(automatic(parentId, parent.updatedAt)).pipe(Effect.flip);
        assert.equal(yield* sink.latestSequence(), sequence);
        assert.isNull((yield* projections.getThread(parent.id)).settledAt);
        yield* orchestrator
          .dispatch(automatic(childId, (yield* projections.getThread(child.id)).updatedAt))
          .pipe(Effect.flip);
        assert.isNull((yield* projections.getThread(child.id)).settledAt);
      }

      yield* create("stale");
      const stale = yield* projections.getThread(ThreadId.make("stale"));
      yield* TestClock.adjust("1 minute");
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("unsettle:stale"),
        threadId: stale.id,
        reason: "user",
      });
      yield* drainEffects;
      const sequence = yield* sink.latestSequence();
      yield* orchestrator.dispatch(automatic("stale", stale.updatedAt)).pipe(Effect.flip);
      assert.equal(yield* sink.latestSequence(), sequence);
      assert.isNull((yield* projections.getThread(stale.id)).settledAt);

      yield* create("idle-receipt");
      const idle = yield* projections.getThread(ThreadId.make("idle-receipt"));
      const command = automatic("idle-receipt", idle.updatedAt);
      const first = yield* orchestrator.dispatch(command);
      const duplicate = yield* orchestrator.dispatch(command);
      assert.equal(first.storedEvents.length, 1);
      assert.deepEqual(duplicate, { ...first, replayed: true });
      assert.equal(yield* sink.latestSequence(), first.sequence);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("un-settling follows provenance, not a shared settle time", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* ProjectionStoreV2;
    const thread = (id: string) => projections.getThread(ThreadId.make(id));
    const settle = (id: string) =>
      orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make(`settle:${id}`),
          threadId: ThreadId.make(id),
        })
        .pipe(Effect.andThen(drainEffects));
    const unsettle = (id: string) =>
      orchestrator
        .dispatch({
          type: "thread.unsettle",
          commandId: CommandId.make(`unsettle:${id}`),
          threadId: ThreadId.make(id),
          reason: "user",
        })
        .pipe(Effect.andThen(drainEffects));

    yield* createUnder("captain");
    yield* createUnder("named", { threadId: "captain" });
    yield* createUnder("grandchild", { threadId: "named" });
    yield* createUnder("own", { threadId: "captain" });
    yield* createUnder("own-child", { threadId: "own" });
    // Settled by hand in the same instant the Captain is: the clock alone cannot tell them apart.
    yield* settle("own");
    assert.isNull((yield* thread("own")).settledBy);
    yield* orchestrator.dispatch({
      type: "thread.unsettle",
      commandId: CommandId.make("unsettle:own-child"),
      threadId: ThreadId.make("own-child"),
      reason: "user",
    });
    yield* settle("captain");
    const captainAt = (yield* thread("captain")).settledAt;
    for (const id of ["named", "grandchild", "own-child"]) {
      const settled = yield* thread(id);
      assert.deepEqual(settled.settledAt, captainAt);
      assert.equal(settled.settledBy, "captain");
    }
    assert.deepEqual((yield* thread("own")).settledAt, captainAt);

    // Un-settling one named child brings back what settled under it with the Captain, only.
    yield* unsettle("named");
    assert.isNull((yield* thread("named")).settledAt);
    assert.isNull((yield* thread("grandchild")).settledAt);
    assert.deepEqual((yield* thread("own-child")).settledAt, captainAt);

    yield* unsettle("captain");
    assert.isNull((yield* thread("captain")).settledAt);
    assert.isNull((yield* thread("own-child")).settledAt);
    // Settled on its own, so it keeps its settle even though its time matches the Captain's.
    assert.deepEqual((yield* thread("own")).settledAt, captainAt);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "a finished child settles with its sub-runs, leaves its parent, and un-settles them",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const projections = yield* ProjectionStoreV2;
      const thread = (id: string) => projections.getThread(ThreadId.make(id));
      const finishedChild = (id: string, snapshotAt: DateTime.Utc) =>
        orchestrator.dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make(`auto:finished:${id}`),
          threadId: ThreadId.make(id),
          snapshotAt,
          settledAt: snapshotAt,
          reason: "finished-child",
        });

      yield* createUnder("lead");
      yield* createUnder("worker", { threadId: "lead" });
      yield* createUnder("helper", { threadId: "worker" });

      // Only a thread with a parent is a child.
      const lead = yield* thread("lead");
      yield* finishedChild("lead", lead.updatedAt).pipe(Effect.flip);
      assert.isNull((yield* thread("lead")).settledAt);

      const worker = yield* thread("worker");
      yield* finishedChild("worker", worker.updatedAt);
      yield* drainEffects;
      const settled = yield* thread("worker");
      assert.equal(settled.settledOverride, "settled");
      assert.equal(settled.settlementReason, "finished-child");
      assert.equal(settled.settlementSource, "manual");
      assert.equal((yield* thread("helper")).settledBy, "worker");
      assert.isNull((yield* thread("lead")).settledAt);
      assert.notEqual((yield* thread("lead")).settledOverride, "settled");

      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("unsettle:worker"),
        threadId: ThreadId.make("worker"),
        reason: "user",
      });
      yield* drainEffects;
      assert.isNull((yield* thread("worker")).settledAt);
      assert.isNull((yield* thread("worker")).settlementReason);
      assert.isNull((yield* thread("helper")).settledAt);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("a cascade cut short resumes where it left off, settling each sub-run once", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* ProjectionStoreV2;
    const sink = yield* EventSinkV2;
    yield* createUnder("card");
    yield* createUnder("first", { threadId: "card" });
    yield* createUnder("first-helper", { threadId: "first" });
    yield* createUnder("second", { threadId: "card" });
    const before = yield* sink.latestSequence();
    yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("settle:card"),
      threadId: ThreadId.make("card"),
    });
    // The settle returns before any sub-run follows; the walk waits in the outbox.
    assert.isNull((yield* projections.getThread(ThreadId.make("first"))).settledAt);
    const cardAt = (yield* projections.getThread(ThreadId.make("card"))).settledAt!;
    // The worker settled one sub-run, then the server stopped before it finished the walk.
    yield* orchestrator.dispatch({
      type: "thread.settlement.follow",
      commandId: CommandId.make("settle:card:cascade:first"),
      threadId: ThreadId.make("first"),
      action: "settle",
      settledBy: ThreadId.make("card"),
      settledAt: cardAt,
    });
    yield* drainEffects;
    for (const id of ["first", "first-helper", "second"]) {
      assert.deepEqual((yield* projections.getThread(ThreadId.make(id))).settledAt, cardAt);
    }
    const settled = Array.from(
      yield* sink
        .stream({ afterSequence: before, eventType: "thread.settled" })
        .pipe(Stream.take(4), Stream.runCollect),
      (stored) => stored.event.threadId,
    );
    // Each once: a sub-run settled twice would crowd another out of the first four.
    assert.sameMembers(settled, ["card", "first", "first-helper", "second"]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a busy sub-run follows a repeat settle once it finishes, with its subtree", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* ProjectionStoreV2;
    const sink = yield* EventSinkV2;
    const thread = (id: string) => projections.getThread(ThreadId.make(id));
    const command = (type: "thread.settle" | "thread.unsettle", id: string, round: number) =>
      orchestrator
        .dispatch(
          type === "thread.settle"
            ? {
                type,
                commandId: CommandId.make(`settle:${id}:${round}`),
                threadId: ThreadId.make(id),
              }
            : {
                type,
                commandId: CommandId.make(`unsettle:${id}:${round}`),
                threadId: ThreadId.make(id),
                reason: "user",
              },
        )
        .pipe(Effect.andThen(drainEffects));

    yield* createUnder("captain");
    yield* createUnder("worker", { threadId: "captain" });
    yield* createUnder("helper", { threadId: "worker" });
    yield* createUnder("opted-out", { threadId: "captain" });
    yield* orchestrator.dispatch({
      type: "thread.auto-settle.set",
      commandId: CommandId.make("auto-settle:off:opted-out"),
      threadId: ThreadId.make("opted-out"),
      enabled: false,
    });
    // Un-settling the Captain brings its sub-runs back as explicitly active.
    yield* command("thread.settle", "captain", 1);
    yield* command("thread.unsettle", "captain", 1);
    assert.equal((yield* thread("worker")).settledOverride, "active");
    yield* TestClock.adjust("1 minute");

    yield* sendTo("worker", "keep working", { type: "defer_start" });
    yield* sendTo("opted-out", "keep working", { type: "defer_start" });
    yield* command("thread.settle", "captain", 2);
    const captainAt = (yield* thread("captain")).settledAt;
    assert.isNull((yield* thread("worker")).settledAt);

    const before = yield* sink.latestSequence();
    yield* completeRun("worker");
    yield* completeRun("opted-out");
    yield* sink.stream({ afterSequence: before, eventType: "thread.settled" }).pipe(
      Stream.filter((stored) => stored.event.threadId === "opted-out"),
      Stream.runHead,
    );
    // The worker settled before the opted-out chat; its own subtree follows in the outbox.
    yield* drainEffects;
    for (const id of ["worker", "helper", "opted-out"]) {
      const settled = yield* thread(id);
      assert.deepEqual(settled.settledAt, captainAt, id);
      assert.equal(settled.settledBy, "captain", id);
    }
  }).pipe(Effect.provide(testLayer)),
);
