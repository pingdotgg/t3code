import { describe, expect, it } from "vite-plus/test";

import { buildKnowledgeCandidatesPrompt, buildThreadTitlePrompt } from "./textGenerationPrompts.ts";
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

it("preserves each run boundary and terminal outcome in family review prompts", () => {
  const { prompt } = buildKnowledgeCandidatesPrompt({
    runOutcome: "completed",
    messages: [
      {
        ref: "M1",
        role: "user",
        text: "Keep the API stable.",
        threadId: "root",
        runId: "run-a",
        runOutcome: "interrupted",
      },
      {
        ref: "M2",
        role: "assistant",
        text: "Checked compatibility.",
        threadId: "child",
        runId: "run-b",
        runOutcome: "completed",
      },
    ],
  });
  expect(prompt).toContain("[M1] user (T1/R1, interrupted):\nKeep the API stable.");
  expect(prompt).toContain("[M2] assistant (T2/R2, completed):\nChecked compatibility.");
});

describe("buildThreadTitlePrompt", () => {
  it("names the project to leave out of initial and regenerated titles", () => {
    for (const previousTitle of [undefined, "Hyperdrive Config Crash"]) {
      const { prompt } = buildThreadTitlePrompt({
        message: "hyperdrive init crashes without a config",
        previousTitle,
        projectTitle: "Hyperdrive",
      });
      expect(prompt).toContain('Never include the project name ("Hyperdrive")');
    }
  });
});
