import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { backgroundWorkNotification, notificationTurnItem } from "./Notification.ts";

const childThreadId = ThreadId.make("thread:child");

describe("backgroundWorkNotification", () => {
  it("keeps the generic notification when nothing is known", () => {
    assert.isNull(backgroundWorkNotification([]));
  });

  it("names one piece of work and the thread of a subagent", () => {
    assert.deepEqual(
      backgroundWorkNotification([
        {
          kind: "subagent",
          label: "Review src/math.ts",
          outcome: "completed",
          childThreadId,
        },
      ]),
      {
        source: { kind: "subagent", childThreadId },
        outcome: "completed",
        summary: 'Subagent "Review src/math.ts" finished',
      },
    );
    assert.equal(
      backgroundWorkNotification([
        { kind: "command", label: "npm test\nnpm run lint", outcome: "failed", exitCode: 1 },
      ]).summary,
      'Command "npm test" failed (exit 1)',
    );
    assert.equal(
      backgroundWorkNotification([{ kind: "monitor", label: "Three ticks", outcome: "updated" }])
        .summary,
      'Monitor "Three ticks" reported new output',
    );
  });

  it("names every piece of work that ended together, without opening one of them", () => {
    const notification = backgroundWorkNotification([
      { kind: "subagent", label: "Agent B", outcome: "cancelled", childThreadId },
      { kind: "command", label: "Sleep 60 seconds", outcome: "cancelled" },
    ]);
    assert.deepEqual(notification, {
      source: { kind: "background_task" },
      outcome: "cancelled",
      summary: 'Subagent "Agent B" and command "Sleep 60 seconds" were stopped',
    });
  });

  it("counts work it cannot list", () => {
    const reports = ["a", "b", "c", "d"].map((label) => ({
      kind: "subagent" as const,
      label,
      outcome: "completed" as const,
    }));
    assert.deepEqual(backgroundWorkNotification(reports), {
      source: { kind: "subagent" },
      outcome: "completed",
      summary: "4 subagents finished",
    });
  });
});

describe("notificationTurnItem", () => {
  const now = DateTime.makeUnsafe("2026-09-27T00:00:00.000Z");
  const threadId = ThreadId.make("thread:parent");
  const parentRunId = RunId.make("run:parent");
  const userMessage: OrchestrationV2TurnItem = {
    id: TurnItemId.make("item:delivery"),
    threadId,
    runId: RunId.make("run:delivery"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "user_message",
    messageId: MessageId.make("message:delivery"),
    inputIntent: "turn_start",
    text: "Delegated tasks reached terminal states.",
    attachments: [],
    createdBy: "agent",
    creationSource: "server",
  };
  const task = (id: string, title: string, status: OrchestrationV2Subagent["status"]) =>
    ({
      id: NodeId.make(id),
      runId: parentRunId,
      origin: "app_owned",
      title,
      prompt: `${title} prompt`,
      status,
      childThreadId: ThreadId.make(`thread:${id}`),
    }) as OrchestrationV2Subagent;
  const delivery = (taskIds: ReadonlyArray<string>) => ({
    delegatedCompletion: {
      parentRunId,
      generation: 1,
      taskIds: taskIds.map((taskId) => NodeId.make(taskId)),
    },
  });
  const tasks = [
    task("a", "Review src/math.ts", "completed"),
    task("b", "Write tests", "completed"),
    task("c", "Update docs", "running"),
  ];

  it("says how many of a run's delegated tasks a delivery reports", () => {
    const item = notificationTurnItem(userMessage, delivery(["a", "b"]), tasks);
    assert.equal(item.type, "notification");
    if (item.type !== "notification") return;
    assert.equal(item.summary, "2 of 3 delegated tasks finished: Review src/math.ts, Write tests");
    assert.deepEqual(item.source, {
      kind: "delegated_task",
      taskIds: [NodeId.make("a"), NodeId.make("b")],
    });
  });

  it("opens the child thread of a single delegated task", () => {
    const item = notificationTurnItem(userMessage, delivery(["a"]), tasks);
    assert.deepInclude(item, {
      type: "notification",
      summary: 'Delegated task "Review src/math.ts" finished',
      source: {
        kind: "delegated_task",
        taskIds: [NodeId.make("a")],
        childThreadId: ThreadId.make("thread:a"),
      },
    });
  });
});
