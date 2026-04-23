import { describe, expect, it } from "vitest";

import {
  parseLocalAgentCommandJsonDocument,
  parseLocalAgentCommandMarkdownDocument,
  parseLocalAgentSkillDocument,
  renderLocalAgentCommandPromptTemplate,
} from "./localAgents.ts";

describe("localAgents", () => {
  it("parses skill markdown frontmatter and strips the body", () => {
    const parsed = parseLocalAgentSkillDocument({
      contents: `---
name: repo-review
description: Review repository changes
display-name: Repo Review
enabled: false
---

# Repo Review

Look for risky diffs first.`,
      defaultName: "fallback-skill",
      path: ".agents/skills/repo-review/SKILL.md",
    });

    expect(parsed.skill).toEqual({
      name: "repo-review",
      path: ".agents/skills/repo-review/SKILL.md",
      scope: "project",
      enabled: false,
      source: "local-agents",
      displayName: "Repo Review",
      description: "Review repository changes",
      shortDescription: "Review repository changes",
    });
    expect(parsed.contents).toContain("Look for risky diffs first.");
    expect(parsed.contents).not.toContain("description:");
  });

  it("parses markdown commands with frontmatter", () => {
    const parsed = parseLocalAgentCommandMarkdownDocument({
      contents: `---
description: Review a pull request
argument-hint: [pr-number]
---

Review pull request $1 for correctness and regressions.`,
      defaultName: "review-pr",
      path: ".agents/commands/review-pr.md",
    });

    expect(parsed.command).toEqual({
      name: "review-pr",
      path: ".agents/commands/review-pr.md",
      scope: "project",
      source: "local-agents",
      description: "Review a pull request",
      inputHint: "[pr-number]",
    });
    expect(parsed.promptTemplate).toBe("Review pull request $1 for correctness and regressions.");
  });

  it("parses json commands", () => {
    const parsed = parseLocalAgentCommandJsonDocument({
      contents: JSON.stringify({
        name: "triage",
        description: "Triage an issue",
        inputHint: "[issue-id]",
        promptTemplate: "Triage issue $ARGUMENTS.",
      }),
      defaultName: "fallback-command",
      path: ".agents/commands/triage/command.json",
    });

    expect(parsed.command).toEqual({
      name: "triage",
      path: ".agents/commands/triage/command.json",
      scope: "project",
      source: "local-agents",
      description: "Triage an issue",
      inputHint: "[issue-id]",
    });
    expect(parsed.promptTemplate).toBe("Triage issue $ARGUMENTS.");
  });

  it("renders positional and aggregate command arguments", () => {
    expect(
      renderLocalAgentCommandPromptTemplate(
        "Review PR #$1 with priority $2. Raw: $ARGUMENTS",
        "123 urgent",
      ),
    ).toBe("Review PR #123 with priority urgent. Raw: 123 urgent");
  });
});
