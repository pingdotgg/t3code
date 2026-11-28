import { describe, expect, it } from "vite-plus/test";

import {
  feedbackConversationHint,
  feedbackPreviewFields,
  feedbackRequestDisplay,
  feedbackTraceLines,
  feedbackTraceSummary,
} from "./feedbackRequest.ts";

describe("feedbackRequestDisplay", () => {
  it("lets only the thread that asked answer, and names how each card ended", () => {
    expect(feedbackRequestDisplay({ feedbackStatus: "pending" }, "local")).toEqual({
      kind: "pending",
    });
    expect(feedbackRequestDisplay({ feedbackStatus: "pending" }, "inherited").kind).toBe(
      "pending-elsewhere",
    );
    expect(
      (["sent", "declined", "cancelled"] as const).map((feedbackStatus) =>
        feedbackRequestDisplay({ feedbackStatus }, "local"),
      ),
    ).toEqual([
      { kind: "answered", outcome: "sent", label: "Sent" },
      { kind: "answered", outcome: "not-sent", label: "Not sent" },
      { kind: "answered", outcome: "not-sent", label: "Closed without sending" },
    ]);
  });
});

describe("feedback preview", () => {
  it("shows every field that is sent, and each outline entry with its text", () => {
    const trace = {
      turns: 2,
      textTurns: 2,
      truncated: false,
      entries: [
        { turn: 1, type: "user" as const, length: 5, text: "Hello" },
        {
          turn: 1,
          type: "tool" as const,
          tool: "t3_thread_read",
          outcome: "error" as const,
          durationMs: 1_500,
        },
        { turn: 2, type: "user" as const, length: 1, text: "y" },
      ],
    };
    expect(
      feedbackPreviewFields({
        kind: "bug",
        subject: "t3_thread_read",
        expected: "Items.",
        actual: "None.",
        workaround: "",
        trace,
      }).map((field) => field.label),
    ).toEqual(["Kind", "About", "Expected", "Happened"]);
    expect(feedbackTraceLines(trace)).toEqual([
      { key: "0", line: "Turn 1 · You · 5 characters", text: "Hello" },
      { key: "1", line: "Turn 1 · t3_thread_read · error · 1.5 s" },
      { key: "2", line: "Turn 2 · You · 1 character", text: "y" },
    ]);
    // Text only in turn 4 of 5: the wording reaches back to it, not "the last turn".
    const older = {
      turns: 5,
      textTurns: 1,
      truncated: false,
      entries: [
        { turn: 4, type: "user" as const, length: 5, text: "Hello" },
        { turn: 5, type: "tool" as const, tool: "shell", outcome: "ok" as const },
      ],
    };
    expect(feedbackTraceSummary(older)).toBe(
      "Outline of 5 recent turns, message text of the last 2 turns",
    );
    expect(feedbackConversationHint(older)).toBe(
      "Adds the text of your messages and the agent's replies in the last 2 turns.",
    );
  });
});
