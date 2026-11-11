import * as Result from "effect/Result";
import { expect, it } from "vite-plus/test";

import { decodeGitHubPullRequestListJson } from "./gitHubPullRequests.ts";

// gh before 2.47 names the head repository without its owner, and a fork's checkout needs both.
it("names a fork's head repository from its owner when gh leaves nameWithOwner out", () => {
  const decoded = decodeGitHubPullRequestListJson(
    JSON.stringify([
      {
        number: 642,
        title: "fix: use commit as the default git action without origin",
        url: "https://github.com/pingdotgg/t3code/pull/642",
        baseRefName: "main",
        headRefName: "fix/git-action-default-without-origin",
        isCrossRepository: true,
        headRepository: { id: "R_1", name: "t3code" },
        headRepositoryOwner: { login: "binbandit" },
      },
    ]),
  );

  expect(Result.getOrThrow(decoded)[0]).toMatchObject({
    headRepositoryNameWithOwner: "binbandit/t3code",
    headRepositoryOwnerLogin: "binbandit",
  });
});

it("reads lowercase closed and merged states", () => {
  const row = (number: number, state: string) => ({
    number,
    title: "PR",
    url: `https://github.com/pingdotgg/codething-mvp/pull/${number}`,
    baseRefName: "main",
    headRefName: "feature/status-lowercase-state",
    state,
  });
  const decoded = decodeGitHubPullRequestListJson(
    JSON.stringify([row(16, "closed"), row(17, "merged"), row(18, "open")]),
  );

  expect(Result.getOrThrow(decoded).map((pr) => pr.state)).toEqual(["closed", "merged", "open"]);
});
