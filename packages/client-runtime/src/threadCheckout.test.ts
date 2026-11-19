import { describe, expect, it } from "vite-plus/test";

import { isThreadCheckoutMissing } from "./threadCheckout.ts";

describe("isThreadCheckoutMissing", () => {
  it.each([
    { worktreePath: "/external-wt", worktreeIsRepo: false, projectIsRepo: true, missing: true },
    { worktreePath: "/external-wt", worktreeIsRepo: true, projectIsRepo: true, missing: false },
    // Unknown until both statuses load, and a project that is not a repo has nowhere to move to.
    {
      worktreePath: "/external-wt",
      worktreeIsRepo: undefined,
      projectIsRepo: true,
      missing: false,
    },
    {
      worktreePath: "/external-wt",
      worktreeIsRepo: false,
      projectIsRepo: undefined,
      missing: false,
    },
    { worktreePath: "/external-wt", worktreeIsRepo: false, projectIsRepo: false, missing: false },
    { worktreePath: null, worktreeIsRepo: false, projectIsRepo: true, missing: false },
  ])("$worktreePath, worktree repo $worktreeIsRepo, project repo $projectIsRepo", (input) => {
    expect(isThreadCheckoutMissing(input)).toBe(input.missing);
  });
});
