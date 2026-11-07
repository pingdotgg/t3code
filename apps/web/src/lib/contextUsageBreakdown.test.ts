import { describe, expect, it } from "vite-plus/test";

import {
  buildContextUsageBreakdownView,
  formatBreakdownPercentage,
  formatBreakdownTokens,
} from "./contextUsageBreakdown";

describe("buildContextUsageBreakdownView", () => {
  it("orders resident slices by size, then free space, then deferred slices", () => {
    const view = buildContextUsageBreakdownView({
      model: "claude-fable-5-1",
      totalTokens: 60_000,
      maxTokens: 1_000_000,
      categories: [
        { name: "Free space", tokens: 940_000, deferred: false },
        { name: "MCP tools (deferred)", tokens: 42_400, deferred: true },
        { name: "Messages", tokens: 12_000, deferred: false },
        { name: "System tools", tokens: 19_200, deferred: false },
        { name: "Custom agents", tokens: 0, deferred: false },
      ],
      groups: [],
    });

    expect(view.rows.map((row) => row.name)).toEqual([
      "System tools",
      "Messages",
      "Custom agents",
      "Free space",
      "MCP tools (deferred)",
    ]);
    expect(view.rows.at(-1)?.percentage).toBeNull();
    expect(view.segments.map((row) => row.name)).toEqual(["System tools", "Messages"]);
    expect(view.usedPercentage).toBeCloseTo(6);
  });

  it("gives unknown categories a color without reusing the free-space shade", () => {
    const view = buildContextUsageBreakdownView({
      model: "m",
      totalTokens: 10,
      maxTokens: 100,
      categories: [
        { name: "Future thing", tokens: 10, deferred: false },
        { name: "Free space", tokens: 90, deferred: false },
      ],
      groups: [],
    });
    const [future, free] = view.rows;
    expect(future?.color).toMatch(/^#/);
    expect(free?.color).not.toBe(future?.color);
  });
});

describe("formatting", () => {
  it("keeps one decimal below 100k like the provider display", () => {
    expect(formatBreakdownTokens(87)).toBe("87");
    expect(formatBreakdownTokens(19_200)).toBe("19.2k");
    expect(formatBreakdownTokens(12_000)).toBe("12k");
    expect(formatBreakdownTokens(938_800)).toBe("939k");
    expect(formatBreakdownTokens(1_000_000)).toBe("1M");
  });

  it("renders percentages with one decimal and blanks deferred rows", () => {
    expect(formatBreakdownPercentage(1.92)).toBe("1.9%");
    expect(formatBreakdownPercentage(0.0087)).toBe("0.0%");
    expect(formatBreakdownPercentage(null)).toBe("");
  });
});
