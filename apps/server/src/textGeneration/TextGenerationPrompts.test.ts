import { describe, expect, it } from "vite-plus/test";

import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildScenerySetPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeScenerySetResult,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import { TextGenerationError } from "@t3tools/contracts";

describe("buildCommitMessagePrompt", () => {
  it("includes staged patch and summary in the prompt", () => {
    const result = buildCommitMessagePrompt({
      branch: "main",
      stagedSummary: "M README.md",
      stagedPatch: "diff --git a/README.md b/README.md\n+hello",
      includeBranch: false,
    });

    expect(result.prompt).toContain("Staged files:");
    expect(result.prompt).toContain("M README.md");
    expect(result.prompt).toContain("Staged patch:");
    expect(result.prompt).toContain("diff --git a/README.md b/README.md");
    expect(result.prompt).toContain("Branch: main");
    // Should NOT include the branch generation instruction
    expect(result.prompt).not.toContain("branch must be a short semantic git branch fragment");
  });

  it("includes branch generation instruction when includeBranch is true", () => {
    const result = buildCommitMessagePrompt({
      branch: "feature/foo",
      stagedSummary: "M README.md",
      stagedPatch: "diff",
      includeBranch: true,
    });

    expect(result.prompt).toContain("branch must be a short semantic git branch fragment");
    expect(result.prompt).toContain("Return a JSON object with keys: subject, body, branch.");
  });

  it("shows (detached) when branch is null", () => {
    const result = buildCommitMessagePrompt({
      branch: null,
      stagedSummary: "M a.ts",
      stagedPatch: "diff",
      includeBranch: false,
    });

    expect(result.prompt).toContain("Branch: (detached)");
  });
});

describe("buildPrContentPrompt", () => {
  it("includes branch names, commits, and diff in the prompt", () => {
    const result = buildPrContentPrompt({
      baseBranch: "main",
      headBranch: "feature/auth",
      commitSummary: "feat: add login page",
      diffSummary: "3 files changed",
      diffPatch: "diff --git a/auth.ts b/auth.ts\n+export function login()",
    });

    expect(result.prompt).toContain("Base branch: main");
    expect(result.prompt).toContain("Head branch: feature/auth");
    expect(result.prompt).toContain("Commits:");
    expect(result.prompt).toContain("feat: add login page");
    expect(result.prompt).toContain("Diff stat:");
    expect(result.prompt).toContain("3 files changed");
    expect(result.prompt).toContain("Diff patch:");
    expect(result.prompt).toContain("export function login()");
  });
});

describe("buildBranchNamePrompt", () => {
  it("includes the user message in the prompt", () => {
    const result = buildBranchNamePrompt({
      message: "Fix the login timeout bug",
    });

    expect(result.prompt).toContain("User message:");
    expect(result.prompt).toContain("Fix the login timeout bug");
    expect(result.prompt).not.toContain("Attachment metadata:");
  });

  it("includes attachment metadata when attachments are provided", () => {
    const result = buildBranchNamePrompt({
      message: "Fix the layout from screenshot",
      attachments: [
        {
          type: "image" as const,
          id: "att-123",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 12345,
        },
      ],
    });

    expect(result.prompt).toContain("Attachment metadata:");
    expect(result.prompt).toContain("screenshot.png");
    expect(result.prompt).toContain("image/png");
    expect(result.prompt).toContain("12345 bytes");
  });
});

describe("buildThreadTitlePrompt", () => {
  it("includes the user message in the prompt", () => {
    const result = buildThreadTitlePrompt({
      message: "Investigate reconnect regressions after session restore",
    });

    expect(result.prompt).toContain("User message:");
    expect(result.prompt).toContain("Investigate reconnect regressions after session restore");
    expect(result.prompt).not.toContain("Attachment metadata:");
  });

  it("includes attachment metadata when attachments are provided", () => {
    const result = buildThreadTitlePrompt({
      message: "Name this thread from the screenshot",
      attachments: [
        {
          type: "image" as const,
          id: "att-456",
          name: "thread.png",
          mimeType: "image/png",
          sizeBytes: 67890,
        },
      ],
    });

    expect(result.prompt).toContain("Attachment metadata:");
    expect(result.prompt).toContain("thread.png");
    expect(result.prompt).toContain("image/png");
    expect(result.prompt).toContain("67890 bytes");
  });
});

describe("sanitizeThreadTitle", () => {
  it("truncates long titles with the shared sidebar-safe limit", () => {
    expect(
      sanitizeThreadTitle(
        '  "Reconnect failures after restart because the session state does not recover"  ',
      ),
    ).toBe("Reconnect failures after restart because the se...");
  });
});

describe("buildScenerySetPrompt", () => {
  it("includes the location and scenery output rules", () => {
    const result = buildScenerySetPrompt({ location: "Kyoto" });

    expect(result.prompt).toContain("Location: Kyoto");
    expect(result.prompt).toContain("locations");
    expect(result.prompt).toContain("queries");
    expect(result.prompt).toContain("dawn");
    expect(result.prompt).toContain("Unsplash");
    expect(result.prompt).toContain("Kirkjufell");
  });
});

