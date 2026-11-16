import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  isListedThreadLineage,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);

it.effect("shells flag a latest run that an FYI's wake started as a background wake", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const at = yield* DateTime.now;
    const threadId = ThreadId.make("thread:background-wake:fyi");
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
    const firstRun = {
      id: RunId.make("run:background-wake:fyi:first"),
      threadId,
      ordinal: 1,
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make("message:background-wake:fyi:first"),
      rootNodeId: NodeId.make("node:background-wake:fyi:first"),
      activeAttemptId: null,
      status: "rolled_back" as const,
      requestedAt: at,
      startedAt: at,
      completedAt: at,
      checkpointId: null,
      contextHandoffId: null,
    };
    yield* store.apply({
      id: EventId.make("event:background-wake:fyi:thread"),
      type: "thread.created",
      threadId,
      occurredAt: at,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:background-wake:fyi"),
        title: "FYI wake",
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    yield* store.apply({
      id: EventId.make("event:background-wake:fyi:first-run"),
      type: "run.created",
      threadId,
      runId: firstRun.id,
      nodeId: firstRun.rootNodeId,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: modelSelection.instanceId,
      occurredAt: at,
      payload: firstRun,
    });
    const messageId = MessageId.make("message:background-wake:fyi");
    yield* store.apply({
      id: EventId.make("event:background-wake:fyi:message"),
      type: "message.updated",
      threadId,
      occurredAt: at,
      payload: {
        id: messageId,
        threadId,
        runId: null,
        nodeId: null,
        createdBy: "agent",
        creationSource: "server",
        role: "user",
        text: "fyi",
        attachments: [],
        streaming: false,
        createdAt: at,
        updatedAt: at,
        notification: {
          source: { kind: "fyi" },
          outcome: "updated",
          summary: "Background activity updated",
        },
      },
    });
    yield* store.apply({
      id: EventId.make("event:background-wake:fyi:run"),
      type: "run.created",
      threadId,
      occurredAt: at,
      payload: {
        ...firstRun,
        id: RunId.make("run:background-wake:fyi"),
        ordinal: 2,
        userMessageId: messageId,
        status: "completed",
        completedAt: at,
      },
    });

    const shells = [
      yield* store.getThreadShell(threadId),
      ProjectionStore.threadShellFromProjection(yield* store.getThreadProjection(threadId)),
    ];
    assert.deepEqual(
      shells.map((shell) => shell?.latestRunBackgroundWake),
      [true, true],
    );

    const snapshot = yield* store.getShellSnapshot();
    const awareness = (thread: Parameters<typeof projectThreadAwarenessV2>[0]["thread"]) =>
      projectThreadAwarenessV2({
        environmentId: EnvironmentId.make("test"),
        project: { title: "Test" },
        thread,
      });
    const activity = yield* store.getAgentAwarenessSnapshot();
    assert.deepEqual(
      activity.threads.map(awareness),
      snapshot.threads.filter((thread) => isListedThreadLineage(thread.lineage)).map(awareness),
    );
    const targeted = yield* store.getAgentAwarenessSnapshot(threadId);
    assert.deepEqual(targeted.threads.map(awareness), [awareness(shells[0]!)]);
    const iso = (value: DateTime.Utc | null | undefined) =>
      value == null ? null : DateTime.formatIso(value);
    const trimmed = (
      row: Pick<
        ProjectionStore.ActiveShellIndexEntry,
        | "id"
        | "projectId"
        | "lineage"
        | "settledOverride"
        | "settledAt"
        | "pinnedAt"
        | "snoozedUntil"
      >,
    ) => ({
      id: row.id,
      projectId: row.projectId,
      lineage: row.lineage,
      settledOverride: row.settledOverride,
      settledAt: iso(row.settledAt),
      pinnedAt: iso(row.pinnedAt),
      snoozedUntil: iso(row.snoozedUntil),
    });
    const index = yield* store.listActiveShellIndex();
    assert.deepEqual(index.map(trimmed), snapshot.threads.map(trimmed));
  }).pipe(Effect.provide(layerTest)),
);
