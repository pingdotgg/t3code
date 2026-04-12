import { describe, expect, it } from "vitest";

import { buildLinearExecutionPrompt, buildLinearLifecycleReply } from "./replies.ts";

describe("linear reply helpers", () => {
  it("builds an execution prompt from the trigger comment", () => {
    const prompt = buildLinearExecutionPrompt({
      issueId: "issue-123",
      linearThreadKey: "linear:issue-123:c:comment-9",
      messageId: "comment-9",
      authorName: "Vivek",
      body: "@Engineering please fix this bug",
      commentUrl: "https://linear.app/affil/issue/ENG-1/comment/comment-9",
    });

    expect(prompt).toContain("Issue ID: issue-123");
    expect(prompt).toContain("Trigger comment ID: comment-9");
    expect(prompt).toContain("@Engineering please fix this bug");
  });

  it("builds a deterministic completion reply", () => {
    const reply = buildLinearLifecycleReply({
      status: "completed",
      executionRunId: "run-123",
      t3ThreadId: "thread-456",
    });

    expect(reply).toContain("T3 finished this run.");
    expect(reply).toContain("`run-123`");
    expect(reply).toContain("`thread-456`");
  });
});
