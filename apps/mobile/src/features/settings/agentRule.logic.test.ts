import { describe, expect, it } from "@effect/vitest";

import { buildAgentRuleDocument, draftFromRule, sortAgentRules } from "./agentRule.logic";

describe("mobile agent rule editor", () => {
  it("builds glob, targeting, priority, and body fields", () => {
    const rule = buildAgentRuleDocument(
      {
        ...draftFromRule(null, "project"),
        id: "tests",
        name: "Tests",
        globs: "**/*.test.ts, **/*.spec.ts",
        priority: "10",
        profiles: "environment:reviewer, project:tester",
        body: "Keep tests focused.",
        alwaysApply: false,
      },
      null,
      "2026-08-07T00:00:00.000Z",
    );

    expect(rule.scope).toBe("project");
    expect(rule.globs).toEqual(["**/*.test.ts", "**/*.spec.ts"]);
    expect(rule.profiles).toEqual([
      { scope: "environment", id: "reviewer" },
      { scope: "project", id: "tester" },
    ]);
    expect(rule.priority).toBe(10);
  });

  it("rejects invalid priorities and sorts archived rules last", () => {
    expect(() =>
      buildAgentRuleDocument({ ...draftFromRule(), id: "bad", name: "Bad", priority: "101" }, null),
    ).toThrow("Priority");
    expect(
      sortAgentRules([
        { id: "old", name: "Old", archivedAt: "2026-01-01" },
        { id: "new", name: "New", archivedAt: null },
      ]).map((rule) => rule.id),
    ).toEqual(["new", "old"]);
  });
});
