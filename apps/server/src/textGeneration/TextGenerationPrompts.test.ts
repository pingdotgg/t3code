import { describe, expect, it } from "vite-plus/test";

import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import { normalizeCliError, sanitizePrTitle, sanitizeThreadTitle } from "./TextGenerationUtils.ts";
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

  it("includes policy instructions", () => {
    const result = buildCommitMessagePrompt({
      branch: "main",
      stagedSummary: "M a.ts",
      stagedPatch: "diff",
      includeBranch: false,
      policy: {
        kind: "custom",
        commitInstructions: "Use a terse repository-specific subject.",
        inferRepositoryConventions: false,
      },
    });

    expect(result.prompt).toContain("Additional instructions:");
    expect(result.prompt).toContain("Use a terse repository-specific subject.");
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
    expect(result.prompt).toContain("include headings '## Summary' and '## Testing'");
  });

  it("follows a repository PR template instead of the default body headings", () => {
    const result = buildPrContentPrompt({
      baseBranch: "main",
      headBranch: "feature/auth",
      commitSummary: "feat: add login page",
      diffSummary: "3 files changed",
      diffPatch: "diff",
      changeRequestTemplate: "<!-- remove me -->\n## What changed\n\n## Verification",
      policy: {
        kind: "custom",
        changeRequestInstructions: "Keep the title in sentence case.",
        inferRepositoryConventions: false,
      },
    });

    expect(result.prompt).toContain("Keep the title in sentence case.");
    expect(result.prompt).toContain("follow the repository change request template structure");
    expect(result.prompt).toContain("drop HTML comments from the template");
    expect(result.prompt).toContain("Repository change request template:");
    expect(result.prompt).toContain("<!-- remove me -->\n## What changed\n\n## Verification");
    expect(result.prompt).not.toContain("include headings '## Summary' and '## Testing'");
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
    expect(result.prompt).toContain(
      "Generate a title that will help the user recognize this T3 Code thread weeks later.",
    );
    expect(result.prompt).toContain(
      "Title the subject and outcome. Discard incidental instructions.",
    );
    expect(result.prompt).toContain(
      "Name the product change, not the mock, plan, report, branch, or PR used to produce it.",
    );
    expect(result.prompt).not.toContain(
      "Title should summarize the user's request, not restate it verbatim.",
    );
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

  it("regenerates from recent thread contents and identifies the previous title", () => {
    const result = buildThreadTitlePrompt({
      message: `USER:\nInvestigate reconnect regressions\n\nASSISTANT:\nThe remaining issue is stale session state`,
      previousTitle: "Investigate reconnect regressions",
    });

    expect(result.prompt).toContain(
      "Regenerate the title for an existing T3 Code thread so the user can recognize it weeks later.",
    );
    expect(result.prompt).toContain('The previous title was "Investigate reconnect regressions".');
    expect(result.prompt).toContain(
      "Read the USER messages first. Identify the latest explicit durable goal.",
    );
    expect(result.prompt).toContain(
      "Do not promote one assistant finding into the thread subject unless the user adopts it as a new goal.",
    );
    expect(result.prompt).toContain(
      'A subagent-monitoring review that finds a Codex roster bug remains "Review Subagent Monitoring Risks,"',
    );
    expect(result.prompt).toContain("Thread contents:");
    expect(result.prompt).toContain("The remaining issue is stale session state");
  });

  it("keeps the latest thread contents when regeneration context is truncated", () => {
    const result = buildThreadTitlePrompt({
      message: `${"old context ".repeat(1_000)}\n\nASSISTANT:\nCurrent thread state`,
      previousTitle: "Old title",
    });

    expect(result.prompt).toContain("[Earlier content truncated]");
    expect(result.prompt).toContain("Current thread state");
    expect(result.prompt).not.toContain("[truncated]");
  });

  it("does not truncate an already-marked regeneration context twice", () => {
    const retainedContext = "x".repeat(7_998);
    const result = buildThreadTitlePrompt({
      message: `[Earlier content truncated]\n\n${retainedContext}`,
      previousTitle: "Old title",
    });

    expect(result.prompt).toContain(
      `Thread contents:\n[Earlier content truncated]\n\n${retainedContext}`,
    );
    expect(result.prompt.match(/\[Earlier content truncated\]/g)).toHaveLength(1);
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

  it("unwraps a self-wrapped JSON envelope emitted as the title value", () => {
    expect(sanitizeThreadTitle('{"title": "Fix the flaky login test"}')).toBe(
      "Fix the flaky login test",
    );
  });

  it("unwraps a single string value regardless of the key name", () => {
    expect(sanitizeThreadTitle('{"name": "Add dark mode toggle"}')).toBe("Add dark mode toggle");
    expect(sanitizeThreadTitle('{"summary": "Investigate reconnect regressions"}')).toBe(
      "Investigate reconnect regressions",
    );
  });

  it("extracts the sole string field even when other non-string fields exist", () => {
    expect(
      sanitizeThreadTitle('{"name": "Add dark mode toggle", "priority": 2, "done": false}'),
    ).toBe("Add dark mode toggle");
    expect(sanitizeThreadTitle('{"confidence": 0.9, "title": "Fix the flaky login test"}')).toBe(
      "Fix the flaky login test",
    );
  });

  it("prefers the title key when several string values are ambiguous", () => {
    expect(
      sanitizeThreadTitle('{"summary": "restate the request", "title": "Real thread name"}'),
    ).toBe("Real thread name");
  });

  it("leaves an ambiguous object without a title key untouched", () => {
    const raw = '{"name": "one", "label": "two"}';
    expect(sanitizeThreadTitle(raw)).toBe(raw);
  });

  it("unwraps a JSON-encoded string wrapping the title", () => {
    // The whole title arrives JSON-string-encoded, e.g. `"Fix the flaky login test"`.
    expect(sanitizeThreadTitle('"Fix the flaky login test"')).toBe("Fix the flaky login test");
  });

  it("unwraps a JSON-string-encoded envelope (object serialised as a JSON string)", () => {
    // Decodes to the string `{"title": "Fix the flaky login test"}`, then to the title.
    expect(sanitizeThreadTitle('"{\\"title\\": \\"Fix the flaky login test\\"}"')).toBe(
      "Fix the flaky login test",
    );
  });

  it("unwraps a JSON envelope inside a Markdown code block", () => {
    expect(sanitizeThreadTitle('```json\n{"title": "Add dark mode toggle"}\n```')).toBe(
      "Add dark mode toggle",
    );
    expect(sanitizeThreadTitle('```\n{"name": "Add dark mode toggle"}\n```')).toBe(
      "Add dark mode toggle",
    );
    expect(sanitizeThreadTitle('`{"title": "Add dark mode toggle"}`')).toBe("Add dark mode toggle");
  });

  it("unwraps an envelope on the same line as the fence opener", () => {
    expect(sanitizeThreadTitle('```json {"title": "Add dark mode toggle"}```')).toBe(
      "Add dark mode toggle",
    );
    expect(sanitizeThreadTitle('```{"name": "Add dark mode toggle"}```')).toBe(
      "Add dark mode toggle",
    );
  });

  it("keeps the first word of a single-line fenced prose title", () => {
    // The leading token is only dropped when the remainder is parseable JSON.
    expect(sanitizeThreadTitle("```Deploy {config} now```")).toBe("Deploy {config} now");
  });

  it("unwraps an envelope that is both quoted and fenced", () => {
    // A JSON string whose contents are a fenced JSON block — Macroscope's case.
    expect(sanitizeThreadTitle('"```json\\n{\\"title\\": \\"Fix test\\"}\\n```"')).toBe("Fix test");
  });

  it("does not unwrap a JSON object embedded in surrounding prose", () => {
    expect(sanitizeThreadTitle('Document {"foo":"bar"} syntax')).toBe(
      'Document {"foo":"bar"} syntax',
    );
    expect(sanitizeThreadTitle('Explain the {"name": "widget"} config')).toBe(
      'Explain the {"name": "widget"} config',
    );
  });

  it("unwraps a doubly-wrapped JSON envelope", () => {
    expect(sanitizeThreadTitle('{"title": "{\\"title\\": \\"Refactor auth flow\\"}"}')).toBe(
      "Refactor auth flow",
    );
  });

  it("leaves a plain title containing braces untouched", () => {
    expect(sanitizeThreadTitle("Handle { and } in the parser")).toBe(
      "Handle { and } in the parser",
    );
  });
});

describe("sanitizePrTitle", () => {
  it("unwraps a self-wrapped JSON envelope emitted as the title value", () => {
    expect(sanitizePrTitle('{"title": "fix(auth): reject expired tokens"}')).toBe(
      "fix(auth): reject expired tokens",
    );
  });

  it("unwraps a JSON-string-encoded envelope (PR titles are not quote-stripped)", () => {
    expect(sanitizePrTitle('"{\\"title\\": \\"fix(auth): reject expired tokens\\"}"')).toBe(
      "fix(auth): reject expired tokens",
    );
  });

  it("keeps a normal single-line title", () => {
    expect(sanitizePrTitle("feat: add retry to uploader")).toBe("feat: add retry to uploader");
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
