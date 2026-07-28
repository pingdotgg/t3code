import type { VcsListRefsResult } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  isPaginatedBranchesNextPagePending,
  shouldLoadNextBranchPageAfterScroll,
} from "./paginatedBranches";

const FIRST_PAGE: VcsListRefsResult = {
  refs: [],
  isRepo: true,
  hasPrimaryRemote: true,
  nextCursor: 100,
  totalCount: 150,
};

const LAST_PAGE: VcsListRefsResult = {
  ...FIRST_PAGE,
  nextCursor: null,
};

describe("paginated branch loading state", () => {
  it("does not label a first-page background refresh as loading more refs", () => {
    expect(
      isPaginatedBranchesNextPagePending([
        AsyncResult.success(FIRST_PAGE, {
          waiting: true,
        }),
      ]),
    ).toBe(false);
  });

  it("only reports loading more while a new cursor has no value", () => {
    expect(
      isPaginatedBranchesNextPagePending([
        AsyncResult.success(FIRST_PAGE),
        AsyncResult.initial<VcsListRefsResult>(true),
      ]),
    ).toBe(true);

    expect(
      isPaginatedBranchesNextPagePending([
        AsyncResult.success(FIRST_PAGE),
        AsyncResult.success(LAST_PAGE),
      ]),
    ).toBe(false);
  });
});

describe("paginated branch scroll trigger", () => {
  it("does not load from mount, layout, or an unchanged scroll position", () => {
    expect(
      shouldLoadNextBranchPageAfterScroll({
        previousScrollTop: null,
        scrollTop: 0,
        scrollHeight: 224,
        clientHeight: 224,
      }),
    ).toBe(false);

    expect(
      shouldLoadNextBranchPageAfterScroll({
        previousScrollTop: 120,
        scrollTop: 120,
        scrollHeight: 344,
        clientHeight: 224,
      }),
    ).toBe(false);
  });

  it("does not load when scrolling upward near the bottom", () => {
    expect(
      shouldLoadNextBranchPageAfterScroll({
        previousScrollTop: 160,
        scrollTop: 150,
        scrollHeight: 450,
        clientHeight: 224,
      }),
    ).toBe(false);
  });

  it("loads only after a downward scroll reaches the end threshold", () => {
    expect(
      shouldLoadNextBranchPageAfterScroll({
        previousScrollTop: 0,
        scrollTop: 100,
        scrollHeight: 800,
        clientHeight: 224,
      }),
    ).toBe(false);

    expect(
      shouldLoadNextBranchPageAfterScroll({
        previousScrollTop: 100,
        scrollTop: 500,
        scrollHeight: 800,
        clientHeight: 224,
      }),
    ).toBe(true);

    expect(
      shouldLoadNextBranchPageAfterScroll({
        previousScrollTop: 499.5,
        scrollTop: 500,
        scrollHeight: 800,
        clientHeight: 224,
      }),
    ).toBe(true);
  });
});
