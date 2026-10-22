import { expect, it } from "vite-plus/test";

import { pullRequestCheckStatusLabel, summarizePullRequestChecks } from "./pullRequestPresentation";

it("does not call a pending check running when it may still be queued", () => {
  const check = {
    name: "Build",
    status: "pending" as const,
    description: "Branch policy: queued",
    url: null,
  };
  expect(pullRequestCheckStatusLabel(check)).toBe("Pending");
  expect(summarizePullRequestChecks([check])).toBe("1 of 1 pending");
});

it.each([
  [["success", "skipped"], "All checks passed"],
  [["success", "neutral", "skipped"], "1 of 2 passing"],
  [["pending", "skipped"], "1 of 1 pending"],
  [["failure", "skipped"], "1 of 1 failing"],
  [["skipped", "skipped"], "All checks skipped"],
] as const)("excludes skipped checks from the summary for %j", (statuses, expected) => {
  expect(
    summarizePullRequestChecks(
      statuses.map((status) => ({ name: status, status, description: null, url: null })),
    ),
  ).toBe(expected);
});
