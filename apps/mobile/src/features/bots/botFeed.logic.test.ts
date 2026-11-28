import { MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadFeedEntry, ThreadFeedLatestRun } from "../../lib/threadActivity";
import { createBotFeedDeriver } from "./botFeed.logic";

const runId = RunId.make("turn-1");
const threadId = ThreadId.make("bot");
const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`;

const message = (
  id: string,
  role: "user" | "assistant",
  second: number,
  text = id,
): ThreadFeedEntry => ({
  type: "message",
  id,
  createdAt: at(second),
  message: {
    id: MessageId.make(id),
    role,
    text,
    attachments: [],
    runId: role === "user" ? null : runId,
    streaming: false,
    visibility: "local",
    sourceThreadId: threadId,
    createdAt: at(second),
    updatedAt: at(second),
  },
});

const activity = (id: string, second: number, item: object, workEntry: object = {}) =>
  ({
    id,
    createdAt: at(second),
    workEntry: { id, createdAt: at(second), label: id, tone: "tool", ...workEntry },
    projectedItem: { item: { runId, ...item } },
  }) as never;

const group = (id: string, second: number, activities: ReadonlyArray<never>): ThreadFeedEntry => ({
  type: "activity-group",
  id,
  createdAt: at(second),
  runId,
  activities,
});

const running: ThreadFeedLatestRun = {
  runId,
  status: "running",
  startedAt: at(0),
  completedAt: null,
};

const settled = { latestRun: null, awaitingUser: false, greeting: null };

describe("createBotFeedDeriver", () => {
  it("shows a settled turn as your message and the Bot's final reply, never its setup prompt", () => {
    const failed = activity("failed", 6, {
      type: "error",
      status: "failed",
      failure: { class: "provider" },
    });
    const { rows, typing } = createBotFeedDeriver()(
      [
        message("setup", "user", 0),
        message("ask", "user", 0),
        group("tools", 1, [
          activity("wake", 1, { type: "notification" }),
          activity("thought", 2, { type: "reasoning" }),
        ]),
        message("progress", "assistant", 3),
        group("work", 4, [
          activity("launched", 5, { type: "thread_created" }),
          failed,
          activity("question", 6, { type: "user_input_request" }, { questionAnswer: {} }),
        ]),
        message("reply", "assistant", 7),
      ],
      settled,
    );
    expect(rows.map((row) => row.id)).toEqual(["ask", "work", "reply"]);
    expect(rows[1]).toMatchObject({ activities: [failed, { id: "question" }] });
    expect(typing).toBeNull();

    // A greeting Bot opens the chat by asking, before the user's first message.
    const greeted = createBotFeedDeriver()([message("ask", "user", 0)], {
      ...settled,
      greeting: { threadId, text: "What should I look after?", createdAt: at(0) },
    });
    expect(greeted.rows.map((row) => row.id)).toEqual(["bot-greeting", "ask"]);
  });

  it("keeps a running turn's progress on the typing row, never in the chat", () => {
    const derive = createBotFeedDeriver();
    const toolsOnly = derive(
      [
        message("setup", "user", 0),
        message("ask", "user", 0),
        group("tools", 1, [activity("read", 1, { type: "dynamic_tool" })]),
      ],
      { ...settled, latestRun: running },
    );
    expect(toolsOnly.rows.map((row) => row.id)).toEqual(["ask"]);
    expect(toolsOnly.typing).toEqual({ type: "bot-typing", id: "bot-typing", createdAt: at(0) });

    const progressFeed = [
      message("setup", "user", 0),
      message("ask", "user", 0),
      message(
        "progress",
        "assistant",
        1,
        "Starting.\n\nI'll read [the report](t3-thread://x) for `0.2.0`.",
      ),
    ];
    const progress = derive(progressFeed, { ...settled, latestRun: running });
    expect(progress.rows.map((row) => row.id)).toEqual(["ask"]);
    expect(progress.typing).toMatchObject({ detail: "I'll read the report for 0.2.0." });
    // The same line keeps the same row, so the list does not redraw it.
    expect(derive(progressFeed, { ...settled, latestRun: running }).typing).toBe(progress.typing);

    // A Bot waiting on your approval or answer is not typing.
    expect(
      derive(progressFeed, { ...settled, latestRun: running, awaitingUser: true }).typing,
    ).toBeNull();
  });
});
