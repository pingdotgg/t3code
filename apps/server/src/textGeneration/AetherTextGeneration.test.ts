import { describe, expect, it } from "@effect/vitest";

import { stubBranchName } from "./AetherTextGeneration.ts";

describe("stubBranchName", () => {
  it("keeps the date suffix when the message slug fills the whole limit", () => {
    // Slugging to 64 chars first and re-sanitizing after left no room for the
    // suffix, so every date collapsed to the same branch name.
    const longMessage = "a".repeat(200);
    const first = stubBranchName(longMessage, "2026-08-01");
    const second = stubBranchName(longMessage, "2026-08-02");
    expect(first).toContain("-2026-08-01");
    expect(second).toContain("-2026-08-02");
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(64);
  });

  it("still slugs a short message plus the date", () => {
    expect(stubBranchName("Add a safer reconnect backoff", "2026-08-01")).toBe(
      "add-a-safer-reconnect-backoff-2026-08-01",
    );
  });
});
