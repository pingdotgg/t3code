import type { LinearIssueDetail } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatLinearIssues } from "./linearFormat";

function makeIssue(overrides: Partial<LinearIssueDetail> = {}): LinearIssueDetail {
  return {
    id: "id-1",
    identifier: "ENG-1",
    title: "Fix the thing",
    url: "https://linear.app/acme/issue/ENG-1",
    stateName: "In Progress",
    priorityLabel: "High",
    assigneeName: "Ada",
    teamKey: "ENG",
    description: "Do the work.\n\n- [ ] Step one\n- [ ] Step two",
    labels: ["bug", "backend"],
    subIssues: [{ identifier: "ENG-2", title: "Subtask", stateName: "Todo" }],
    linkedPullRequests: [{ url: "https://github.com/acme/repo/pull/42", title: "PR 42" }],
    attachments: [{ url: "https://example.com/design", title: "Design" }],
    comments: [{ author: "Grace", body: "Looks good", createdAt: "2026-01-02" }],
    ...overrides,
  };
}

describe("formatLinearIssues", () => {
  it("returns an empty string when there are no issues", () => {
    expect(formatLinearIssues([], "combine")).toBe("");
  });

  it("formats a single issue with all context", () => {
    const output = formatLinearIssues([makeIssue()], "combine");
    expect(output).toContain("Work on this Linear issue:");
    expect(output).toContain("## ENG-1: Fix the thing");
    expect(output).toContain("Status: In Progress");
    expect(output).toContain("Priority: High");
    expect(output).toContain("Assignee: Ada");
    expect(output).toContain("Labels: bug, backend");
    expect(output).toContain("https://linear.app/acme/issue/ENG-1");
    // Acceptance-criteria checklist is preserved verbatim from the description.
    expect(output).toContain("- [ ] Step one");
    expect(output).toContain("**Sub-issues**");
    expect(output).toContain("ENG-2: Subtask (Todo)");
    expect(output).toContain("**Linked pull requests**");
    expect(output).toContain("[PR 42](https://github.com/acme/repo/pull/42)");
    expect(output).toContain("**Attachments**");
    expect(output).toContain("**Comments**");
    expect(output).toContain("Grace");
    expect(output).toContain("Looks good");
  });

  it("combines multiple issues under one task heading", () => {
    const output = formatLinearIssues(
      [makeIssue(), makeIssue({ id: "id-2", identifier: "ENG-9", title: "Second" })],
      "combine",
    );
    expect(output).toContain("Work on these Linear issues together as one task:");
    expect(output).toContain("## ENG-1: Fix the thing");
    expect(output).toContain("## ENG-9: Second");
    expect(output).not.toContain("Subtask 1");
  });

  it("labels multiple issues as ordered subtasks", () => {
    const output = formatLinearIssues(
      [makeIssue(), makeIssue({ id: "id-2", identifier: "ENG-9", title: "Second" })],
      "subtasks",
    );
    expect(output).toContain("should be implemented as subtasks");
    expect(output).toContain("## Subtask 1 — ENG-1: Fix the thing");
    expect(output).toContain("## Subtask 2 — ENG-9: Second");
  });

  it("omits sections that have no data", () => {
    const output = formatLinearIssues(
      [
        makeIssue({
          description: "",
          labels: [],
          subIssues: [],
          linkedPullRequests: [],
          attachments: [],
          comments: [],
        }),
      ],
      "combine",
    );
    expect(output).not.toContain("**Sub-issues**");
    expect(output).not.toContain("**Linked pull requests**");
    expect(output).not.toContain("**Comments**");
    expect(output).not.toContain("**Description**");
  });
});
