import { describe, expect, it } from "@effect/vitest";

import {
  buildAgentRuleDocument,
  draftFromRule,
  isRuleDocumentForSummary,
  resolveRuleBaselineForSave,
  sortAgentRules,
} from "./agentRule.logic";

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
    ).toThrow("Priority must be a whole number from -100 to 100.");
    expect(() =>
      buildAgentRuleDocument(
        { ...draftFromRule(), id: "bad-negative", name: "Bad", priority: "-101" },
        null,
      ),
    ).toThrow("Priority must be a whole number from -100 to 100.");
    expect(
      sortAgentRules([
        { id: "old", name: "Old", archivedAt: "2026-01-01" },
        { id: "new", name: "New", archivedAt: null },
      ]).map((rule) => rule.id),
    ).toEqual(["new", "old"]);
  });

  it("rejects blank priorities and preserves the full target after the first colon", () => {
    expect(() =>
      buildAgentRuleDocument(
        { ...draftFromRule(), id: "blank", name: "Blank", priority: "   " },
        null,
      ),
    ).toThrow("Priority is required.");
    expect(() =>
      buildAgentRuleDocument(
        {
          ...draftFromRule(),
          id: "target",
          name: "Target",
          profiles: "environment:reviewer:truncated",
        },
        null,
      ),
    ).toThrow();
  });
  it("reports schema-only invalid rule fields readably", () => {
    expect(() =>
      buildAgentRuleDocument({ ...draftFromRule(), scope: "invalid" as "environment" }, null),
    ).toThrow("Rule settings contain an invalid value.");
  });

  it("requires the loaded revision before saving an existing rule", () => {
    const rule = buildAgentRuleDocument({ ...draftFromRule(), id: "tests", name: "Tests" }, null);
    expect(() => resolveRuleBaselineForSave(false, rule, undefined)).toThrow(
      "Load the current rule",
    );
    expect(resolveRuleBaselineForSave(false, rule, rule)).toBe(rule);
    expect(resolveRuleBaselineForSave(true, null, undefined)).toBeNull();
  });

  it("does not hydrate a rule from a stale revision", () => {
    const rule = buildAgentRuleDocument({ ...draftFromRule(), id: "tests", name: "Tests" }, null);
    expect(isRuleDocumentForSummary(rule, rule)).toBe(true);
    expect(
      isRuleDocumentForSummary(rule, {
        ...rule,
        revision: "b".repeat(64) as typeof rule.revision,
      }),
    ).toBe(false);
  });
  it("keeps commas inside brace alternation and formats globs one per line", () => {
    const rule = buildAgentRuleDocument(
      {
        ...draftFromRule(),
        id: "sources",
        name: "Sources",
        globs: "src/**/*.{ts,tsx}\n tests/**/*.test.ts",
      },
      null,
    );
    expect(rule.globs).toEqual(["src/**/*.{ts,tsx}", "tests/**/*.test.ts"]);
    expect(draftFromRule(rule).globs).toBe("src/**/*.{ts,tsx}\ntests/**/*.test.ts");
  });
});
