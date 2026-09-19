import { describe, expect, it } from "vite-plus/test";

import { usageLimitBarColor } from "./usageLimitColors";

describe("usageLimitBarColor", () => {
  const providerColor = "var(--provider)";

  it.each([
    [100, providerColor],
    [31, providerColor],
    [30, "var(--warning)"],
    [11, "var(--warning)"],
    [10, "var(--destructive)"],
    [0, "var(--destructive)"],
  ])("uses the expected color with %s%% remaining", (remaining, expected) => {
    expect(usageLimitBarColor(providerColor, remaining)).toBe(expected);
  });

  it("evaluates each account limit independently", () => {
    expect([80, 25, 5].map((remaining) => usageLimitBarColor(providerColor, remaining))).toEqual([
      providerColor,
      "var(--warning)",
      "var(--destructive)",
    ]);
  });
});
