import { describe, expect, it } from "vite-plus/test";

import * as Schema from "effect/Schema";

import {
  buildThreadActivityPrompt,
  buildThreadTitlePrompt,
  sanitizeThreadActivityLabel,
} from "./textGenerationPrompts.ts";
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

describe("thread activity", () => {
  it.each([
    ["  Sidebar status chip. ", "sidebar status"],
    ["fixing the android pairing reconnect flow", "fixing the"],
    ['"auth"', "auth"],
    ["", null],
    ["...", null],
    [
      "supercalifragilisticexpialidocious extraordinarily long",
      "supercalifragilisticexpialidocious",
    ],
  ])("cleans activity labels: %j", (raw, expected) => {
    expect(sanitizeThreadActivityLabel(raw)).toBe(expected);
  });

  it("puts the digest and previous label in the prompt", () => {
    const { prompt, outputSchema } = buildThreadActivityPrompt({
      digest: "ran ./gradlew assembleDebug",
      previous: { phase: "implementing", label: "pairing flow" },
    });

    expect(prompt).toContain("ran ./gradlew assembleDebug");
    expect(prompt).toContain("Previous phase: implementing");
    expect(prompt).toContain("Previous label: pairing flow");
    expect(Schema.decodeSync(outputSchema)({ phase: "testing", label: "gradle build" })).toEqual({
      phase: "testing",
      label: "gradle build",
    });
    expect(() => Schema.decodeUnknownSync(outputSchema)({ phase: "coding", label: "x" })).toThrow();
  });
});

describe("buildThreadTitlePrompt", () => {
  it("names the project to leave out and puts the user's instructions above the limits", () => {
    for (const previousTitle of [undefined, "Hyperdrive Config Crash"]) {
      const { prompt } = buildThreadTitlePrompt({
        message: "hyperdrive init crashes without a config",
        previousTitle,
        projectTitle: "Hyperdrive",
        instructions: "Prefix every title with the team name.",
      });
      expect(prompt).toContain('Never include the project name ("Hyperdrive")');
      expect(prompt).not.toContain("fewer than 40 characters");
      expect(prompt).toContain("Title instructions from the user:\nPrefix every title");
    }
    expect(buildThreadTitlePrompt({ message: "Fix login", instructions: " " }).prompt).toContain(
      "3-8 words, fewer than 40 characters.",
    );
  });
});
