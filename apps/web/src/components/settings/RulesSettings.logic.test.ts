import { describe, expect, it } from "vite-plus/test";
import { buildAgentRuleDocument, draftFromRule, sortAgentRules } from "./RulesSettings.logic";

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
  it("sorts active environment, project, then archived rules", () => {
    expect(
      sortAgentRules([
        { id: "z", name: "Z", scope: "project" as const, archivedAt: null },
        { id: "a", name: "A", scope: "environment" as const, archivedAt: "2026-01-01" },
        { id: "b", name: "B", scope: "environment" as const, archivedAt: null },
      ]).map((rule) => rule.id),
    ).toEqual(["b", "z", "a"]);
  });
});