describe("sanitizeScenerySetResult", () => {
  it("dedupes names/queries and drops invalid tags", () => {
    const result = sanitizeScenerySetResult({
      sceneNames: [" Fushimi Inari ", "fushimi inari", "Arashiyama", ""],
      queries: [
        { text: " kyoto temples ", timeOfDay: "dawn", season: "spring" },
        { text: "kyoto temples", timeOfDay: "midday", season: "fall" },
        { text: "  ", timeOfDay: "day" },
        { text: "kyoto winter mountains", season: "winter" },
      ],
    });

    expect(result.sceneNames).toEqual(["Fushimi Inari", "Arashiyama"]);
    expect(result.queries).toEqual([
      { text: "kyoto temples", timeOfDay: "dawn", season: "spring" },
      { text: "kyoto winter mountains", season: "winter" },
    ]);
    expect(result.locations).toBeUndefined();
  });

  it("derives sceneNames from locations and caps at 16", () => {
    const locations = Array.from({ length: 20 }, (_, i) => ({
      name: `Place ${i + 1}`,
      query: `Place ${i + 1} Iceland`,
      ...(i === 0 ? { timeOfDay: "dawn" as const } : {}),
    }));
    const result = sanitizeScenerySetResult({
      locations,
      queries: [{ text: "iceland landscape" }],
    });

    expect(result.locations).toHaveLength(16);
    expect(result.sceneNames).toEqual(result.locations?.map((l) => l.name));
    expect(result.locations?.[0]).toEqual({
      name: "Place 1",
      query: "Place 1 Iceland",
      timeOfDay: "dawn",
    });
    expect(result.queries).toEqual([{ text: "iceland landscape" }]);
  });

  it("dedupes locations by name and drops empty query/name", () => {
    const result = sanitizeScenerySetResult({
      locations: [
        { name: " Kirkjufell ", query: " Kirkjufell mountain Iceland " },
        { name: "kirkjufell", query: "duplicate" },
        { name: "Skógafoss", query: "  " },
        { name: "", query: "empty name" },
        { name: "Jökulsárlón", query: "Jökulsárlón glacier lagoon", season: "winter" },
      ],
      queries: [{ text: "iceland coast" }],
    });

    expect(result.locations).toEqual([
      { name: "Kirkjufell", query: "Kirkjufell mountain Iceland" },
      { name: "Jökulsárlón", query: "Jökulsárlón glacier lagoon", season: "winter" },
    ]);
    expect(result.sceneNames).toEqual(["Kirkjufell", "Jökulsárlón"]);
  });

  it("caps general queries at 6", () => {
    const queries = Array.from({ length: 12 }, (_, i) => ({
      text: `iceland landscape ${i + 1}`,
    }));
    const result = sanitizeScenerySetResult({
      sceneNames: ["Kirkjufell"],
      queries,
    });

    expect(result.queries).toHaveLength(6);
    expect(result.queries.map((q) => q.text)).toEqual([
      "iceland landscape 1",
      "iceland landscape 2",
      "iceland landscape 3",
      "iceland landscape 4",
      "iceland landscape 5",
      "iceland landscape 6",
    ]);
  });
});

describe("normalizeCliError", () => {
  it("detects 'Command not found' and includes CLI name in the message", () => {
    const error = normalizeCliError(
      "claude",
      "generateCommitMessage",
      new Error("Command not found: claude"),
      "Something went wrong",
    );

    expect(error).toBeInstanceOf(TextGenerationError);
    expect(error.detail).toContain("Claude CLI");
    expect(error.detail).toContain("not available on PATH");
  });

  it("uses the CLI name from the first argument for codex", () => {
    const error = normalizeCliError(
      "codex",
      "generateBranchName",
      new Error("Command not found: codex"),
      "Something went wrong",
    );

    expect(error).toBeInstanceOf(TextGenerationError);
    expect(error.detail).toContain("Codex CLI");
    expect(error.detail).toContain("not available on PATH");
  });

  it("returns the error as-is if it is already a TextGenerationError", () => {
    const existing = new TextGenerationError({
      operation: "generatePrContent",
      detail: "Already wrapped",
    });

    const result = normalizeCliError("claude", "generatePrContent", existing, "fallback");

    expect(result).toBe(existing);
  });

  it("wraps unknown non-Error values with the fallback message", () => {
    const result = normalizeCliError("codex", "generateCommitMessage", "string error", "fallback");

    expect(result).toBeInstanceOf(TextGenerationError);
    expect(result.detail).toBe("fallback");
  });

  it("detects unavailable CLIs from non-Error spawn messages", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      "spawn codex ENOENT",
      "fallback",
    );

    expect(result).toBeInstanceOf(TextGenerationError);
    expect(result.detail).toContain("Codex CLI");
    expect(result.detail).toContain("not available on PATH");
  });

  it("detects unavailable CLIs from absolute-path spawn messages", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      "spawn /opt/homebrew/bin/codex ENOENT",
      "fallback",
    );

    expect(result).toBeInstanceOf(TextGenerationError);
    expect(result.detail).toContain("Codex CLI");
    expect(result.detail).toContain("not available on PATH");
  });

  it("does not classify unrelated ENOENT messages as missing CLIs", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      { message: "ENOENT: no such file or directory, open '/tmp/t3code-codex-output.json'" },
      "Failed to read output file",
    );

    expect(result).toBeInstanceOf(TextGenerationError);
    expect(result.detail).toBe("Failed to read output file");
  });

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
