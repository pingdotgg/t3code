import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "./IdAllocator.ts";
import { applyToProjection, emptyProjection } from "./ProjectionStore.ts";
import { planThreadDeletion } from "./ThreadDeletion.ts";

const threadId = ThreadId.make("thread:delete-plan");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const providerThreadId = ProviderThreadId.make("provider-thread:delete-plan");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
const createdAt = DateTime.makeUnsafe("2026-09-01T00:00:00.000Z");
const deletedAt = DateTime.makeUnsafe("2026-09-04T00:00:00.000Z");
const command = {
  type: "thread.delete" as const,
  commandId: CommandId.make("command:delete-plan"),
  threadId,
};

function makeProjection(): OrchestrationV2ThreadProjection {
  const base = emptyProjection({
    id: EventId.make("event:delete-plan-created"),
    type: "thread.created",
    threadId,
    occurredAt: createdAt,
    payload: {
      id: threadId,
      createdBy: "user",
      creationSource: "web",
      projectId: ProjectId.make("project:delete-plan"),
      title: "Delete the thread",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature",
      worktreePath: "/workspace/feature",
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  const runs: Array<OrchestrationV2Run> = (
    ["preparing", "queued", "starting", "running", "waiting", "completed"] as const
  ).map((status, index) => ({
    id: RunId.make(`run:delete-plan:${status}`),
    threadId,
    ordinal: index + 1,
    providerInstanceId,
    modelSelection,
    providerThreadId,
    userMessageId: MessageId.make(`message:delete-plan:${status}`),
    rootNodeId: NodeId.make(`node:delete-plan:${status}`),
    activeAttemptId: RunAttemptId.make(`attempt:delete-plan:${status}`),
    status,
    queuePosition: status === "queued" ? 1 : null,
    requestedAt: createdAt,
    startedAt: createdAt,
    completedAt: status === "completed" ? createdAt : null,
    checkpointId: null,
    contextHandoffId: null,
  }));
  return {
    ...base,
    runs,
    attempts: runs.map((run) => ({
      id: run.activeAttemptId!,
      runId: run.id,
      attemptOrdinal: 1,
      rootNodeId: run.rootNodeId!,
      providerInstanceId,
      providerThreadId,
      providerTurnId: null,
      reason: "initial",
      status: run.status === "completed" ? "completed" : "running",
      startedAt: createdAt,
      completedAt: run.completedAt,
    })),
    nodes: runs.map((run) => ({
      id: run.rootNodeId!,
      threadId,
      runId: run.id,
      parentNodeId: null,
      rootNodeId: run.rootNodeId!,
      kind: "root_turn",
      status: run.status === "completed" ? "completed" : "waiting",
      countsForRun: true,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: createdAt,
      completedAt: run.completedAt,
    })),
    runtimeRequests: ["pending", "resolved"].map((status) => ({
      id: RuntimeRequestId.make(`request:delete-plan:${status}`),
      nodeId: runs[3]!.rootNodeId!,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: status === "pending" ? "pending" : "resolved",
      responseCapability: { type: "message" },
      createdAt,
      resolvedAt: status === "resolved" ? createdAt : null,
    })),
  };
}

it.effect("cancels active work without reviving a run while disposing delegated completion", () =>
  Effect.gen(function* () {
    const base = makeProjection();
    const parentRun = base.runs.find((run) => run.status === "running")!;
    const queuedRun = base.runs.find((run) => run.status === "queued")!;
    const taskId = NodeId.make("task:delete-plan");
    const projection: OrchestrationV2ThreadProjection = {
      ...base,
      runs: base.runs.map((run) =>
        run.id === parentRun.id
          ? {
              ...run,
              delegatedCompletion: {
                disposition: "open",
                nextGeneration: 3,
                settledDeliveryCount: 1,
                delivery: { generation: 2, messageId: queuedRun.userMessageId, taskIds: [taskId] },
              },
            }
          : run,
      ),
      subagents: [
        {
          id: taskId,
          threadId,
          runId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          origin: "app_owned",
          createdBy: "agent",
          driver,
          providerInstanceId,
          providerThreadId: null,
          childThreadId: null,
          nativeTaskRef: null,
          prompt: "Inspect the project",
          title: null,
          model: null,
          completionDelivery: { state: "claimed", observedByRunId: null },
          status: "completed",
          result: "done",
          startedAt: createdAt,
          completedAt: createdAt,
          updatedAt: createdAt,
        },
      ],
    };
    const plan = yield* planThreadDeletion({
      command,
      projection,
      now: deletedAt,
      idAllocator: yield* IdAllocatorV2,
    });
    const deleted = plan.events.reduce(applyToProjection, projection);
    assert.deepEqual(deleted.thread.deletedAt, deletedAt);
    assert.equal(deleted.thread.worktreePath, "/workspace/feature");
    assert.isNull(projection.thread.deletedAt);
    for (const run of deleted.runs) {
      assert.equal(run.status, run.id.endsWith(":completed") ? "completed" : "cancelled");
      assert.deepEqual(run.completedAt, run.id.endsWith(":completed") ? createdAt : deletedAt);
    }
    for (const attempt of deleted.attempts) {
      assert.equal(
        attempt.status,
        attempt.runId.endsWith(":completed") ? "completed" : "cancelled",
      );
    }
    for (const node of deleted.nodes) {
      assert.equal(node.status, node.runId?.endsWith(":completed") ? "completed" : "cancelled");
    }
    const pending = deleted.runtimeRequests.find((request) => request.id.endsWith(":pending"))!;
    assert.equal(pending.status, "cancelled");
    assert.deepEqual(pending.responseCapability, {
      type: "not_resumable",
      reason: "The thread was deleted.",
    });
    assert.deepEqual(deleted.runtimeRequests[1], projection.runtimeRequests[1]);
    assert.deepEqual(deleted.runs.find((run) => run.id === parentRun.id)?.delegatedCompletion, {
      disposition: "disposed",
      nextGeneration: 3,
      settledDeliveryCount: 1,
      delivery: null,
    });
    assert.equal(deleted.subagents[0]?.completionDelivery?.state, "disposed");
    const queuedRunUpdates = plan.events.filter(
      (event) => event.type === "run.updated" && event.payload.id === queuedRun.id,
    );
    assert.lengthOf(queuedRunUpdates, 1);
  }).pipe(Effect.provide(idAllocatorLayer)),
);

it.effect("queues provider and resource cleanup and preserves an earlier deletion timestamp", () =>
  Effect.gen(function* () {
    const base = makeProjection();
    const projection: OrchestrationV2ThreadProjection = {
      ...base,
      thread: { ...base.thread, deletedAt: createdAt },
      providerSessions: ["running", "stopped", "error"].map((status) => ({
        id: ProviderSessionId.make(`session:delete-plan:${status}`),
        driver,
        providerInstanceId,
        status: status === "running" ? "running" : status === "stopped" ? "stopped" : "error",
        cwd: "/workspace/feature",
        model: null,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt,
        updatedAt: createdAt,
        lastError: null,
      })),
      messages: [0, 1].map((index) => ({
        id: MessageId.make(`message:attachment:${index}`),
        threadId,
        createdBy: "user",
        creationSource: "web",
        runId: null,
        nodeId: null,
        role: "user",
        text: "Inspect this file",
        attachments: [
          {
            type: "file",
            id: "shared_file",
            name: "input.txt",
            mimeType: "text/plain",
            sizeBytes: 10,
          },
        ],
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      })),
    };
    const plan = yield* planThreadDeletion({
      command,
      projection,
      now: deletedAt,
      idAllocator: yield* IdAllocatorV2,
    });
    const deleted = plan.events.reduce(applyToProjection, projection);
    assert.deepEqual(deleted.thread.deletedAt, createdAt);
    assert.deepEqual(
      deleted.providerSessions.map((session) => session.status),
      ["stopped", "error"],
    );
    assert.deepEqual(
      plan.effects.map((effect) => effect.request),
      [
        {
          type: "provider-session.detach",
          providerSessionId: ProviderSessionId.make("session:delete-plan:running"),
          detail: "Thread deleted.",
          revokeMcpCredential: true,
        },
        { type: "terminal.cleanup" },
        { type: "attachment.cleanup", attachmentIds: ["shared_file"] },
      ],
    );
  }).pipe(Effect.provide(idAllocatorLayer)),
);
