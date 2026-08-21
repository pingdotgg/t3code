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
  ProjectId,
  ProviderInstanceId,
  ProviderReplayTranscript,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "./index.ts";
import {
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointScope,
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderThreadJson,
  OrchestrationV2DomainEventJson,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2Subagent,
  OrchestrationV2SubagentActivation,
  OrchestrationV2SubagentJson,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemJson,
  OrchestrationV2TurnItemStatus,
  isOrchestrationV2InternalSubagentThread,
  isOrchestrationV2UserFacingThread,
  orchestrationV2SubagentStatusAsTurnItemStatus,
} from "./orchestrationV2.ts";

const now = DateTime.makeUnsafe("2026-04-20T00:00:00.000Z");

describe("Orchestrator V2 thread visibility", () => {
  const rootId = ThreadId.make("thread:visibility:root");
  const rootLineage = {
    rootThreadId: rootId,
    parentThreadId: null,
    relationshipToParent: null,
  } as const;

  it("keeps roots and user forks visible", () => {
    expect(isOrchestrationV2UserFacingThread({ lineage: rootLineage, forkedFrom: null })).toBe(
      true,
    );
    expect(
      isOrchestrationV2InternalSubagentThread({
        lineage: {
          rootThreadId: rootId,
          parentThreadId: rootId,
          relationshipToParent: "fork",
        },
        forkedFrom: {
          type: "run",
          threadId: rootId,
          runId: RunId.make("run:visibility:fork"),
        },
      }),
    ).toBe(false);
  });

  it("hides explicit and node-owned subagent children", () => {
    expect(
      isOrchestrationV2InternalSubagentThread({
        lineage: {
          rootThreadId: rootId,
          parentThreadId: rootId,
          relationshipToParent: "subagent",
        },
        forkedFrom: null,
      }),
    ).toBe(true);
    expect(
      isOrchestrationV2InternalSubagentThread({
        lineage: rootLineage,
        forkedFrom: { type: "node", nodeId: NodeId.make("node:visibility:subagent") },
      }),
    ).toBe(true);
  });
});

const LegacyShellStreamItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("synchronized") }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationV2ShellSnapshot,
  }),
]);
const decodeLegacyShellStreamItem = Schema.decodeUnknownSync(LegacyShellStreamItem);
const decodeOrchestrationV2Command = Schema.decodeUnknownSync(OrchestrationV2Command);
const decodeOrchestrationV2TurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
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
const decodeOrchestrationV2ProviderThreadJson = Schema.decodeUnknownSync(
  OrchestrationV2ProviderThreadJson,
);
const decodeOrchestrationV2ProviderThread = Schema.decodeUnknownSync(OrchestrationV2ProviderThread);
const decodeOrchestrationV2ThreadShell = Schema.decodeUnknownSync(OrchestrationV2ThreadShell);
const decodeOrchestrationV2SubagentActivation = Schema.decodeUnknownSync(
  OrchestrationV2SubagentActivation,
);
const decodeOrchestrationV2DomainEventJson = Schema.decodeUnknownSync(
  OrchestrationV2DomainEventJson,
);
const decodeStoredOrchestrationV2Subagent = Schema.decodeUnknownSync(
  Schema.fromJsonString(OrchestrationV2SubagentJson),
);

