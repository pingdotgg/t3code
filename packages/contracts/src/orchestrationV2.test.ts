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
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "./orchestrationV2.ts";

const now = DateTime.makeUnsafe("2026-04-20T00:00:00.000Z");
const decodeOrchestrationV2Command = Schema.decodeUnknownSync(OrchestrationV2Command);
const decodeOrchestrationV2TurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);

describe("orchestration V2 contracts", () => {
  it("decodes nested checkpoint scopes without making child scopes advance app run count", () => {
    const rootScope = Schema.decodeUnknownSync(OrchestrationV2CheckpointScope)({
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
    const childScope = Schema.decodeUnknownSync(OrchestrationV2CheckpointScope)({
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
    const checkpoint = Schema.decodeUnknownSync(OrchestrationV2Checkpoint)({
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
    const event = Schema.decodeUnknownSync(OrchestrationV2DomainEvent)({
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
    const transcript = Schema.decodeUnknownSync(ProviderReplayTranscript)({
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
    const fileChange = Schema.decodeUnknownSync(OrchestrationV2TurnItem)({
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
    const dynamicTool = Schema.decodeUnknownSync(OrchestrationV2TurnItem)({
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
    const errorItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem)({
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
      Schema.decodeUnknownSync(OrchestrationV2TurnItem)({
        ...errorItem,
        failure: { ...errorItem.failure, message: "x".repeat(4_097) },
      }),
    ).toThrow();
  });

  it("decodes provider-native subagent lifecycle records and timeline items", () => {
    const subagent = Schema.decodeUnknownSync(OrchestrationV2Subagent)({
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
    const turnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem)({
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

  it("decodes thread projections with an ordered turn item rendering stream", () => {
    const projection = Schema.decodeUnknownSync(OrchestrationV2ThreadProjection)({
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
  });

  it("decodes orchestration lifecycle turn items for compaction, handoff, and fork UI", () => {
    const compaction = Schema.decodeUnknownSync(OrchestrationV2TurnItem)({
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
    const handoff = Schema.decodeUnknownSync(OrchestrationV2TurnItem)({
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
    const fork = Schema.decodeUnknownSync(OrchestrationV2TurnItem)({
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
});
