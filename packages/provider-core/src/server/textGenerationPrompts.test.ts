import { describe, expect, it } from "vite-plus/test";

import { buildThreadTitlePrompt } from "./textGenerationPrompts.ts";
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

  it("lets the user's title instructions override the word and length limits", () => {
    const scheme = 'Title every thread "Owner: what it does (model effort)".';
    for (const previousTitle of [undefined, "Old title"]) {
      const { prompt } = buildThreadTitlePrompt({
        message: "Relay chat messages to the lead agent",
        previousTitle,
        instructions: scheme,
      });
      expect(prompt).toMatch(
        /conflict with the editorial rules above, including the word and character limits, follow these instead:\n.*Owner: what it does/,
      );
    }
    const { prompt } = buildThreadTitlePrompt({ message: "Fix login", instructions: "  " });
    expect(prompt).not.toContain("follow these instead");
  });
});
