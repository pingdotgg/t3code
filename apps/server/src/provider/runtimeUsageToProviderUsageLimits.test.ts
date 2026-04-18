import { describe, expect, it } from "vitest";

import { runtimeUsageToProviderUsageLimits } from "./runtimeUsageToProviderUsageLimits.ts";

describe("runtimeUsageToProviderUsageLimits", () => {
  it("maps real token usage into a single session window", () => {
    expect(
      runtimeUsageToProviderUsageLimits({
        source: "cursorAcp",
        checkedAt: "2026-04-18T00:00:00.000Z",
        usedTokens: 75,
        maxTokens: 100,
      }),
    ).toEqual({
      source: "cursorAcp",
      available: true,
      checkedAt: "2026-04-18T00:00:00.000Z",
      windows: [{ kind: "session", label: "Session", usedPercent: 75 }],
    });
  });

  it("returns undefined for invalid token limits", () => {
    expect(
      runtimeUsageToProviderUsageLimits({
        source: "cursorAcp",
        checkedAt: "2026-04-18T00:00:00.000Z",
        usedTokens: 75,
        maxTokens: 0,
      }),
    ).toBeUndefined();
  });
});
