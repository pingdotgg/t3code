import { EnvironmentId, MessageId, RunId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { presentThread, presentThreadShell } from "./models.ts";
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

  it("retains the complete projection while deriving conversation parity", () => {
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

    const thread = presentThread(environmentId, projection);
    expect(thread.projection).toBe(projection);
    expect(thread.latestRun?.runId).toBe(runId);
    expect(thread.runtime?.status).toBe("running");
    expect(thread.runs).toHaveLength(1);
    expect(thread.availableActions.canInterrupt).toBe(true);
    expect(thread.messages[0]).toMatchObject({ text: "Hello", runId });
  });

  it("keeps the complete payload for generic V2 work-item rendering", () => {
    const now = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
    const item = {
      id: TurnItemId.make("item-dynamic"),
      threadId: v2Projection.thread.id,
      runId: null,
      nodeId: null,
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
      type: "dynamic_tool" as const,
      toolName: "custom_tool",
      input: { nested: { value: 1 } },
      output: { ok: true },
    };
    const projection = {
      ...v2Projection,
      turnItems: [item],
      visibleTurnItems: [
        {
          position: 0,
          visibility: "local" as const,
          sourceThreadId: v2Projection.thread.id,
          sourceItemId: item.id,
          item,
        },
      ],
      updatedAt: now,
    };

    const thread = presentThread(environmentId, projection);
    expect(thread.workEntries[0]).toMatchObject({
      itemType: "dynamic_tool",
      label: "custom_tool",
      structuredPayload: item,
    });
  });
});
