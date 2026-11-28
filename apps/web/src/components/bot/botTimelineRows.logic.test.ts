import { MessageId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import { computeStableMessagesTimelineRows } from "../chat/MessagesTimeline.logic";
import { deriveBotTimelineRows } from "./botTimelineRows.logic";

const runId = RunId.make("turn-1");
const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`;

const message = (
  id: string,
  role: "user" | "assistant",
  second: number,
  text = id,
): TimelineEntry => ({
  id,
  kind: "message",
  createdAt: at(second),
  message: {
    id: MessageId.make(id),
    role,
    text,
    runId: role === "user" ? null : runId,
    createdAt: at(second),
    updatedAt: at(second),
    streaming: false,
  },
});

const work = (
  id: string,
  second: number,
  fields: Partial<Extract<TimelineEntry, { kind: "work" }>["entry"]>,
): TimelineEntry => ({
  id,
  kind: "work",
  createdAt: at(second),
  entry: { id, createdAt: at(second), runId, label: id, tone: "tool", ...fields },
});

const running = {
  latestRun: { runId, status: "running" as const, startedAt: at(0), completedAt: null },
  isWorking: true,
};

describe("deriveBotTimelineRows", () => {
  it("shows a settled turn as your message and the Bot's final reply, never its setup prompt", () => {
    const rows = deriveBotTimelineRows({
      timelineEntries: [
        message("setup", "user", 0),
        message("ask", "user", 0),
        work("wake", 1, { itemType: "notification", tone: "info" }),
        work("thought", 2, { itemType: "reasoning", tone: "thinking" }),
        message("progress", "assistant", 3),
        work("read-thread", 4, {}),
        {
          id: "launched",
          kind: "event",
          createdAt: at(5),
          projectedItem: { item: { type: "thread_created", runId } } as never,
        },
        work("failed", 6, { itemType: "error", toolLifecycleStatus: "failed", tone: "error" }),
        message("reply", "assistant", 7),
      ],
      isWorking: false,
    });
    expect(rows.map((row) => row.id)).toEqual(["ask", "failed", "reply"]);
    expect(rows.at(-1)).toMatchObject({ botAvatar: true, showAssistantMeta: true });

    // A greeting Bot opens the chat by asking, before the user's first message.
    const greeted = deriveBotTimelineRows(
      { timelineEntries: [message("ask", "user", 0)], isWorking: false },
      { text: "What should I look after?", createdAt: at(0) },
    );
    expect(greeted.map((row) => row.id)).toEqual(["bot-greeting", "ask"]);
  });

  it("keeps a running turn's progress on the typing row, never in the chat", () => {
    const toolsOnly = deriveBotTimelineRows({
      timelineEntries: [
        message("setup", "user", 0),
        message("ask", "user", 0),
        work("read-thread", 1, {}),
      ],
      ...running,
    });
    expect(toolsOnly.map((row) => row.kind)).toEqual(["message", "bot-typing"]);
    expect(toolsOnly.at(-1)).not.toHaveProperty("detail");

    const progress = deriveBotTimelineRows({
      timelineEntries: [
        message("setup", "user", 0),
        message("ask", "user", 0),
        message(
          "progress",
          "assistant",
          1,
          "Starting.\n\nI'll read [the report](t3-thread://x) for `0.2.0`.",
        ),
      ],
      ...running,
    });
    expect(progress.map((row) => row.id)).toEqual(["ask", "bot-typing"]);
    expect(progress.at(-1)).toMatchObject({ detail: "I'll read the report for 0.2.0." });
    // A new progress line replaces the memoized typing row.
    const stable = computeStableMessagesTimelineRows(toolsOnly, { result: [], byId: new Map() });
    expect(computeStableMessagesTimelineRows(progress, stable).result).toEqual(progress);

    // The Bot's own pending approval stands in for the typing row.
    const approval = deriveBotTimelineRows({
      timelineEntries: [
        message("setup", "user", 0),
        message("ask", "user", 0),
        work("approve", 1, {
          projectedItem: { item: { type: "approval_request", requestId: "req-1" } } as never,
        }),
      ],
      pendingApprovalRequestIds: new Set(["req-1" as never]),
      ...running,
    });
    expect(approval.map((row) => row.id)).toEqual(["ask", "approve"]);
  });
});
