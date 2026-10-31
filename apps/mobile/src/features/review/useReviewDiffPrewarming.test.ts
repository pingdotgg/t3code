import { describe, expect, it, vi } from "vite-plus/test";

import { getCachedNativeReviewDiffData } from "./nativeReviewDiffAdapter";
import type { ReviewSectionItem } from "./reviewModel";
import { getCachedReviewParsedDiff } from "./reviewState";
import { getReviewDiffPrewarmSections, prewarmReviewDiffSection } from "./useReviewDiffPrewarming";

vi.mock("./nativeReviewDiffAdapter", () => ({ getCachedNativeReviewDiffData: vi.fn() }));
vi.mock("./reviewState", () => ({
  getCachedReviewParsedDiff: vi.fn(() => ({ kind: "empty" })),
  getReviewParsedDiffSourceCharacterCount: (input: { diff: string | null }) =>
    input.diff?.length ?? 0,
  MAX_CACHED_REVIEW_DIFFS: 8,
  MAX_CACHED_REVIEW_SOURCE_CHARACTERS: 4_194_304,
}));

function section(id: string, lazy = false): ReviewSectionItem {
  return {
    id,
    kind: "working-tree",
    title: id,
    subtitle: null,
    diff: "patch",
    isLoading: false,
    source: {
      id,
      kind: "working-tree",
      title: id,
      diff: "patch",
      diffHash: id,
      truncated: lazy,
      files: [],
      baseRef: null,
      headRef: null,
    },
  };
}

describe("review diff prewarming", () => {
  it("skips truncated stat-backed neighbors whose bodies use file queries", () => {
    const sections = [section("selected"), section("lazy", true), section("complete")];

    expect(
      getReviewDiffPrewarmSections({
        threadKey: "thread",
        sections,
        selectedSectionId: "selected",
      }).map((item) => item.id),
    ).toEqual(["complete"]);
  });

  it("does not parse or prepare a lazy source even when invoked directly", () => {
    vi.clearAllMocks();

    prewarmReviewDiffSection({ threadKey: "thread", section: section("lazy", true) });

    expect(getCachedReviewParsedDiff).not.toHaveBeenCalled();
    expect(getCachedNativeReviewDiffData).not.toHaveBeenCalled();
  });

  it("still prewarms complete section bodies", () => {
    vi.clearAllMocks();

    prewarmReviewDiffSection({ threadKey: "thread", section: section("complete") });

    expect(getCachedReviewParsedDiff).toHaveBeenCalledOnce();
    expect(getCachedNativeReviewDiffData).toHaveBeenCalledOnce();
  });
});
