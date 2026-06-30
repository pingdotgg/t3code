import { describe, expect, it } from "vite-plus/test";

import {
  compileAutoPullRule,
  summarizeAutoPull,
  type AutoPullCriteria,
} from "@t3tools/contracts/workSource";

// Pure binding test for D1 — verifies that the criteria shapes the component
// works with produce correct compiled rules and summaries. The component itself
// is a controlled React component; dialog-interaction harness doesn't exist
// (same precedent as the shipped import picker), so we test the pure layer.

describe("AutoPullCriteria → compileAutoPullRule (binding verification)", () => {
  it("editing labels any-of [XS] yields the expected compiled rule", () => {
    const criteria: AutoPullCriteria = { labels: { mode: "any", values: ["XS"] } };
    expect(compileAutoPullRule(criteria)).toEqual({ in: ["XS", { var: "labels" }] });
  });

  it("editing labels any-of [XS, S] yields an or-rule", () => {
    const criteria: AutoPullCriteria = { labels: { mode: "any", values: ["XS", "S"] } };
    expect(compileAutoPullRule(criteria)).toEqual({
      or: [{ in: ["XS", { var: "labels" }] }, { in: ["S", { var: "labels" }] }],
    });
  });

  it("labels all-of [A, B] yields an and-of-ins rule", () => {
    const criteria: AutoPullCriteria = { labels: { mode: "all", values: ["A", "B"] } };
    expect(compileAutoPullRule(criteria)).toEqual({
      and: [{ in: ["A", { var: "labels" }] }, { in: ["B", { var: "labels" }] }],
    });
  });

  it("assignee anyone yields bare var rule", () => {
    const criteria: AutoPullCriteria = { assignee: { kind: "anyone" } };
    expect(compileAutoPullRule(criteria)).toEqual({ var: "assignees" });
  });

  it("assignee login yields in-rule", () => {
    const criteria: AutoPullCriteria = { assignee: { kind: "login", value: "octocat" } };
    expect(compileAutoPullRule(criteria)).toEqual({ in: ["octocat", { var: "assignees" }] });
  });

  it("state open yields an equality rule", () => {
    const criteria: AutoPullCriteria = { state: "open" };
    expect(compileAutoPullRule(criteria)).toEqual({ "==": [{ var: "state" }, "open"] });
  });

  it("empty criteria compiles to ALWAYS_RULE (true)", () => {
    const criteria: AutoPullCriteria = {};
    expect(compileAutoPullRule(criteria)).toBe(true);
  });
});

describe("summarizeAutoPull", () => {
  it("returns a sensible string for labels any-of XS", () => {
    const summary = summarizeAutoPull({ labels: { mode: "any", values: ["XS"] } });
    expect(typeof summary).toBe("string");
    expect(summary.length).toBeGreaterThan(0);
    // Should mention the label somewhere
    expect(summary).toContain("XS");
  });

  it("returns 'All issues' for empty criteria", () => {
    expect(summarizeAutoPull({})).toBe("All issues");
  });

  it("returns 'Manual only' for null criteria", () => {
    expect(summarizeAutoPull(null)).toBe("Manual only");
  });

  it("returns a string for combined labels + state", () => {
    const summary = summarizeAutoPull({
      labels: { mode: "any", values: ["XS", "S"] },
      state: "open",
    });
    expect(summary).toContain("XS");
    expect(summary).toContain("open");
  });
});
