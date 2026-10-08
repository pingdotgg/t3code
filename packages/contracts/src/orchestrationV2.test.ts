import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  ContextTransferId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  NonNegativeInt,
  ProjectId,
  ProviderInstanceId,
  ProviderReplayTranscript,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./index.ts";
import {
  latestProviderTurnForAttempt,
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointScope,
  OrchestrationV2Command,
  OrchestrationV2LimitRecoveryUpdate,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderThreadJson,
  OrchestrationV2RpcSchemas,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2SubscribeThreadInput,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadStreamItem,
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemJson,
} from "./orchestrationV2.ts";

const now = DateTime.makeUnsafe("2026-04-20T00:00:00.000Z");
function emptyThreadProjection() {
  return {
    thread: {
      createdBy: "user",
      creationSource: "web",
      id: "thread-1",
      projectId: "project-1",
      title: "Thread",
      providerInstanceId: "codex",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: now,
  };
}

const LegacyShellStreamItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("synchronized") }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationV2ShellSnapshot,
  }),
]);
const LegacySubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
  afterSequence: Schema.optionalKey(NonNegativeInt),
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
});
const decodeLegacyShellStreamItem = Schema.decodeUnknownSync(LegacyShellStreamItem);
const decodeLegacySubscribeThreadInput = Schema.decodeUnknownSync(LegacySubscribeThreadInput);
const decodeOrchestrationV2Command = Schema.decodeUnknownSync(OrchestrationV2Command);
const decodeOrchestrationV2TurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
const decodeOrchestrationV2TurnItemJson = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const encodeOrchestrationV2TurnItemJson = Schema.encodeSync(OrchestrationV2TurnItemJson);
const decodeOrchestrationV2CheckpointScope = Schema.decodeUnknownSync(
  OrchestrationV2CheckpointScope,
);
const decodeOrchestrationV2Checkpoint = Schema.decodeUnknownSync(OrchestrationV2Checkpoint);
const decodeOrchestrationV2DomainEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEvent);
const decodeProviderReplayTranscript = Schema.decodeUnknownSync(ProviderReplayTranscript);
const decodeOrchestrationV2Subagent = Schema.decodeUnknownSync(OrchestrationV2Subagent);
const decodeOrchestrationV2ThreadProjection = Schema.decodeUnknownSync(
  OrchestrationV2ThreadProjection,
);
const decodeOrchestrationV2ThreadStreamItem = Schema.decodeUnknownSync(
  OrchestrationV2ThreadStreamItem,
);
const decodeOrchestrationV2ProviderThreadJson = Schema.decodeUnknownSync(
  OrchestrationV2ProviderThreadJson,
);
const encodeOrchestrationV2ProviderThreadJson = Schema.encodeSync(
  OrchestrationV2ProviderThreadJson,
);
const decodeOrchestrationV2ProviderThread = Schema.decodeUnknownSync(OrchestrationV2ProviderThread);
const decodeOrchestrationV2ThreadShell = Schema.decodeUnknownSync(OrchestrationV2ThreadShell);
const decodeOrchestrationV2ProviderCapabilities = Schema.decodeUnknownSync(
  OrchestrationV2ProviderCapabilities,
);

const decodeOrchestrationV2SubscribeThreadInput = Schema.decodeUnknownSync(
  OrchestrationV2SubscribeThreadInput,
);

