import { describe, expect, it, vi } from "vitest";

import type { ReviewRenderableFile } from "./reviewModel";

const store = vi.hoisted(() => ({
  expanded: undefined as ReadonlyArray<string> | undefined,
  viewed: undefined as ReadonlyArray<string> | undefined,
}));

vi.mock("react", () => ({
  useCallback: <T>(fn: T) => fn,
  useMemo: <T>(fn: () => T) => fn(),
}));

vi.mock("./reviewState", () => ({
  updateReviewExpandedFileIds: (
    _threadKey: string,
    _sectionId: string,
    update: (current: ReadonlyArray<string> | undefined) => ReadonlyArray<string> | undefined,
  ) => {
    store.expanded = update(store.expanded);
  },
  updateReviewViewedFileIds: (
    _threadKey: string,
    _sectionId: string,
    update: (current: ReadonlyArray<string> | undefined) => ReadonlyArray<string> | undefined,
  ) => {
    store.viewed = update(store.viewed);
  },
}));

import { useReviewFileVisibility } from "./reviewFileVisibility";

const files = [
  { id: "file-a" },
  { id: "file-b" },
] as unknown as ReadonlyArray<ReviewRenderableFile>;

function render() {
  return useReviewFileVisibility({
    threadKey: "thread",
    sectionId: "section",
    files,
    cachedExpandedFileIds: store.expanded,
    cachedViewedFileIds: store.viewed,
  });
}

describe("useReviewFileVisibility", () => {
  it("folds a file when it is marked Viewed and unfolds it when the mark is cleared", () => {
    store.expanded = undefined;
    store.viewed = undefined;

    render().toggleViewedFile("file-a");
    expect(render()).toMatchObject({ viewedFileIds: ["file-a"], collapsedFileIds: ["file-a"] });

    render().toggleViewedFile("file-a");
    expect(render()).toMatchObject({ viewedFileIds: [], collapsedFileIds: [] });
  });
});
