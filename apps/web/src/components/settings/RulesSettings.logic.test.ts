import { describe, expect, it } from "vite-plus/test";
import {
  buildAgentRuleDocument,
  draftFromRule,
  resolveRuleBaselineForSave,
  sortAgentRules,
} from "./RulesSettings.logic";

describe("agent rule settings model", () => {
  it("creates a complete file-aware rule", () => {
    const rule = buildAgentRuleDocument(
      {
        ...draftFromRule(),
        id: "typescript",
        name: "TypeScript",
        globs: "src/**/*.ts",
        body: "Use strict types.",
      },
      null,
    );
    expect(rule.globs).toEqual(["src/**/*.ts"]);
    expect(rule.profiles).toEqual([]);
  });
  it("rejects a blank priority", () => {
    expect(() =>
      buildAgentRuleDocument(
        { ...draftFromRule(), id: "blank", name: "Blank", priority: "   " },
        null,
      ),
    ).toThrow("Priority is required.");
  });
  it("rejects priorities outside the supported range", () => {
    expect(() => buildAgentRuleDocument({ ...draftFromRule(), priority: "101" }, null)).toThrow(
      "Priority must be a whole number from -100 to 100.",
    );
    expect(() => buildAgentRuleDocument({ ...draftFromRule(), priority: "-101" }, null)).toThrow(
      "Priority must be a whole number from -100 to 100.",
    );
  });
  it("reports schema-only invalid rule fields readably", () => {
    expect(() =>
      buildAgentRuleDocument({ ...draftFromRule(), scope: "invalid" as "environment" }, null),
    ).toThrow("Rule settings contain an invalid value.");
  });
  it("parses target profiles and preserves revisions", () => {
    const baseline = buildAgentRuleDocument(
      { ...draftFromRule(), id: "typescript", name: "Old" },
      null,
    );
    const rule = buildAgentRuleDocument(
      {
        ...draftFromRule(),
        id: "typescript",
        name: "TypeScript",
        profiles: '[{"id":"reviewer","scope":"project"}]',
      },
      baseline,
    );
    expect(rule.revision).toBe(baseline.revision);
    expect(rule.profiles).toEqual([{ id: "reviewer", scope: "project" }]);
  });
  it("keeps commas inside brace alternation and supports one glob per line", () => {
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
  it("sorts active environment, project, then archived rules", () => {
    expect(
      sortAgentRules([
        { id: "z", name: "Z", scope: "project" as const, archivedAt: null },
        { id: "a", name: "A", scope: "environment" as const, archivedAt: "2026-01-01" },
        { id: "b", name: "B", scope: "environment" as const, archivedAt: null },
      ]).map((rule) => rule.id),
    ).toEqual(["b", "z", "a"]);
  });

  it("requires the loaded revision before saving an existing rule", () => {
    const rule = buildAgentRuleDocument({ ...draftFromRule(), id: "tests", name: "Tests" }, null);
    expect(() => resolveRuleBaselineForSave(false, rule, undefined)).toThrow(
      "Load the current rule",
    );
    expect(resolveRuleBaselineForSave(false, rule, rule)).toBe(rule);
    expect(resolveRuleBaselineForSave(true, null, undefined)).toBeNull();
  });
});
