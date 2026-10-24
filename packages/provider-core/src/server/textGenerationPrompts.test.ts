import { describe, expect, it } from "vite-plus/test";

import { buildNextMessageSuggestionPrompt } from "./textGenerationPrompts.ts";
import { normalizeCliError } from "./textGenerationUtils.ts";

describe("normalizeCliError", () => {
  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});

describe("buildNextMessageSuggestionPrompt", () => {
  it("keeps the latest messages when the thread is longer than the prompt allows", () => {
    const latest = "ASSISTANT:\nShould I also update the changelog?";
    const { prompt } = buildNextMessageSuggestionPrompt({
      threadContext: `USER:\n${"x".repeat(10_000)}\n\n${latest}`,
    });

    expect(prompt).toContain("[Earlier content truncated]");
    expect(prompt).toContain(latest);
    expect(prompt).not.toContain("x".repeat(9_000));
  });

  it("asks for the user's message after the thread, so the model does not continue it", () => {
    const latest = "ASSISTANT:\nWould you like an example?";
    const { prompt } = buildNextMessageSuggestionPrompt({ threadContext: latest });

    expect(prompt.indexOf(latest)).toBeLessThan(prompt.indexOf("Write the USER's next message"));
  });
});
