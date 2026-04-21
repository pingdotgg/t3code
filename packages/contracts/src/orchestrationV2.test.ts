import { describe, expect, it } from "vitest";
import { DateTime, Schema } from "effect";

import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
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
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "./orchestrationV2.ts";

const now = DateTime.fromDateUnsafe(new Date("2026-04-20T00:00:00.000Z"));

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
    const command = Schema.decodeUnknownSync(OrchestrationV2Command)({
      type: "message.dispatch",
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
        provider: "codex",
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
    expect(event.payload.id).toBe(RunId.make("run-1"));
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
      runtimeItemId: "runtime-item-1",
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
      runtimeItemId: "runtime-item-2",
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

  it("decodes thread projections with an ordered turn item rendering stream", () => {
    const projection = Schema.decodeUnknownSync(OrchestrationV2ThreadProjection)({
      thread: {
        id: "thread-1",
        projectId: "project-1",
        title: "Thread",
        defaultProvider: "codex",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
      },
      runs: [],
      attempts: [],
      nodes: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      runtimeItems: [],
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
          runtimeItemId: "runtime-item-command-1",
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
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
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
      runtimeItemId: null,
      parentItemId: null,
      ordinal: 5,
      status: "running",
      title: "Compacting context...",
      provider: "codex",
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
      runtimeItemId: null,
      parentItemId: null,
      ordinal: 6,
      status: "completed",
      title: "Handed off to Claude",
      contextHandoffId: "handoff-1",
      fromProviderThreadIds: ["provider-thread-codex-1"],
      toProviderThreadId: "provider-thread-claude-1",
      fromProviders: ["codex"],
      toProvider: "claudeAgent",
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
      runtimeItemId: null,
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
    expect(handoff.toProvider).toBe("claudeAgent");
    expect(fork.type).toBe("fork");
  });

  it("exports the V2 branded ids through the public contracts entrypoint", () => {
    expect(ThreadId.make("thread-1")).toBe("thread-1");
    expect(ProjectId.make("project-1")).toBe("project-1");
    expect(MessageId.make("message-1")).toBe("message-1");
    expect(NodeId.make("node-1")).toBe("node-1");
    expect(ProviderThreadId.make("provider-thread-1")).toBe("provider-thread-1");
    expect(CheckpointRef.make("git-ref-1")).toBe("git-ref-1");
  });
});
