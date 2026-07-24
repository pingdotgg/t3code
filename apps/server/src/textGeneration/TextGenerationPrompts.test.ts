import { describe, expect, it } from "vite-plus/test";

import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadReviewPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  normalizeThreadReview,
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

describe("buildThreadReviewPrompt", () => {
  it("includes title, first user message, and transcript", () => {
    const result = buildThreadReviewPrompt({
      title: "New thread",
      isActive: false,
      firstUserMessage: "Fix the settle default",
      recentMessages: [
        { role: "user", text: "Fix the settle default" },
        { role: "assistant", text: "Done, merged." },
      ],
    });

    expect(result.prompt).toContain("Current title: New thread");
    expect(result.prompt).toContain("Fix the settle default");
    expect(result.prompt).toContain("[assistant] Done, merged.");
    expect(result.prompt).not.toContain("ACTIVE");
  });

  it("adds the never-settle rule for active threads", () => {
    const result = buildThreadReviewPrompt({
      title: "Working thread",
      isActive: true,
      firstUserMessage: "Do a thing",
      recentMessages: [],
    });

    expect(result.prompt).toContain("recommendSettle must be false");
    expect(result.prompt).toContain("(no messages)");
  });

  it("caps the transcript to the most recent 20 messages", () => {
    const result = buildThreadReviewPrompt({
      title: "Long thread",
      isActive: false,
      firstUserMessage: "start",
      recentMessages: Array.from({ length: 30 }, (_, index) => ({
        role: "assistant" as const,
        text: `message-${index}`,
      })),
    });

    expect(result.prompt).not.toContain("message-9\n");
    expect(result.prompt).toContain("message-10");
    expect(result.prompt).toContain("message-29");
  });
});

describe("normalizeThreadReview", () => {
  const raw = {
    summary: "  Work   finished.  ",
    suggestedTitle: '"Ship settle default"',
    recommendSettle: true,
    settleReason: "  PR merged.  ",
  };

  it("sanitizes fields and keeps settle recommendation for inactive threads", () => {
    expect(normalizeThreadReview(raw, false)).toEqual({
      summary: "Work finished.",
      suggestedTitle: "Ship settle default",
      recommendSettle: true,
      settleReason: "PR merged.",
    });
  });

  it("forces recommendSettle off for active threads even if the model says settle", () => {
    const result = normalizeThreadReview(raw, true);
    expect(result.recommendSettle).toBe(false);
    expect(result.settleReason).toBeNull();
  });

  it("drops empty and placeholder title suggestions", () => {
    expect(
      normalizeThreadReview({ ...raw, suggestedTitle: "   " }, false).suggestedTitle,
    ).toBeNull();
    expect(
      normalizeThreadReview({ ...raw, suggestedTitle: "New thread" }, false).suggestedTitle,
    ).toBeNull();
    expect(
      normalizeThreadReview({ ...raw, suggestedTitle: null }, false).suggestedTitle,
    ).toBeNull();
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