describe("orchestration V2 contracts", () => {
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
      kind: "subagent",
      role: { name: "reviewer", source: "provider" },
      status: "idle",
      progress: "Inspecting package metadata",
      result: "Package is private.",
      usage: {
        totalTokens: 1200,
        inputTokens: 900,
        outputTokens: 300,
        toolUses: 2,
      },
      currentActivationId: null,
      activationCount: 2,
      workflow: null,
      workflowMembership: null,
      recentActivity: [{ at: now, summary: "Inspected package metadata" }],
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });
    const activation = decodeOrchestrationV2SubagentActivation({
      id: "node-subagent-1:activation:2",
      threadId: "thread-1",
      subagentId: subagent.id,
      runId: "run-1",
      providerTurnId: "provider-turn-1",
      ordinal: 2,
      status: "completed",
      usage: { totalTokens: 400 },
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });
    const {
      kind: _kind,
      role: _role,
      usage: _usage,
      currentActivationId: _currentActivationId,
      activationCount: _activationCount,
      workflow: _workflow,
      workflowMembership: _workflowMembership,
      recentActivity: _recentActivity,
      ...preObservabilitySubagent
    } = subagent;
    const decodedPreObservabilityEvent = decodeOrchestrationV2DomainEventJson({
      id: "event-pre-observability-subagent",
      type: "subagent.updated",
      threadId: "thread-1",
      runId: "run-1",
      nodeId: "node-subagent-1",
      driver: "codex",
      providerInstanceId: "codex",
      occurredAt: DateTime.formatIso(now),
      payload: {
        ...preObservabilitySubagent,
        startedAt: DateTime.formatIso(now),
        completedAt: DateTime.formatIso(now),
        updatedAt: DateTime.formatIso(now),
      },
    });
    const decodedActivityEvent = decodeOrchestrationV2DomainEventJson({
      id: "event-subagent-activity",
      type: "subagent.updated",
      threadId: "thread-1",
      runId: "run-1",
      nodeId: "node-subagent-1",
      driver: "codex",
      providerInstanceId: "codex",
      occurredAt: DateTime.formatIso(now),
      payload: {
        ...subagent,
        recentActivity: [
          {
            at: DateTime.formatIso(now),
            summary: "Inspected package metadata",
          },
        ],
        startedAt: DateTime.formatIso(now),
        completedAt: DateTime.formatIso(now),
        updatedAt: DateTime.formatIso(now),
      },
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
    expect(subagent.role).toEqual({ name: "reviewer", source: "provider" });
    expect(subagent.status).toBe("idle");
    expect(activation.ordinal).toBe(2);
    if (decodedPreObservabilityEvent.type !== "subagent.updated") {
      throw new Error("expected pre-observability subagent event");
    }
    expect(decodedPreObservabilityEvent.payload.recentActivity).toEqual([]);
    if (decodedActivityEvent.type !== "subagent.updated") {
      throw new Error("expected subagent activity event");
    }
    expect(DateTime.formatIso(decodedActivityEvent.payload.recentActivity[0]!.at)).toBe(
      DateTime.formatIso(now),
    );
    expect(turnItem.type).toBe("subagent");
    if (turnItem.type !== "subagent") throw new Error("expected subagent item");
    expect(turnItem.progress).toBe("Inspecting package metadata");
  });

  it("defaults every observability field a pre-upgrade row omits", () => {
    // Rows written before this schema carry none of the observability fields.
    // Each default below is what the projection reads back for such a row, so
    // no migration has to rewrite them in place: a stored row missing all
    // eight decodes to exactly this.
    const preObservabilityPayloadJson = JSON.stringify({
      id: "node-subagent-pre-observability",
      threadId: "thread-1",
      runId: "run-1",
      parentNodeId: "node-root-1",
      origin: "provider_native",
      createdBy: "agent",
      driver: "codex",
      providerInstanceId: "codex",
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: null,
      prompt: "Audit the parser.",
      title: "Parser audit",
      model: null,
      status: "completed",
      result: null,
      startedAt: DateTime.formatIso(now),
      completedAt: DateTime.formatIso(now),
      updatedAt: DateTime.formatIso(now),
    });

    // The projection reads stored rows through exactly this schema.
    const decoded = decodeStoredOrchestrationV2Subagent(preObservabilityPayloadJson);

    expect(decoded.kind).toBe("subagent");
    expect(decoded.role).toEqual({ name: "general-purpose", source: "app_default" });
    expect(decoded.usage).toBeNull();
    expect(decoded.currentActivationId).toBeNull();
    expect(decoded.activationCount).toBe(1);
    expect(decoded.workflow).toBeNull();
    expect(decoded.workflowMembership).toBeNull();
    expect(decoded.recentActivity).toEqual([]);
  });

  it("keeps run handles optional on the workflow struct", () => {
    const coordinatorRow = {
      id: "node-workflow-1",
      threadId: "thread-1",
      runId: "run-1",
      parentNodeId: "node-root-1",
      origin: "provider_native",
      createdBy: "agent",
      driver: "claudeAgent",
      providerInstanceId: "claudeAgent",
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: null,
      prompt: "Research the parser, then implement the fix.",
      title: "Research and implement",
      model: null,
      kind: "workflow",
      status: "running",
      result: null,
      startedAt: DateTime.formatIso(now),
      completedAt: null,
      updatedAt: DateTime.formatIso(now),
    };

    // Coordinator rows stored before run handles existed carry phases only
    // and must decode unchanged — no migration rewrites them.
    const phasesOnly = decodeStoredOrchestrationV2Subagent(
      JSON.stringify({
        ...coordinatorRow,
        workflow: { phases: [{ index: 0, title: "Research" }] },
      }),
    );
    expect(phasesOnly.workflow).toEqual({ phases: [{ index: 0, title: "Research" }] });

    const withHandles = decodeStoredOrchestrationV2Subagent(
      JSON.stringify({
        ...coordinatorRow,
        workflow: {
          phases: [{ index: 0, title: "Research" }],
          name: "research-implement",
          runId: "wf_run_1",
          scriptPath: "/tmp/workflows/research-implement.mjs",
          transcriptDir: "/tmp/projects/wf_run_1",
          sessionUrl: "https://claude.ai/session/1",
          warning: "workflow exceeded the size guideline",
        },
      }),
    );
    expect(withHandles.workflow).toEqual({
      phases: [{ index: 0, title: "Research" }],
      name: "research-implement",
      runId: "wf_run_1",
      scriptPath: "/tmp/workflows/research-implement.mjs",
      transcriptDir: "/tmp/projects/wf_run_1",
      sessionUrl: "https://claude.ai/session/1",
      warning: "workflow exceeded the size guideline",
    });
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
      subagentActivations: [],
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

  it("projects every subagent status onto a decodable turn item status", () => {
    // Regression guard for a bricked-server class of bug: a producer copied a
    // raw subagent status onto a timeline row, emitting a "turn-item.updated"
    // event that the domain schema could not decode. Nothing failed until the
    // next startup, where the projection rebuild died on the stored event and
    // the server could no longer boot at all.
    const subagentStatuses = OrchestrationV2Subagent.fields.status.literals;
    const turnItemStatuses = new Set<string>(OrchestrationV2TurnItemStatus.literals);

    for (const status of subagentStatuses) {
      const projected = orchestrationV2SubagentStatusAsTurnItemStatus[status];
      expect(
        turnItemStatuses.has(projected),
        `subagent status "${status}" projects to "${projected}", which a turn item cannot hold`,
      ).toBe(true);
    }

    // "idle" is the reusable-identity resting state and the one with no direct
    // timeline equivalent; it must collapse onto the finished activation.
    expect(subagentStatuses).toContain("idle");
    expect(turnItemStatuses.has("idle")).toBe(false);
    expect(orchestrationV2SubagentStatusAsTurnItemStatus.idle).toBe("completed");

    // Prove it end to end: the projected status decodes as a real event, and
    // the raw one is rejected — exactly the event that could not be read back.
    const base = {
      id: "turn-item:subagent-status-projection",
      threadId: "thread-1",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: "2026-07-27T00:00:00.000Z",
      type: "subagent",
      subagentId: "node-1",
      origin: "provider_native",
      driver: "codex",
      providerInstanceId: "codex",
      childThreadId: null,
      prompt: "",
      result: null,
    };
    const decode = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
    expect(() =>
      decode({ ...base, status: orchestrationV2SubagentStatusAsTurnItemStatus.idle }),
    ).not.toThrow();
    expect(() => decode({ ...base, status: "idle" })).toThrow();
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
