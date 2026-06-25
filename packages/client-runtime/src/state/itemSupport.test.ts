import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { EMPTY_V2_ITEM_SUPPORT, resolveV2ItemSupport, v2ItemSupportEqual } from "./itemSupport.ts";

const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const runId = RunId.make("run-1");
const nodeId = NodeId.make("node-1");
const itemId = TurnItemId.make("item-1");
const requestId = RuntimeRequestId.make("request-1");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerThreadId = ProviderThreadId.make("provider-thread-1");
const providerTurnId = ProviderTurnId.make("provider-turn-1");

const commandItem: OrchestrationV2TurnItem = {
  id: itemId,
  threadId: v2ThreadId,
  runId,
  nodeId,
  providerThreadId,
  providerTurnId,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "running",
  title: null,
  startedAt: now,
  completedAt: null,
  updatedAt: now,
  type: "command_execution",
  input: "vp check",
};

describe("resolveV2ItemSupport", () => {
  it("retains identity while linking a turn item to its execution and provider entities", () => {
    const run = {
      id: runId,
      threadId: v2ThreadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
      providerThreadId,
      userMessageId: "message-1" as never,
      rootNodeId: nodeId,
      activeAttemptId: RunAttemptId.make("attempt-2"),
      status: "running" as const,
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    const attempts = [
      {
        id: RunAttemptId.make("attempt-1"),
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId,
        providerTurnId,
        reason: "initial" as const,
        status: "superseded" as const,
        startedAt: now,
        completedAt: now,
      },
      {
        id: RunAttemptId.make("attempt-2"),
        runId,
        attemptOrdinal: 2,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId,
        providerTurnId,
        reason: "steering_restart" as const,
        status: "running" as const,
        startedAt: now,
        completedAt: null,
      },
    ];
    const node = {
      id: nodeId,
      threadId: v2ThreadId,
      runId,
      parentNodeId: null,
      rootNodeId: nodeId,
      kind: "tool_call" as const,
      status: "running" as const,
      countsForRun: true,
      providerThreadId,
      providerTurnId,
      nativeItemRef: null,
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    };
    const providerThread = {
      id: providerThreadId,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId,
      providerSessionId: null,
      appThreadId: v2ThreadId,
      ownerNodeId: nodeId,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "active" as const,
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    };
    const providerTurn = {
      id: providerTurnId,
      providerThreadId,
      nodeId,
      runAttemptId: attempts[1]!.id,
      nativeTurnRef: null,
      ordinal: 1,
      status: "running" as const,
      startedAt: now,
      completedAt: null,
    };
    const runtimeRequest = {
      id: requestId,
      nodeId,
      providerTurnId,
      nativeRequestRef: null,
      kind: "dynamic_tool_call" as const,
      status: "pending" as const,
      responseCapability: {
        type: "live" as const,
        providerSessionId: ProviderSessionId.make("session-1"),
      },
      createdAt: now,
      resolvedAt: null,
    };
    const projection = {
      ...v2Projection,
      runs: [run],
      attempts,
      nodes: [node],
      providerThreads: [providerThread],
      providerTurns: [providerTurn],
      runtimeRequests: [runtimeRequest],
      turnItems: [commandItem],
    };

    const support = resolveV2ItemSupport(projection, itemId);
    expect(support.item).toBe(commandItem);
    expect(support.run).toBe(run);
    expect(support.attempts).toEqual(attempts);
    expect(support.attempts[0]).toBe(attempts[0]);
    expect(support.node).toBe(node);
    expect(support.providerThread).toBe(providerThread);
    expect(support.providerTurn).toBe(providerTurn);
    expect(support.runtimeRequest).toBe(runtimeRequest);
  });

  it("resolves synthetic items from the authoritative visible sequence", () => {
    const projection = {
      ...v2Projection,
      visibleTurnItems: [
        {
          position: 0,
          visibility: "synthetic" as const,
          sourceThreadId: v2ThreadId,
          sourceItemId: itemId,
          item: commandItem,
        },
      ],
    };
    expect(resolveV2ItemSupport(projection, itemId).item).toBe(commandItem);
  });

  it("returns the stable empty support for unknown items", () => {
    expect(resolveV2ItemSupport(v2Projection, itemId)).toBe(EMPTY_V2_ITEM_SUPPORT);
  });

  it("compares support structurally while retaining entity identity semantics", () => {
    expect(v2ItemSupportEqual(EMPTY_V2_ITEM_SUPPORT, { ...EMPTY_V2_ITEM_SUPPORT })).toBe(true);
    expect(
      v2ItemSupportEqual(EMPTY_V2_ITEM_SUPPORT, {
        ...EMPTY_V2_ITEM_SUPPORT,
        attempts: [{ id: "attempt" } as never],
      }),
    ).toBe(false);
  });
});
