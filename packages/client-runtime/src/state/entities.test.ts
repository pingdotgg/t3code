import {
  EnvironmentId,
  MessageId,
  NodeId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadShell } from "./models.ts";
import { deriveLatestThreadRun, deriveThreadRuntime } from "./threadExecution.ts";
import { derivePendingThreadRequests } from "./threadRequests.ts";
import { v2Projection, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

const environmentId = EnvironmentId.make("environment-v2");

describe("V2 client presentation", () => {
  it("presents shell timestamps and status without constructing V1 state", () => {
    const shell = presentThreadShell(environmentId, v2ThreadShell);
    expect(shell.environmentId).toBe(environmentId);
    expect(shell.createdAt).toBe("2026-06-20T00:00:00.000Z");
    expect(shell.runtime).toBeNull();
    expect(shell.source).toBe(v2ThreadShell);
  });

  it("derives execution summaries without wrapping or copying the projection", () => {
    const runId = RunId.make("run-1");
    const now = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
    const projection = {
      ...v2Projection,
      runs: [
        {
          id: runId,
          threadId: v2Projection.thread.id,
          ordinal: 1,
          providerInstanceId: v2Projection.thread.providerInstanceId,
          modelSelection: v2Projection.thread.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message-user"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "running" as const,
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      ],
      messages: [
        {
          id: MessageId.make("message-user"),
          threadId: v2Projection.thread.id,
          runId,
          nodeId: null,
          role: "user" as const,
          text: "Hello",
          attachments: [],
          streaming: false,
          createdBy: "user" as const,
          creationSource: "web" as const,
          createdAt: now,
          updatedAt: now,
        },
      ],
      updatedAt: now,
    };

    expect(deriveLatestThreadRun(projection)).toMatchObject({
      runId,
      status: "running",
      requestedAt: "2026-06-20T01:00:00.000Z",
      assistantMessageId: null,
    });
    expect(deriveThreadRuntime(projection)).toMatchObject({
      status: "running",
      activeRunId: runId,
      providerInstanceId: projection.thread.providerInstanceId,
    });
  });

  it("joins pending request entities to their native turn-item display data", () => {
    const now = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
    const requestId = RuntimeRequestId.make("request-approval");
    const item = {
      id: TurnItemId.make("item-approval"),
      threadId: v2Projection.thread.id,
      runId: null,
      nodeId: NodeId.make("node-root"),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "approval_request" as const,
      requestId,
      requestKind: "command" as const,
      prompt: "Allow command?",
    };
    const projection = {
      ...v2Projection,
      runtimeRequests: [
        {
          id: requestId,
          nodeId: NodeId.make("node-root"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "command" as const,
          status: "pending" as const,
          responseCapability: {
            type: "not_resumable" as const,
            reason: "provider disconnected",
          },
          createdAt: now,
          resolvedAt: null,
        },
      ],
      turnItems: [item],
      updatedAt: now,
    };

    expect(derivePendingThreadRequests(projection).approvals).toEqual([
      {
        requestId,
        requestKind: "command",
        createdAt: "2026-06-20T01:00:00.000Z",
        detail: "Allow command?",
        responseCapability: "not_resumable",
      },
    ]);
    expect(derivePendingThreadRequests(projection).userInputs).toEqual([]);
  });
});