describe("orchestration V2 contracts", () => {
  it("carries command failure metadata through runtime and JSON schemas without output text", () => {
    const base = {
      id: "command-item",
      type: "command_execution",
      threadId: "thread-1",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: "Command",
      input: "example",
      startedAt: null,
      completedAt: null,
    };
    for (const metadata of [
      {},
      { outputIndicatesFailure: true },
      { outputIndicatesFailure: false },
    ]) {
      const runtime = decodeOrchestrationV2TurnItem({ ...base, ...metadata, updatedAt: now });
      const json = decodeOrchestrationV2TurnItemJson({
        ...base,
        ...metadata,
        updatedAt: DateTime.formatIso(now),
      });
      expect(runtime.type).toBe("command_execution");
      expect(json.type).toBe("command_execution");
      expect(runtime).toMatchObject(metadata);
      expect(json).toMatchObject(metadata);
      expect(runtime).not.toHaveProperty("output");
      expect(json).not.toHaveProperty("output");
    }
  });

  it("decodes thread event types from a newer server as skippable items", () => {
    const decodeWireItems = Schema.decodeUnknownSync(
      Schema.toCodecJson(Schema.Array(OrchestrationV2RpcSchemas.subscribeThread.output)),
    );
    const detached = (id: string, sequence: number) => ({
      kind: "event",
      sequence,
      event: {
        id,
        type: "provider-session.detached",
        threadId: "thread-1",
        occurredAt: DateTime.formatIso(now),
        payload: { providerSessionId: "provider-session-1", detachedAt: DateTime.formatIso(now) },
      },
    });

    const items = decodeWireItems([
      detached("event-1", 1),
      {
        kind: "event",
        sequence: 2,
        event: {
          id: "event-2",
          // A type no build of this client knows, standing in for a newer server's event.
          type: "run.from-a-future-server",
          threadId: "thread-1",
          occurredAt: DateTime.formatIso(now),
          payload: { runId: "run-1" },
        },
      },
      detached("event-3", 3),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["event", "unknown-event", "event"]);
    expect(items[1]).toEqual({
      kind: "unknown-event",
      sequence: 2,
      eventType: "run.from-a-future-server",
    });
    // A known type with a broken payload is a real defect, not a newer event.
    expect(() =>
      decodeWireItems([
        { ...detached("event-4", 4), event: { ...detached("event-4", 4).event, payload: {} } },
      ]),
    ).toThrow();
  });

  it("skips turn item types from a newer server in snapshots and turn-item events", () => {
    const decodeWireItems = Schema.decodeUnknownSync(
      Schema.toCodecJson(Schema.Array(OrchestrationV2RpcSchemas.subscribeThread.output)),
    );
    const decodeHistoryPage = Schema.decodeUnknownSync(
      Schema.toCodecJson(OrchestrationV2ThreadHistoryPage),
    );
    const item = (id: string, type: string, extra: Record<string, unknown>) => ({
      id,
      type,
      threadId: "thread-1",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.formatIso(now),
      ...extra,
    });
    const known = item("item-known", "system_notice", { message: "Hello" });
    // A type no build of this client knows, standing in for a newer server's item.
    const future = item("item-future", "hologram", { beam: "ref-1" });
    const projected = (position: number, turnItem: { readonly id: string }) => ({
      position,
      visibility: "local",
      sourceThreadId: "thread-1",
      sourceItemId: turnItem.id,
      item: turnItem,
    });
    const projection = {
      thread: {
        createdBy: "user",
        creationSource: "web",
        id: "thread-1",
        projectId: "project-1",
        title: "Thread",
        providerInstanceId: "codex",
        modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" },
        forkedFrom: null,
        createdAt: DateTime.formatIso(now),
        updatedAt: DateTime.formatIso(now),
        archivedAt: null,
        deletedAt: null,
      },
      runs: [],
      attempts: [],
      nodes: [],
      subagents: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      runtimeRequests: [],
      messages: [],
      plans: [],
      turnItems: [future, known],
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      contextTransfers: [],
      visibleTurnItems: [projected(0, future), projected(1, known)],
      updatedAt: DateTime.formatIso(now),
    };
    const turnItemEvent = (sequence: number, payload: unknown) => ({
      kind: "event",
      sequence,
      event: {
        id: `event-${sequence}`,
        type: "turn-item.updated",
        threadId: "thread-1",
        occurredAt: DateTime.formatIso(now),
        payload,
      },
    });

    const [snapshot, futureEvent, knownEvent] = decodeWireItems([
      { kind: "snapshot", snapshotSequence: 1, projection },
      turnItemEvent(2, future),
      turnItemEvent(3, known),
    ]);

    expect(snapshot).toMatchObject({ kind: "snapshot" });
    if (snapshot?.kind !== "snapshot") throw new Error("expected a snapshot");
    expect(snapshot.projection.turnItems.map((turnItem) => turnItem.id)).toEqual(["item-known"]);
    expect(snapshot.projection.visibleTurnItems.map((row) => row.item.id)).toEqual(["item-known"]);
    expect(futureEvent).toEqual({
      kind: "unknown-event",
      sequence: 2,
      eventType: "turn-item.updated",
    });
    expect(knownEvent).toMatchObject({
      kind: "event",
      event: { type: "turn-item.updated", payload: { id: "item-known", type: "system_notice" } },
    });
    expect(
      decodeHistoryPage({
        snapshotSequence: 1,
        items: [projected(0, future), projected(1, known)],
        nextCursor: null,
        hasMoreHistory: false,
      }).items.map((row) => row.item.id),
    ).toEqual(["item-known"]);

    // A known turn item type with a broken payload is a real defect, not a newer item.
    const broken = item("item-broken", "system_notice", {});
    expect(() => decodeWireItems([turnItemEvent(4, broken)])).toThrow();
    expect(() =>
      decodeWireItems([
        {
          kind: "snapshot",
          snapshotSequence: 1,
          projection: { ...projection, turnItems: [broken] },
        },
      ]),
    ).toThrow();
  });

  it("negotiates bounded socket snapshots as an optional capability", () => {
    expect(
      decodeOrchestrationV2SubscribeThreadInput({
        threadId: "thread-1",
        acceptBoundedSnapshot: true,
      }).acceptBoundedSnapshot,
    ).toBe(true);
    expect(
      decodeOrchestrationV2SubscribeThreadInput({ threadId: "thread-1" }).acceptBoundedSnapshot,
    ).toBeUndefined();

    const legacyDecoded = decodeLegacySubscribeThreadInput({
      threadId: "thread-1",
      afterSequence: 12,
      acceptBoundedSnapshot: true,
    });
    expect(legacyDecoded.afterSequence).toBe(12);
    expect("acceptBoundedSnapshot" in legacyDecoded).toBe(false);
  });

  it("negotiates compact bounded turnItems without disturbing older peers", () => {
    // Older servers strip the unknown opt-in, so they keep sending full turnItems.
    const legacyDecoded = decodeLegacySubscribeThreadInput({
      threadId: "thread-1",
      acceptBoundedSnapshot: true,
      acceptCompactTurnItems: true,
    });
    expect("acceptCompactTurnItems" in legacyDecoded).toBe(false);
    expect(
      decodeOrchestrationV2SubscribeThreadInput({
        threadId: "thread-1",
        acceptCompactTurnItems: true,
      }).acceptCompactTurnItems,
    ).toBe(true);

    const decodeStreamItem = Schema.decodeUnknownSync(OrchestrationV2ThreadStreamItem);
    const projection = decodeStreamItem({
      kind: "snapshot",
      snapshotSequence: 1,
      projection: emptyThreadProjection(),
    });
    // Older servers never send the marker; newer clients treat absence as full turnItems.
    expect(projection.kind === "snapshot" && projection.turnItemsOmitLocalVisible).toBe(undefined);
    const marked = decodeStreamItem({
      kind: "snapshot",
      snapshotSequence: 1,
      projection: emptyThreadProjection(),
      turnItemsOmitLocalVisible: true,
    });
    expect(marked.kind === "snapshot" && marked.turnItemsOmitLocalVisible).toBe(true);
    // The marker only means "omitted"; any other value is a protocol error.
    expect(() =>
      decodeStreamItem({
        kind: "snapshot",
        snapshotSequence: 1,
        projection: emptyThreadProjection(),
        turnItemsOmitLocalVisible: false,
      }),
    ).toThrow();
  });

  it("decodes persisted capability snapshots that predate runtimePolicy", () => {
    // Events written before the field existed must replay; absent decodes to
    // the weaker client-boundary guarantee so history never overclaims.
    const legacyCapabilities = {
      sessions: {
        supportsMultipleProviderThreadsPerSession: false,
        supportsModelSwitchInSession: false,
        supportsProviderSwitchingViaHandoff: true,
        supportsRuntimeModeSwitchInSession: false,
        pendingRequestsSurviveRestart: false,
      },
      threads: {
        canCreateEmptyThread: true,
        canReadThreadSnapshot: false,
        canRollbackThread: true,
        canForkThread: false,
        canForkFromTurn: false,
        canForkFromSubagentThread: false,
        exposesNativeThreadId: true,
      },
      turns: {
        exposesNativeTurnId: false,
        emitsTurnStarted: true,
        emitsTurnCompleted: true,
        supportsInterrupt: true,
        supportsActiveSteering: false,
        supportsSteeringByInterruptRestart: true,
        supportsQueuedMessages: true,
        terminalStatusQuality: "strong",
      },
      streaming: {
        streamsAssistantText: true,
        streamsReasoning: true,
        streamsToolOutput: true,
        streamsPlanText: false,
        emitsMessageCompleted: true,
      },
      tools: {
        exposesToolItemIds: true,
        emitsToolStarted: true,
        emitsToolCompleted: true,
        emitsToolOutput: true,
        supportsMcpTools: false,
        supportsDynamicToolCallbacks: false,
      },
      approvals: {
        supportsCommandApproval: true,
        supportsFileReadApproval: true,
        supportsFileChangeApproval: true,
        supportsApplyPatchApproval: false,
        approvalsHaveNativeRequestIds: false,
        approvalCallbacksAreLiveOnly: true,
        approvalsCanOriginateFromSubagents: false,
      },
      planning: {
        emitsPlanUpdated: true,
        emitsTodoList: true,
        emitsProposedPlan: false,
        supportsStructuredQuestions: true,
        planDeltasHaveItemIds: false,
      },
      subagents: {
        supportsSubagents: false,
        exposesSubagentThreadIds: false,
        emitsSubagentLifecycle: false,
        canWaitForSubagents: false,
        canCloseSubagents: false,
        canForkSubagentThread: false,
      },
      context: {
        acceptsSystemContext: false,
        acceptsDeveloperContext: false,
        acceptsSyntheticUserContext: true,
        canGenerateSummaries: true,
        canConsumeHandoffSummaries: true,
        supportsDeltaHandoff: true,
        supportsFullThreadHandoff: true,
        maxRecommendedHandoffChars: null,
      },
      checkpointing: {
        appCanCheckpointFilesystem: true,
        supportsNestedCheckpointScopes: true,
        providerCanRollbackConversation: true,
        providerRollbackReturnsSnapshot: true,
        providerCanReadConversationSnapshot: false,
      },
      identity: {
        nativeThreadIds: "strong",
        nativeTurnIds: "weak",
        nativeItemIds: "weak",
        nativeRequestIds: "weak",
      },
    };

    const decoded = decodeOrchestrationV2ProviderCapabilities(legacyCapabilities);
    expect(decoded.runtimePolicy).toEqual({ enforcement: "client-boundary" });

    const explicit = decodeOrchestrationV2ProviderCapabilities({
      ...legacyCapabilities,
      runtimePolicy: { enforcement: "native" },
    });
    expect(explicit.runtimePolicy).toEqual({ enforcement: "native" });
  });

  it("lets legacy snapshot decoders ignore enrichment metadata", () => {
    const decoded = decodeLegacyShellStreamItem({
      kind: "snapshot",
      snapshot: {
        schemaVersion: 1,
        snapshotSequence: 0,
        projects: [],
        threads: [],
        archivedThreads: [],
      },
      resolvedRepositoryIdentityRoots: ["/workspace/project"],
    });

    expect(decoded.kind).toBe("snapshot");
    expect("resolvedRepositoryIdentityRoots" in decoded).toBe(false);
  });

  it("decodes nested checkpoint scopes without making child scopes advance app run count", () => {
    const rootScope = decodeOrchestrationV2CheckpointScope({
      id: "scope-root-1",
      threadId: "thread-1",
      runId: "run-1",
      nodeId: "node-root-1",
      parentScopeId: null,
      providerThreadId: "provider-thread-1",
      kind: "root_run",
      ordinalWithinParent: 1,
      advancesAppRunCount: true,
      cwd: "/tmp/project",
      createdAt: now,
    });
    const childScope = decodeOrchestrationV2CheckpointScope({
      id: "scope-child-1",
      threadId: "thread-1",
      runId: "run-1",
      nodeId: "node-child-1",
      parentScopeId: rootScope.id,
      providerThreadId: "provider-thread-child-1",
      kind: "subagent",
      ordinalWithinParent: 1,
      advancesAppRunCount: false,
      cwd: "/tmp/project",
      createdAt: now,
    });

    expect(rootScope.advancesAppRunCount).toBe(true);
    expect(childScope.parentScopeId).toBe(rootScope.id);
    expect(childScope.advancesAppRunCount).toBe(false);
  });

  it("decodes checkpoint captures that attach to scopes, nodes, and optional app run ordinals", () => {
    const checkpoint = decodeOrchestrationV2Checkpoint({
      id: "checkpoint-1",
      threadId: "thread-1",
      scopeId: "scope-child-1",
      runId: "run-1",
      nodeId: "node-child-1",
      parentCheckpointId: "checkpoint-root-1",
      ordinalWithinScope: 1,
      appRunOrdinal: null,
      ref: "git-ref-1",
      status: "ready",
      files: [{ path: "package.json", kind: "modified", additions: 2, deletions: 1 }],
      capturedAt: now,
    });

    expect(checkpoint.appRunOrdinal).toBeNull();
    expect(checkpoint.scopeId).toBe(CheckpointScopeId.make("scope-child-1"));
    expect(checkpoint.parentCheckpointId).toBe(CheckpointId.make("checkpoint-root-1"));
  });

  it("decodes command and domain event shapes for command-to-projection tests", () => {
    const command = decodeOrchestrationV2Command({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: "command-1",
      threadId: "thread-1",
      messageId: "message-1",
      text: "hello",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
    const event = decodeOrchestrationV2DomainEvent({
      id: "event-1",
      type: "run.created",
      threadId: "thread-1",
      runId: "run-1",
      occurredAt: now,
      payload: {
        id: "run-1",
        threadId: "thread-1",
        ordinal: 1,
        providerInstanceId: "codex",
        modelSelection: {
          instanceId: "codex",
          model: "gpt-5.4",
        },
        providerThreadId: "provider-thread-1",
        userMessageId: "message-1",
        rootNodeId: null,
        activeAttemptId: null,
        status: "queued",
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    });

    expect(command.commandId).toBe(CommandId.make("command-1"));
    expect(event.id).toBe(EventId.make("event-1"));
    if (event.type !== "run.created") {
      throw new Error(`Expected run.created, received ${event.type}.`);
    }
    expect(event.payload.id).toBe(RunId.make("run-1"));
  });

  it("decodes app-owned delegated task commands", () => {
    const command = decodeOrchestrationV2Command({
      type: "delegated_task.request",
      createdBy: "user",
      creationSource: "web",
      commandId: "command-delegate-1",
      parentThreadId: "thread-parent-1",
      parentRunId: "run-parent-1",
      parentNodeId: "node-parent-1",
      task: "Inspect the API boundary.",
      title: "API inspection",
      modelSelection: {
        instanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
      },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });

    expect(command.type).toBe("delegated_task.request");
    if (command.type !== "delegated_task.request") {
      throw new Error("expected delegated_task.request");
    }
    expect(command.parentThreadId).toBe(ThreadId.make("thread-parent-1"));
    expect(command.parentRunId).toBe(RunId.make("run-parent-1"));
    expect(command.parentNodeId).toBe(NodeId.make("node-parent-1"));
  });

  it("decodes delegated task wake-policy commands", () => {
    const command = decodeOrchestrationV2Command({
      type: "delegated_task.wake-policy",
      commandId: "command-delegate-wake-policy-1",
      parentThreadId: "thread-parent-1",
      taskId: "node-subagent-1",
      completionWake: "always",
    });

    expect(command.type).toBe("delegated_task.wake-policy");
    if (command.type !== "delegated_task.wake-policy") {
      throw new Error("expected delegated_task.wake-policy");
    }
    expect(command.parentThreadId).toBe(ThreadId.make("thread-parent-1"));
    expect(command.taskId).toBe(NodeId.make("node-subagent-1"));
    expect(command.completionWake).toBe("always");

    // The policy carries the whole decision, so it is required and closed.
    expect(() =>
      decodeOrchestrationV2Command({
        type: "delegated_task.wake-policy",
        commandId: "command-delegate-wake-policy-2",
        parentThreadId: "thread-parent-1",
        taskId: "node-subagent-1",
      }),
    ).toThrow();
    expect(() =>
      decodeOrchestrationV2Command({
        type: "delegated_task.wake-policy",
        commandId: "command-delegate-wake-policy-3",
        parentThreadId: "thread-parent-1",
        taskId: "node-subagent-1",
        completionWake: "sometimes",
      }),
    ).toThrow();
  });

  it("decodes durable created-thread timeline records", () => {
    const command = decodeOrchestrationV2Command({
      type: "thread.created.record",
      commandId: "command-thread-record-1",
      parentThreadId: "thread-parent-1",
      parentRunId: "run-parent-1",
      parentNodeId: "node-parent-1",
      targetThreadId: "thread-child-1",
      targetRunId: "run-child-1",
    });
    const item = decodeOrchestrationV2TurnItem({
      id: "turn-item-thread-created-1",
      type: "thread_created",
      threadId: "thread-parent-1",
      runId: "run-parent-1",
      nodeId: "node-parent-1",
      providerThreadId: "provider-thread-parent-1",
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 4,
      status: "completed",
      title: "Child thread",
      targetThreadId: "thread-child-1",
      targetRunId: "run-child-1",
      targetProviderInstanceId: "claude-default",
      targetModel: "claude-sonnet-4-6",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });

    expect(command.type).toBe("thread.created.record");
    if (command.type !== "thread.created.record") {
      throw new Error("expected thread.created.record");
    }
    expect(command.targetThreadId).toBe(ThreadId.make("thread-child-1"));
    expect(item.type).toBe("thread_created");
    if (item.type !== "thread_created") {
      throw new Error("expected thread_created");
    }
    expect(item.targetRunId).toBe(RunId.make("run-child-1"));
  });

  it("decodes provider-neutral replay transcripts", () => {
    const transcript = decodeProviderReplayTranscript({
      provider: "codex",
      protocol: "codex.app-server",
      version: "0.120.0",
      scenario: "simple",
      metadata: {
        source: "real-probe",
      },
      entries: [
        {
          type: "expect_outbound",
          label: "initialize",
          frame: { id: 1, method: "initialize" },
        },
        {
          type: "emit_inbound",
          label: "initialize-result",
          frame: { id: 1, result: { ok: true } },
        },
        {
          type: "runtime_exit",
          status: "success",
        },
      ],
    });

    expect(transcript.entries).toHaveLength(3);
    expect(transcript.protocol).toBe("codex.app-server");
  });

  it("decodes strictly typed turn items for known tools and dynamic fallback tools", () => {
    const fileChange = decodeOrchestrationV2TurnItem({
      id: "turn-item-file-change-1",
      type: "file_change",
      threadId: "thread-1",
      runId: "run-1",
      nodeId: "node-file-change-1",
      providerThreadId: "provider-thread-1",
      providerTurnId: "provider-turn-1",
      nativeItemRef: { driver: "codex", nativeId: "item-file-change-1", strength: "strong" },
      parentItemId: null,
      ordinal: 3,
      status: "completed",
      title: "Edited package.json",
      fileName: "package.json",
      additions: 4,
      deletions: 2,
      diffStr: "@@ fixture diff",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });
    const dynamicTool = decodeOrchestrationV2TurnItem({
      id: "turn-item-dynamic-1",
      type: "dynamic_tool",
      threadId: "thread-1",
      runId: "run-1",
      nodeId: "node-dynamic-1",
      providerThreadId: "provider-thread-1",
      providerTurnId: "provider-turn-1",
      nativeItemRef: { driver: "codex", nativeId: "item-dynamic-1", strength: "strong" },
      parentItemId: null,
      ordinal: 4,
      status: "completed",
      title: "Custom tool",
      toolName: "custom.lookup",
      input: { query: "fixture" },
      output: { ok: true },
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });

    expect(fileChange.type).toBe("file_change");
    if (fileChange.type !== "file_change") {
      throw new Error("expected file_change");
    }
    expect(fileChange.fileName).toBe("package.json");
    expect(fileChange.additions).toBe(4);
    expect(dynamicTool.id).toBe(TurnItemId.make("turn-item-dynamic-1"));
  });

  it("decodes bounded provider failures as expected error turn items", () => {
    const errorItem = decodeOrchestrationV2TurnItem({
      id: "turn-item-error-1",
      type: "error",
      threadId: "thread-1",
      runId: "run-1",
      nodeId: "node-root-1",
      providerThreadId: "provider-thread-1",
      providerTurnId: "provider-turn-1",
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 199,
      status: "failed",
      title: "Provider error",
      failure: {
        class: "validation_error",
        message: "Invalid reasoning effort.",
        code: "invalid_request",
        retryable: false,
      },
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });

    expect(errorItem.type).toBe("error");
    if (errorItem.type !== "error") throw new Error("expected error item");
    expect(errorItem.failure.message).toBe("Invalid reasoning effort.");
    const usageLimited = decodeOrchestrationV2TurnItem({
      ...errorItem,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      failure: { ...errorItem.failure, class: "usage_limit" },
    });
    expect(usageLimited.type === "error" && usageLimited.failure.class).toBe("usage_limit");
    expect(() =>
      decodeOrchestrationV2TurnItem({
        ...errorItem,
        failure: { ...errorItem.failure, message: "x".repeat(4_097) },
      }),
    ).toThrow();
  });

  it("decodes provider-native subagent lifecycle records and timeline items", () => {
    const subagent = decodeOrchestrationV2Subagent({
      id: "node-subagent-1",
      threadId: "thread-1",
      runId: "run-1",
      parentNodeId: "node-root-1",
      origin: "provider_native",
      createdBy: "agent",
      driver: "codex",
      providerInstanceId: "codex",
      providerThreadId: "provider-thread-subagent-1",
      childThreadId: null,
      nativeTaskRef: {
        driver: "codex",
        nativeId: "native-task-1",
        strength: "strong",
      },
      prompt: "Inspect package.json",
      title: "Package audit",
      model: "gpt-5.4",
      status: "completed",
      progress: "Inspecting package metadata",
      result: "Package is private.",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });
    const turnItem = decodeOrchestrationV2TurnItem({
      id: "turn-item-subagent-1",
      type: "subagent",
      threadId: "thread-1",
      runId: "run-1",
      nodeId: subagent.id,
      providerThreadId: subagent.providerThreadId,
      providerTurnId: "provider-turn-1",
      nativeItemRef: subagent.nativeTaskRef,
      parentItemId: null,
      ordinal: 2,
      status: "completed",
      title: subagent.title,
      subagentId: subagent.id,
      origin: subagent.origin,
      driver: subagent.driver,
      providerInstanceId: subagent.providerInstanceId,
      childThreadId: subagent.childThreadId,
      prompt: subagent.prompt,
      progress: subagent.progress,
      result: subagent.result,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });

    expect(subagent.origin).toBe("provider_native");
    expect(subagent.progress).toBe("Inspecting package metadata");
    expect(subagent.childThreadId).toBeNull();
    expect(turnItem.type).toBe("subagent");
    if (turnItem.type !== "subagent") throw new Error("expected subagent item");
    expect(turnItem.progress).toBe("Inspecting package metadata");
  });

  it("decodes app-owned subagent parent-wake policies", () => {
    const appOwnedSubagent = {
      id: "node-subagent-2",
      threadId: "thread-1",
      runId: "run-1",
      parentNodeId: "node-root-1",
      origin: "app_owned",
      createdBy: "agent",
      driver: "codex",
      providerInstanceId: "codex",
      providerThreadId: null,
      childThreadId: "thread-child-1",
      nativeTaskRef: null,
      prompt: "Inspect the API boundary.",
      title: "API inspection",
      model: "gpt-5.4",
      status: "running",
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    };
    const decode = Schema.decodeUnknownSync(OrchestrationV2Subagent);

    // Legacy records predate the field and must behave as settled_only.
    expect(decode(appOwnedSubagent).completionWake).toBeUndefined();
    expect(decode({ ...appOwnedSubagent, completionWake: "always" }).completionWake).toBe("always");
    expect(decode({ ...appOwnedSubagent, completionWake: "settled_only" }).completionWake).toBe(
      "settled_only",
    );
    expect(() => decode({ ...appOwnedSubagent, completionWake: "sometimes" })).toThrow();
  });

  it("decodes thread projections with an ordered turn item rendering stream", () => {
    const projection = decodeOrchestrationV2ThreadProjection({
      thread: {
        createdBy: "user",
        creationSource: "web",
        id: "thread-1",
        projectId: "project-1",
        title: "Thread",
        providerInstanceId: "codex",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: "thread-1",
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
      },
      runs: [],
      attempts: [],
      nodes: [],
      subagents: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      runtimeRequests: [],
      messages: [],
      plans: [],
      turnItems: [
        {
          id: "turn-item-command-1",
          type: "command_execution",
          threadId: "thread-1",
          runId: "run-1",
          nodeId: "node-command-1",
          providerThreadId: "provider-thread-1",
          providerTurnId: "provider-turn-1",
          nativeItemRef: { driver: "codex", nativeId: "item-command-1", strength: "strong" },
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: "Ran command",
          input: "bun typecheck",
          output: "Tasks: 10 successful",
          exitCode: 0,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      ],
      visibleTurnItems: [
        {
          position: 0,
          visibility: "local",
          sourceThreadId: "thread-1",
          sourceItemId: "turn-item-command-1",
          item: {
            id: "turn-item-command-1",
            type: "command_execution",
            threadId: "thread-1",
            runId: "run-1",
            nodeId: "node-command-1",
            providerThreadId: "provider-thread-1",
            providerTurnId: "provider-turn-1",
            nativeItemRef: { driver: "codex", nativeId: "item-command-1", strength: "strong" },
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: "Ran command",
            input: "bun typecheck",
            output: "Tasks: 10 successful",
            exitCode: 0,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
          },
        },
      ],
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      contextTransfers: [],
      updatedAt: now,
    });

    expect(projection.turnItems.map((item) => item.type)).toEqual(["command_execution"]);

    const boundedSnapshot = decodeOrchestrationV2ThreadStreamItem({
      kind: "snapshot",
      snapshotSequence: 12,
      projection,
      historyCursor: "older-page",
      hasMoreHistory: true,
      latestLocalTurnOrdinal: 1,
      payloadBudgetExceeded: false,
    });
    expect(boundedSnapshot).toMatchObject({
      kind: "snapshot",
      historyCursor: "older-page",
      hasMoreHistory: true,
      latestLocalTurnOrdinal: 1,
      payloadBudgetExceeded: false,
    });
  });

  it("decodes orchestration lifecycle turn items for compaction, handoff, and fork UI", () => {
    const compaction = decodeOrchestrationV2TurnItem({
      id: "turn-item-compaction-1",
      type: "compaction",
      threadId: "thread-1",
      runId: "run-1",
      nodeId: "node-compaction-1",
      providerThreadId: "provider-thread-1",
      providerTurnId: "provider-turn-1",
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 5,
      status: "running",
      title: "Compacting context...",
      driver: "codex",
      beforeTokenCount: 180000,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    });
    const handoff = decodeOrchestrationV2TurnItem({
      id: "turn-item-handoff-1",
      type: "handoff",
      threadId: "thread-1",
      runId: "run-2",
      nodeId: null,
      providerThreadId: "provider-thread-claude-1",
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 6,
      status: "completed",
      title: "Handed off to Claude",
      contextHandoffId: "handoff-1",
      fromProviderThreadIds: ["provider-thread-codex-1"],
      toProviderThreadId: "provider-thread-claude-1",
      fromProviderInstanceIds: ["codex"],
      toProviderInstanceId: "claudeAgent",
      strategy: "delta_since_target_last_seen",
      summary: "Codex completed the setup work.",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });
    const fork = decodeOrchestrationV2TurnItem({
      id: "turn-item-fork-1",
      type: "fork",
      threadId: "thread-1",
      runId: "run-2",
      nodeId: "node-subagent-1",
      providerThreadId: "provider-thread-child-1",
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 7,
      status: "completed",
      title: "Forked subagent thread",
      source: { type: "node", nodeId: "node-subagent-1" },
      targetThreadId: "thread-fork-1",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });

    expect(compaction.type).toBe("compaction");
    expect(compaction.status).toBe("running");
    expect(handoff.type).toBe("handoff");
    if (handoff.type !== "handoff") {
      throw new Error("expected handoff");
    }
    expect(handoff.toProviderInstanceId).toBe("claudeAgent");
    expect(fork.type).toBe("fork");
  });

  it("exports the V2 branded ids through the public contracts entrypoint", () => {
    expect(ThreadId.make("thread-1")).toBe("thread-1");
    expect(ProjectId.make("project-1")).toBe("project-1");
    expect(MessageId.make("message-1")).toBe("message-1");
    expect(NodeId.make("node-1")).toBe("node-1");
    expect(ProviderThreadId.make("provider-thread-1")).toBe("provider-thread-1");
    expect(CheckpointRef.make("git-ref-1")).toBe("git-ref-1");
    expect(ContextTransferId.make("context-transfer-1")).toBe("context-transfer-1");
  });

  it("decodes historical provider-thread JSON without pendingBackgroundTasks as empty roster", () => {
    const providerThread = decodeOrchestrationV2ProviderThreadJson({
      id: "provider-thread-1",
      driver: "claude",
      providerInstanceId: "claudeAgent",
      providerSessionId: "provider-session-1",
      appThreadId: "thread-1",
      ownerNodeId: null,
      nativeThreadRef: {
        driver: "claude",
        nativeId: "native-session-1",
        strength: "strong",
      },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
    });

    expect(providerThread.pendingBackgroundTasks).toEqual([]);
    expect(providerThread.contextUsage).toBeNull();
    expect(providerThread.nativeMetadata).toBeNull();

    const runtimeThread = decodeOrchestrationV2ProviderThread({
      id: "provider-thread-2",
      driver: "claude",
      providerInstanceId: "claudeAgent",
      providerSessionId: null,
      appThreadId: "thread-2",
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(runtimeThread.pendingBackgroundTasks).toEqual([]);
    expect(runtimeThread.contextUsage).toBeNull();
    expect(runtimeThread.nativeMetadata).toBeNull();
  });

  it("decodes historical thread shell JSON without pendingBackgroundTasks as empty roster", () => {
    const shell = decodeOrchestrationV2ThreadShell({
      createdBy: "user",
      creationSource: "web",
      id: "thread-1",
      projectId: "project-1",
      title: "Thread",
      providerInstanceId: "claudeAgent",
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: "thread-1",
      },
      forkedFrom: null,
      activeProviderThreadId: "provider-thread-1",
      latestRunId: "run-1",
      activeRunId: null,
      status: "completed",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
    });

    expect(shell.pendingBackgroundTasks).toEqual([]);
  });
});

it("preserves tool cancellation and denial metadata through persisted and wire schemas", () => {
  for (const kind of ["cancelled", "denied", undefined]) {
    const item = decodeOrchestrationV2TurnItem({
      id: "tool-result",
      threadId: "thread",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "dynamic_tool",
      toolName: "task_status",
      input: { taskId: "child" },
      status: kind === "cancelled" ? "cancelled" : "failed",
      ...(kind === undefined ? {} : { toolNonExecutionKind: kind }),
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      output: "Tool did not execute",
    });
    const wire = encodeOrchestrationV2TurnItemJson(item);
    expect(wire.toolNonExecutionKind).toBe(kind);
    expect(decodeOrchestrationV2TurnItemJson(wire)).toEqual(item);
  }
});

it("round-trips typed notifications and keeps work outcome separate from item status", () => {
  const now = DateTime.makeUnsafe("2026-09-09T00:00:00Z");
  const base = {
    id: "notification",
    threadId: "parent",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    type: "notification",
    outcome: "failed",
    summary: "Build failed",
    detail: "Exit code 1",
  };
  for (const source of [
    { kind: "delegated_task", taskIds: ["task-1", "task-2"] },
    { kind: "delegated_task", taskIds: ["task-1"], childThreadId: "child" },
    { kind: "subagent", childThreadId: "child" },
    { kind: "subagent" },
    { kind: "command" },
    { kind: "monitor" },
    { kind: "background_task" },
  ]) {
    const runtime = decodeOrchestrationV2TurnItem({ ...base, source, updatedAt: now });
    const wire = encodeOrchestrationV2TurnItemJson(runtime);
    expect(decodeOrchestrationV2TurnItemJson(wire)).toEqual(runtime);
    expect(runtime).toMatchObject({ status: "completed", outcome: "failed", source });
    expect(runtime).not.toHaveProperty("messageId");
    expect(() =>
      decodeOrchestrationV2TurnItem({ ...base, source, summary: "", updatedAt: now }),
    ).toThrow();
  }
  // A known kind with fields that do not decode is a real defect, not a newer kind.
  expect(() =>
    decodeOrchestrationV2TurnItem({ ...base, source: { kind: "delegated_task" }, updatedAt: now }),
  ).toThrow();
  expect(() =>
    decodeOrchestrationV2TurnItem({
      ...base,
      source: { kind: "subagent", childThreadId: 7 },
      updatedAt: now,
    }),
  ).toThrow();
});

describe("background work kinds from older or newer servers", () => {
  const storedNotification = (source: unknown) => ({
    id: "notification",
    threadId: "parent",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-09-09T00:00:00.000Z",
    type: "notification",
    outcome: "completed",
    summary: "Background activity updated",
    source,
  });

  it("decodes notification sources stored before specific kinds existed", () => {
    const sourceOf = (source: unknown) => {
      const item = decodeOrchestrationV2TurnItemJson(storedNotification(source));
      return item.type === "notification" ? item.source : undefined;
    };
    expect(
      sourceOf({ kind: "background_task", nativeRef: { driver: "claude", nativeId: "task-1" } }),
    ).toEqual({ kind: "background_task" });
    expect(sourceOf({ kind: "background_command" })).toEqual({ kind: "command" });
    expect(sourceOf({ kind: "monitor" })).toEqual({ kind: "monitor" });
  });

  it("sends and stores sources that clients from before specific kinds still decode", () => {
    // The notification source schema clients shipped with before #13948. They
    // reject a kind outside it, which fails the whole thread load.
    const PreSpecificKindsNotification = Schema.Struct({
      type: Schema.Literal("notification"),
      source: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("delegated_task"), taskIds: Schema.Array(NodeId) }),
        Schema.Struct({
          kind: Schema.Literals(["background_task", "background_command", "monitor"]),
          nativeRef: Schema.optional(Schema.Unknown),
        }),
      ]),
      outcome: Schema.Literals(["completed", "failed", "cancelled", "updated", "unknown"]),
      summary: Schema.String,
      detail: Schema.optional(Schema.String),
    });
    const decodePreSpecificKinds = Schema.decodeUnknownSync(PreSpecificKindsNotification);
    const sendOverWire = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2TurnItem));
    const cases = [
      [{ kind: "subagent", childThreadId: "child" }, { kind: "background_task" }],
      [{ kind: "subagent" }, { kind: "background_task" }],
      [{ kind: "command" }, { kind: "background_command" }],
      [{ kind: "monitor" }, { kind: "monitor" }],
      [{ kind: "background_task" }, { kind: "background_task" }],
      [
        { kind: "delegated_task", taskIds: ["task-1"], childThreadId: "child" },
        { kind: "delegated_task", taskIds: ["task-1"] },
      ],
    ] as const;
    for (const [source, preSpecificKindsSource] of cases) {
      const item = decodeOrchestrationV2TurnItemJson(storedNotification(source));
      for (const encoded of [encodeOrchestrationV2TurnItemJson(item), sendOverWire(item)]) {
        expect(decodePreSpecificKinds(encoded).source).toEqual(preSpecificKindsSource);
        // Current clients read the specific kind back.
        expect(decodeOrchestrationV2TurnItemJson(encoded)).toEqual(item);
      }
      expect(item).toMatchObject({ source });
    }
  });

  it("decodes a notification source kind from a newer server as generic background work", () => {
    const item = decodeOrchestrationV2TurnItemJson(
      storedNotification({ kind: "workflow", workflowId: "wf-1" }),
    );
    expect(item).toMatchObject({ type: "notification", source: { kind: "background_task" } });
  });

  it("decodes rosters stored before kinds existed, and kinds from a newer server, as generic tasks", () => {
    const providerThread = decodeOrchestrationV2ProviderThreadJson({
      id: "provider-thread-1",
      driver: "claude",
      providerInstanceId: "claudeAgent",
      providerSessionId: null,
      appThreadId: "thread-1",
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      pendingBackgroundTasks: [
        { taskId: "bg-1", description: "Background sleep", taskType: "local_bash" },
        { taskId: "bg-2" },
        { taskId: "bg-3", description: "Nightly", kind: "workflow", schedule: "0 3 * * *" },
        { taskId: "bg-4", description: "npm test", kind: "command" },
        { taskId: "bg-5", kind: "subagent", childThreadId: "thread-child" },
      ],
    });
    expect(providerThread.pendingBackgroundTasks).toEqual([
      { taskId: "bg-1", description: "Background sleep", kind: "background_task" },
      { taskId: "bg-2", kind: "background_task" },
      { taskId: "bg-3", description: "Nightly", kind: "background_task" },
      { taskId: "bg-4", description: "npm test", kind: "command" },
      { taskId: "bg-5", kind: "subagent", childThreadId: "thread-child" },
    ]);
    // The fallback is decode-only: what was decoded encodes as its known member.
    const encoded = encodeOrchestrationV2ProviderThreadJson(providerThread).pendingBackgroundTasks;
    expect(encoded).toEqual(providerThread.pendingBackgroundTasks);
    // Clients from before kinds read a roster entry as this struct and ignore `kind`.
    const decodePreKindsRoster = Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({
          taskId: TrimmedNonEmptyString,
          description: Schema.optional(TrimmedNonEmptyString),
          taskType: Schema.optional(TrimmedNonEmptyString),
        }),
      ),
    );
    expect(decodePreKindsRoster(encoded).map((task) => task.taskId)).toEqual([
      "bg-1",
      "bg-2",
      "bg-3",
      "bg-4",
      "bg-5",
    ]);
    expect(() =>
      decodeOrchestrationV2ProviderThreadJson({
        ...encodeOrchestrationV2ProviderThreadJson(providerThread),
        pendingBackgroundTasks: [{ taskId: "", kind: "command" }],
      }),
    ).toThrow();
  });
});

