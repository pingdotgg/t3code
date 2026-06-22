import type { ThreadWorkEntry } from "@t3tools/client-runtime/state/shell";
import { MessageId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../test-fixtures";
import { buildThreadFeed, deriveThreadFeedPresentation } from "./threadActivity";

const runId = RunId.make("run-1");

function message(role: "user" | "assistant", text: string, createdAt: string, id: string) {
  return {
    id: MessageId.make(id),
    role,
    text,
    attachments: [],
    runId: role === "assistant" ? runId : null,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  } as const;
}

function commandEntry(overrides: Partial<ThreadWorkEntry> = {}): ThreadWorkEntry {
  const structuredPayload = {
    type: "command_execution",
    input: "vp check",
    output: "ok",
  } as ThreadWorkEntry["structuredPayload"];
  return {
    id: "item-1",
    createdAt: "2026-06-20T00:00:02.000Z",
    runId,
    label: "Ran command",
    command: "vp check",
    detail: "ok",
    tone: "tool",
    itemType: "command_execution",
    toolLifecycleStatus: "completed",
    structuredPayload,
    ...overrides,
  };
}

describe("buildThreadFeed", () => {
  it("orders V2 messages and work entries while retaining structured tool data", () => {
    const thread = makeThreadFixture({
      messages: [
        message("user", "Run checks", "2026-06-20T00:00:01.000Z", "message-user"),
        message("assistant", "Done", "2026-06-20T00:00:03.000Z", "message-assistant"),
      ],
      workEntries: [commandEntry()],
    });

    const feed = buildThreadFeed(thread);
    expect(feed.map((entry) => entry.type)).toEqual(["message", "activity-group", "message"]);
    const activity = feed.find((entry) => entry.type === "activity-group")?.activities[0];
    expect(activity?.runId).toBe(runId);
    expect(activity?.fullDetail).toContain('"input": "vp check"');
  });

  it("folds settled V2 run work while keeping the terminal assistant message visible", () => {
    const thread = makeThreadFixture({
      messages: [
        message("user", "Run checks", "2026-06-20T00:00:01.000Z", "message-user"),
        message("assistant", "Done", "2026-06-20T00:00:03.000Z", "message-assistant"),
      ],
      workEntries: [commandEntry()],
    });
    const feed = buildThreadFeed(thread);
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
    const thread = makeThreadFixture({
      messages: [message("user", "Run checks", "2026-06-20T00:00:01.000Z", "message-user")],
      workEntries: [commandEntry({ tone: "error", toolLifecycleStatus: "failed" })],
    });
    const feed = buildThreadFeed(thread);
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

  it("appends active work as a normal timeline row", () => {
    const startedAt = "2026-04-01T00:00:01.000Z";
    const presented = deriveThreadFeedPresentation([], null, new Set(), new Set(), startedAt);

    expect(presented).toEqual([
      {
        type: "working",
        id: "working-indicator-row",
        createdAt: startedAt,
      },
    ]);
    expect(deriveThreadFeedPresentation(presented, null, new Set())).toEqual([]);
  });

  it("models work-log overflow as list rows", () => {
    const activity = (
      id: string,
      createdAt: string,
      status: ThreadFeedActivity["status"] = "success",
    ): ThreadFeedActivity => ({
      id,
      createdAt,
      turnId: null,
      summary: `Tool ${id}`,
      detail: null,
      canExpand: false,
      getFullDetail: () => null,
      getCopyText: () => id,
      icon: "command",
      toolLike: true,
      status,
    });
    const feed: ThreadFeedEntry[] = [
      {
        type: "activity-group",
        id: "work-group-1",
        createdAt: "2026-04-01T00:00:01.000Z",
        turnId: null,
        activities: [
          activity("activity-1", "2026-04-01T00:00:01.000Z"),
          activity("activity-neutral", "2026-04-01T00:00:02.000Z", "neutral"),
          activity("activity-2", "2026-04-01T00:00:03.000Z"),
          activity("activity-3", "2026-04-01T00:00:04.000Z"),
        ],
      },
    ];

    const collapsed = deriveThreadFeedPresentation(feed, null, new Set());
    expect(collapsed.map((entry) => entry.id)).toEqual(["activity-3", "work-toggle:work-group-1"]);
    expect(collapsed[1]).toMatchObject({
      type: "work-toggle",
      groupId: "work-group-1",
      hiddenCount: 2,
      expanded: false,
    });

    const expanded = deriveThreadFeedPresentation(feed, null, new Set(), new Set(["work-group-1"]));
    expect(expanded.map((entry) => entry.id)).toEqual([
      "activity-1",
      "activity-2",
      "activity-3",
      "work-toggle:work-group-1",
    ]);
    expect(expanded.at(-1)).toMatchObject({
      type: "work-toggle",
      expanded: true,
    });
  });
});
