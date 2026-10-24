import { describe, expect, it } from "vite-plus/test";

import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildProviderFailureExplanationPrompt,
  buildReviewGuidePrompt,
  buildThreadTitlePrompt,
} from "./textGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./textGenerationUtils.ts";
import { TextGenerationError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeExplanation = Schema.decodeUnknownSync(
  buildProviderFailureExplanationPrompt({ context: "" }).outputSchema,
);

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

describe("buildProviderFailureExplanationPrompt", () => {
  it("asks for a summary and a likely fix without inventing facts", () => {
    const result = buildProviderFailureExplanationPrompt({
      context: "Failure:\nClass: provider_error\nMessage: spawn codex ENOENT",
    });

    expect(result.prompt).toContain("summary and likelyFix");
    expect(result.prompt).toContain("Never invent");
    expect(result.prompt).toContain("uncertain");
    expect(result.prompt).toContain("No markdown headings");
    expect(result.prompt).toContain("untrusted data");
    expect(result.prompt).toContain("Do not use tools");
    expect(result.prompt).toContain("Message: spawn codex ENOENT");
    expect(decodeExplanation({ summary: "a", likelyFix: "b" })).toEqual({
      summary: "a",
      likelyFix: "b",
    });
    expect(() => decodeExplanation({ summary: "a" })).toThrow();
  });

  it("bounds an oversized context", () => {
    const result = buildProviderFailureExplanationPrompt({ context: "x".repeat(50_000) });

    expect(result.prompt.length).toBeLessThan(14_000);
    expect(result.prompt).toContain("[truncated]");
  });
});
