import { describe, expect, it } from "vite-plus/test";

import { dedicatedUsageWorktreePath, normalizeUsagePath } from "./usagePaths.ts";

describe("usage path normalization", () => {
  it("folds slash styles, trailing separators, and dot segments", () => {
    expect(normalizeUsagePath("C:\\Work\\App\\other\\..\\src\\")).toBe("c:/work/app/src");
  });

  it("does not treat another spelling of the project root as a dedicated worktree", () => {
    expect(dedicatedUsageWorktreePath("C:\\Work\\App", "c:/work/app/")).toBeNull();
  });

  it("returns one stable key for equivalent dedicated worktree paths", () => {
    expect(dedicatedUsageWorktreePath("C:/work/app", "C:\\WORK\\APP\\.wt\\thread-1\\")).toBe(
      "c:/work/app/.wt/thread-1",
    );
    expect(dedicatedUsageWorktreePath("C:/work/app", "C:/work/app/other/../.wt/thread-1")).toBe(
      "c:/work/app/.wt/thread-1",
    );
  });

  it("preserves case-sensitive POSIX comparisons", () => {
    expect(normalizeUsagePath("/Work/App")).toBe("/Work/App");
    expect(normalizeUsagePath("/work/app")).toBe("/work/app");
  });
});
