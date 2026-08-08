import { describe, expect, it } from "@effect/vitest";

import { formatAgentRuleGlobs, parseAgentRuleGlobs } from "./agentRuleGlobs.js";

describe("agent rule glob editor values", () => {
  it("splits newline and legacy comma lists but preserves brace commas", () => {
    expect(parseAgentRuleGlobs("src/**/*.{ts,tsx}\n docs/**/*.md, packages/*/src/**")).toEqual([
      "src/**/*.{ts,tsx}",
      "docs/**/*.md",
      "packages/*/src/**",
    ]);
  });

  it("formats one glob per line", () => {
    expect(formatAgentRuleGlobs(["a", "b"])).toBe("a\nb");
  });
});
