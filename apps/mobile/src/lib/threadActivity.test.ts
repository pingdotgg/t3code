import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadFeed,
  deriveThreadFeedPresentation,
  type ThreadFeedActivity,
  type ThreadFeedEntry,
} from "./threadActivity";

const threadId = ThreadId.make("thread-1");
const sourceThreadId = ThreadId.make("thread-source");
const runId = RunId.make("run-1");

function base(id: string, updatedAt: string, ordinal: number) {
  const timestamp = DateTime.makeUnsafe(updatedAt);
  return {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
  };
}

function projected(
  item: OrchestrationV2TurnItem,
  position: number,
  visibility: OrchestrationV2ProjectedTurnItem["visibility"] = "local",
): OrchestrationV2ProjectedTurnItem {
  return {
    position,
    visibility,
    sourceThreadId: visibility === "local" ? threadId : sourceThreadId,
    sourceItemId: item.id,
    item,
  };
}

function userMessage(updatedAt = "2026-06-20T00:00:01.000Z") {
  return {
    ...base("item-user", updatedAt, 0),
    type: "user_message" as const,
    messageId: MessageId.make("message-user"),
    createdBy: "user" as const,
    creationSource: "mobile" as const,
    inputIntent: "turn_start" as const,
    text: "Run checks",
    attachments: [],
  };
}

function command(updatedAt = "2026-06-20T00:00:02.000Z") {
  return {
    ...base("item-command", updatedAt, 1),
    type: "command_execution" as const,
    input: "vp check",
    output: "ok",
    exitCode: 0,
  };
}

function assistantMessage(updatedAt = "2026-06-20T00:00:03.000Z") {
  return {
    ...base("item-assistant", updatedAt, 2),
    type: "assistant_message" as const,
    messageId: MessageId.make("message-assistant"),
    text: "Done",
    streaming: false,
  };
}

