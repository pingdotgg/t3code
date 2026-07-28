import type { VcsListRefsResult } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { isPaginatedBranchesNextPagePending } from "./paginatedBranches";

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
