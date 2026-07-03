import { describe, expect, it } from "vite-plus/test";

import { resolveSelectedReviewFileId } from "./reviewPaneSelection";

describe("resolveSelectedReviewFileId", () => {
  it("keeps a visible file selected within the active section", () => {
    expect(
      resolveSelectedReviewFileId({
        selection: { sectionId: "worktree", fileId: "second" },
        sectionId: "worktree",
        availableFileIds: ["first", "second"],
      }),
    ).toBe("second");
  });

  it("clears selection when the review section changes", () => {
    expect(
      resolveSelectedReviewFileId({
        selection: { sectionId: "turn-1", fileId: "first" },
        sectionId: "turn-2",
        availableFileIds: ["first"],
      }),
    ).toBeNull();
  });

  it("clears a file that no longer exists in the diff", () => {
    expect(
      resolveSelectedReviewFileId({
        selection: { sectionId: "worktree", fileId: "removed" },
        sectionId: "worktree",
        availableFileIds: ["first", "second"],
      }),
    ).toBeNull();
  });
});