describe("limit recovery choice updates", () => {
  const decode = Schema.decodeUnknownSync(OrchestrationV2LimitRecoveryUpdate);
  const identity = { runId: "run:limited", resetAt: "2026-09-20T21:00:00.000Z" };
  it("rejects updates that would disable defaults without choosing an option", () => {
    expect(() => decode(identity)).toThrow("A recovery update must include autoResume or snooze");
  });
  it.each([
    { autoResume: true },
    { autoResume: false },
    { snooze: true },
    { snooze: false },
    { autoResume: true, snooze: false },
  ])("accepts an explicit independent choice %j", (choice) => {
    expect(decode({ ...identity, ...choice })).toEqual({ ...identity, ...choice });
  });
});

describe("latestProviderTurnForAttempt", () => {
  it("returns the attempt's highest-ordinal turn, as a Codex goal run spans several", () => {
    const turns = [
      { id: "first", runAttemptId: RunAttemptId.make("goal-attempt"), ordinal: 3 },
      { id: "other", runAttemptId: RunAttemptId.make("other-attempt"), ordinal: 9 },
      { id: "last", runAttemptId: RunAttemptId.make("goal-attempt"), ordinal: 5 },
      { id: "subagent", runAttemptId: null, ordinal: 7 },
    ];
    expect(latestProviderTurnForAttempt(turns, RunAttemptId.make("goal-attempt"))?.id).toBe("last");
    expect(latestProviderTurnForAttempt(turns, null)).toBeUndefined();
  });
});
