import { describe, expect, it } from "vite-plus/test";

import { parseCodexFeedbackCommand } from "./threadFeedback.ts";

describe("parseCodexFeedbackCommand", () => {
  it("accepts feedback without a reason", () => {
    expect(parseCodexFeedbackCommand(" /feedback ")).toEqual({});
  });

  it("preserves a feedback description", () => {
    expect(parseCodexFeedbackCommand("/feedback The agent stopped early.")).toEqual({
      reason: "The agent stopped early.",
    });
  });

  it("accepts mixed-case feedback commands", () => {
    expect(parseCodexFeedbackCommand("/Feedback Retry failed.")).toEqual({
      reason: "Retry failed.",
    });
  });

  it("ignores other slash commands and ordinary messages", () => {
    expect(parseCodexFeedbackCommand("/feedback-status")).toBeNull();
    expect(parseCodexFeedbackCommand("Please send /feedback")).toBeNull();
  });
});