describe("buildThreadFeed", () => {
  it("preserves authoritative V2 order instead of sorting reconstructed collections", () => {
    const rows = [
      projected(userMessage("2026-06-20T00:00:03.000Z"), 0),
      projected(command("2026-06-20T00:00:01.000Z"), 1),
      projected(assistantMessage("2026-06-20T00:00:02.000Z"), 2),
    ];

    const feed = buildThreadFeed(rows);
    expect(feed.map((entry) => entry.type)).toEqual(["message", "activity-group", "message"]);
    expect(feed.map((entry) => entry.id)).toEqual([
      "message-user",
      "local:thread-1:item-command",
      "message-assistant",
    ]);
    const activity = feed.find((entry) => entry.type === "activity-group")?.activities[0];
    expect(activity?.projectedItem).toBe(rows[1]);
    expect(activity?.fullDetail).toContain('"input": "vp check"');
  });

  it("retains inherited and synthetic rows with their original projected identity", () => {
    const inherited = projected(command(), 0, "inherited");
    const { providerThreadId: _providerThreadId, ...forkBase } = base(
      "item-fork",
      "2026-06-20T00:00:03.000Z",
      2,
    );
    const synthetic = projected(
      {
        ...forkBase,
        type: "fork",
        source: { type: "run", threadId: sourceThreadId, runId },
        targetThreadId: threadId,
      },
      1,
      "synthetic",
    );

    const feed = buildThreadFeed([inherited, synthetic]);
    const activities = feed.flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities : [],
    );
    expect(activities.map((activity) => activity.projectedItem)).toEqual([inherited, synthetic]);
    expect(activities.map((activity) => activity.projectedItem.visibility)).toEqual([
      "inherited",
      "synthetic",
    ]);
    expect(activities.at(-1)?.prominent).toBe(true);
  });

  it("keeps orchestration relationship cards visible when a completed run is folded", () => {
    const { providerThreadId: _providerThreadId, ...forkBase } = base(
      "item-fork",
      "2026-06-20T00:00:02.500Z",
      2,
    );
    const feed = buildThreadFeed([
      projected(userMessage(), 0),
      projected(command(), 1),
      projected(
        {
          ...forkBase,
          type: "fork",
          source: { type: "run", threadId, runId },
          targetThreadId: sourceThreadId,
        },
        2,
      ),
      projected(assistantMessage(), 3),
    ]);

    const collapsed = deriveThreadFeedPresentation(
      feed,
      {
        runId,
        status: "completed",
        startedAt: "2026-06-20T00:00:01.000Z",
        completedAt: "2026-06-20T00:00:03.000Z",
      },
      new Set(),
    );

    expect(
      collapsed.some(
        (entry) =>
          entry.type === "activity-group" &&
          entry.activities.some((activity) => activity.projectedItem.item.type === "fork"),
      ),
    ).toBe(true);
    expect(
      collapsed.some(
        (entry) =>
          entry.type === "activity-group" &&
          entry.activities.some(
            (activity) => activity.projectedItem.item.type === "command_execution",
          ),
      ),
    ).toBe(false);
  });

  it("folds settled V2 run work while keeping the terminal assistant message visible", () => {
    const feed = buildThreadFeed([
      projected(userMessage(), 0),
      projected(command(), 1),
      projected(assistantMessage(), 2),
    ]);
    const latestRun = {
      runId,
      status: "completed" as const,
      startedAt: "2026-06-20T00:00:01.000Z",
      completedAt: "2026-06-20T00:00:03.000Z",
    };

    const collapsed = deriveThreadFeedPresentation(feed, latestRun, new Set());
    expect(collapsed.map((entry) => entry.type)).toEqual(["message", "run-fold", "message"]);

    const expanded = deriveThreadFeedPresentation(feed, latestRun, new Set([runId]));
    expect(expanded.map((entry) => entry.type)).toEqual([
      "message",
      "run-fold",
      "activity-group",
      "message",
    ]);
  });

  it("keeps an active run expanded and marks failed tools as failures", () => {
    const failedCommand: OrchestrationV2TurnItem = {
      ...command(),
      status: "failed",
      completedAt: DateTime.makeUnsafe("2026-06-20T00:00:02.000Z"),
    };
    const feed = buildThreadFeed([projected(userMessage(), 0), projected(failedCommand, 1)]);
    const presented = deriveThreadFeedPresentation(
      feed,
      {
        runId,
        status: "running",
        startedAt: "2026-06-20T00:00:01.000Z",
        completedAt: null,
      },
      new Set(),
    );

    expect(presented.some((entry) => entry.type === "run-fold")).toBe(false);
    expect(presented.find((entry) => entry.type === "activity-group")?.activities[0]?.status).toBe(
      "failure",
    );
  });

  it("keeps work-log overflow inside grouped activity rows", () => {
    const activity = (
      id: string,
      createdAt: string,
      status: ThreadFeedActivity["status"] = "success",
    ): ThreadFeedActivity => ({
      id,
      createdAt,
      runId: null,
      summary: `Tool ${id}`,
      detail: null,
      fullDetail: null,
      copyText: id,
      icon: "command",
      toolLike: true,
      prominent: false,
      status,
      projectedItem: projected(command(createdAt), 0),
    });
    const feed: ThreadFeedEntry[] = [
      {
        type: "activity-group",
        id: "work-group-1",
        createdAt: "2026-04-01T00:00:01.000Z",
        runId: null,
        activities: [
          activity("activity-1", "2026-04-01T00:00:01.000Z"),
          activity("activity-neutral", "2026-04-01T00:00:02.000Z", "neutral"),
          activity("activity-2", "2026-04-01T00:00:03.000Z"),
          activity("activity-3", "2026-04-01T00:00:04.000Z"),
        ],
      },
    ];

    const presented = deriveThreadFeedPresentation(feed, null, new Set());
    expect(presented).toHaveLength(1);
    expect(presented[0]).toMatchObject({
      type: "activity-group",
      id: "work-group-1",
    });
    expect(
      presented[0]?.type === "activity-group"
        ? presented[0].activities.map((entry) => entry.id)
        : [],
    ).toEqual(["activity-1", "activity-neutral", "activity-2", "activity-3"]);
  });
});
