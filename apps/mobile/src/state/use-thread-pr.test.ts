import { describe, expect, it } from "@effect/vitest";

import { presentThreadPr } from "./use-thread-pr";

const pullRequest = {
  number: 137,
  title: "Add sidebar filter",
  url: "https://example.test/pr/137",
  baseBranch: "main",
  headBranch: "feat/sidebar-filter",
  state: null,
} as const;

describe("presentThreadPr", () => {
  it("presents unknown historical state without fabricating a status", () => {
    expect(presentThreadPr(pullRequest, null)).toEqual({
      number: 137,
      state: null,
      url: pullRequest.url,
      label: "PR",
      textClassName: "text-sky-600 dark:text-sky-400",
    });
  });
});
