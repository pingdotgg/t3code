import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layer = EventSink.layer.pipe(
  Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
  Layer.provide(Sqlite.layerMemory),
);

it.effect("rejects a planned fork whose source was deleted before it committed", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const sourceId = ThreadId.make("fork-source");
    const targetId = ThreadId.make("fork-target");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const source: OrchestrationV2AppThread = {
      id: sourceId,
      projectId: ProjectId.make("project"),
      title: "Source",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: sourceId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      lastVisitedAt: null,
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make("source-created"),
          type: "thread.created",
          threadId: sourceId,
          occurredAt: now,
          payload: source,
        },
      ],
    });
    const plannedFork = {
      commandId: CommandId.make("fork"),
      commandType: "thread.fork",
      threadId: targetId,
      acceptedAt: now,
      effects: [],
      events: [
        {
          id: EventId.make("fork-created"),
          type: "thread.created" as const,
          threadId: targetId,
          occurredAt: now,
          payload: {
            ...source,
            id: targetId,
            forkedFrom: { type: "run" as const, threadId: sourceId, runId: RunId.make("run") },
          },
        },
      ],
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make("source-deleted"),
          type: "thread.deleted",
          threadId: sourceId,
          occurredAt: now,
          payload: { ...source, deletedAt: now },
        },
      ],
    });
    const rejected = yield* sink.commitCommand(plannedFork);
    assert.equal(rejected.receipt.status, "rejected");
    assert.isFalse(rejected.committed);
    const replayed = yield* sink.commitCommand(plannedFork);
    assert.deepEqual(replayed.receipt, rejected.receipt);
    assert.isFalse(replayed.committed);
    const missing = yield* projections.getThread(targetId).pipe(Effect.flip);
    assert.instanceOf(missing, ProjectionStore.ProjectionStoreThreadNotFoundError);
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects writeIfSubagentUnchanged when expectedNode changed to another run", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("subagent-node-guard");
    const run1Id = RunId.make("run:1");
    const run2Id = RunId.make("run:2");
    const rootNodeId = NodeId.make("node:root");
    const subagentId = NodeId.make("node:subagent");
    const providerInstanceId = ProviderInstanceId.make("opencode");
    const driver = ProviderDriverKind.make("opencode");
    const thread: OrchestrationV2AppThread = {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Parent",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "opencode/big-pickle" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      lastVisitedAt: null,
    };
    const subagent: OrchestrationV2Subagent = {
      id: subagentId,
      threadId,
      runId: run1Id,
      parentNodeId: rootNodeId,
      origin: "provider_native",
      createdBy: "agent",
      driver,
      providerInstanceId,
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: null,
      prompt: "work",
      title: "Worker",
      model: null,
      status: "running",
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    };
    const node: OrchestrationV2ExecutionNode = {
      id: subagentId,
      threadId,
      runId: run1Id,
      parentNodeId: rootNodeId,
      rootNodeId,
      kind: "subagent",
      status: "running",
      countsForRun: false,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make("subagent-guard:thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: thread,
        },
        {
          id: EventId.make("subagent-guard:subagent"),
          type: "subagent.updated",
          threadId,
          runId: run1Id,
          nodeId: subagentId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: subagent,
        },
        {
          id: EventId.make("subagent-guard:node"),
          type: "node.updated",
          threadId,
          runId: run1Id,
          nodeId: subagentId,
          providerInstanceId,
          occurredAt: now,
          payload: node,
        },
      ],
    });
    const claimedNode: OrchestrationV2ExecutionNode = { ...node, runId: run2Id };
    yield* sink.write({
      events: [
        {
          id: EventId.make("subagent-guard:claim-node"),
          type: "node.updated",
          threadId,
          runId: run2Id,
          nodeId: subagentId,
          providerInstanceId,
          occurredAt: now,
          payload: claimedNode,
        },
      ],
    });
    const result = yield* sink.writeIfSubagentUnchanged({
      expected: subagent,
      expectedNode: node,
      events: [
        {
          id: EventId.make("subagent-guard:fail-subagent"),
          type: "subagent.updated",
          threadId,
          runId: run1Id,
          nodeId: subagentId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: { ...subagent, status: "failed", completedAt: now, updatedAt: now },
        },
        {
          id: EventId.make("subagent-guard:fail-node"),
          type: "node.updated",
          threadId,
          runId: run1Id,
          nodeId: subagentId,
          providerInstanceId,
          occurredAt: now,
          payload: { ...node, status: "failed", completedAt: now },
        },
      ],
    });
    assert.isFalse(result.committed);
    const projection = yield* projections.getThreadProjection(threadId);
    assert.equal(projection.subagents[0]?.status, "running");
    assert.equal(projection.nodes[0]?.runId, run2Id);
    assert.equal(projection.nodes[0]?.status, "running");

    const accepted = yield* sink.writeIfSubagentUnchanged({
      expected: subagent,
      expectedNode: claimedNode,
      events: [
        {
          id: EventId.make("subagent-guard:fail-subagent-accepted"),
          type: "subagent.updated",
          threadId,
          runId: run1Id,
          nodeId: subagentId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: { ...subagent, status: "failed", completedAt: now, updatedAt: now },
        },
      ],
    });
    assert.isTrue(accepted.committed);
    const afterAccept = yield* projections.getThreadProjection(threadId);
    assert.equal(afterAccept.subagents[0]?.status, "failed");
    assert.equal(afterAccept.nodes[0]?.runId, run2Id);
    assert.equal(afterAccept.nodes[0]?.status, "running");
  }).pipe(Effect.provide(layer)),
);
