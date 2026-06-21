import { describe, expect, it } from "vite-plus/test";
import { prStatusIndicator, type ThreadPr } from "./ThreadStatusIndicators";

function makePr(overrides: Partial<NonNullable<ThreadPr>> = {}): NonNullable<ThreadPr> {
  return {
    number: 7,
    title: "Add feature",
    url: "https://example.com/pr/7",
    baseRef: "main",
    headRef: "feature/x",
    state: "open",
    ...overrides,
  };
}

describe("prStatusIndicator", () => {
  it("returns null when there is no PR", () => {
    expect(prStatusIndicator(null, undefined)).toBeNull();
  });

  it("marks an open PR with the open icon and emerald color", () => {
    const status = prStatusIndicator(makePr(), undefined);
    expect(status?.icon).toBe("open");
    expect(status?.colorClass).toContain("emerald");
  });

  it("prefers the conflict icon and red color when an open PR has conflicts", () => {
    const status = prStatusIndicator(makePr({ hasConflicts: true, isDraft: true }), undefined);
    expect(status?.icon).toBe("conflict");
    expect(status?.colorClass).toContain("red");
    expect(status?.tooltip).toContain("conflicts");
  });

  it("uses the draft icon and gray color for an open draft PR without conflicts", () => {
    const status = prStatusIndicator(makePr({ isDraft: true }), undefined);
    expect(status?.icon).toBe("draft");
    expect(status?.colorClass).toContain("zinc");
  });

  it("uses the closed icon for a closed PR", () => {
    const status = prStatusIndicator(makePr({ state: "closed" }), undefined);
    expect(status?.icon).toBe("closed");
  });

  it("uses the merged icon for a merged PR", () => {
    const status = prStatusIndicator(makePr({ state: "merged" }), undefined);
    expect(status?.icon).toBe("merged");
    expect(status?.colorClass).toContain("violet");
  });
});
