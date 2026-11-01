import { describe, expect, it } from "vite-plus/test";

import { buildSkillTrialJudgePrompt } from "./textGenerationPrompts.ts";
import { normalizeCliError } from "./textGenerationUtils.ts";

describe("buildSkillTrialJudgePrompt", () => {
  it("is outcome-first, position-neutral, bounded, and permits unknown", () => {
    const built = buildSkillTrialJudgePrompt({
      taskPrompt: "Implement the requested change.",
      rubric: "Correctness and completeness.",
      responseA: {
        status: "completed",
        finalMessage: "a".repeat(9_000),
        changedFiles: Array.from({ length: 4 }, (_, index) => ({
          path: `a-${index}.ts`,
          diff: "d".repeat(5_000),
        })),
        toolFailures: 0,
      },
      responseB: {
        status: "failed",
        finalMessage: "B",
        changedFiles: [],
        toolFailures: 2,
      },
    });

    expect(built.prompt).toContain("Evaluate the actual outcome first");
    expect(built.prompt).toContain("Do not infer quality from response length");
    expect(built.prompt).toContain("Do not favor the first or second position");
    expect(built.prompt).toContain('Use "unknown"');
    expect(built.prompt).toContain('"finalMessage": "' + "a".repeat(8_000) + '"');
    expect(built.prompt).not.toContain("a".repeat(8_001));
    expect(built.prompt.match(/d{4000}/g)).toHaveLength(3);
  });
});

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
