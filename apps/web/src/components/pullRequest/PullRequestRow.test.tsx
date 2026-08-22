import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import { PullRequestRow } from "./PullRequestRow";

function entry(number: number): EnvironmentPullRequestEntry {
  return {
    environmentId: "env-1" as EnvironmentPullRequestEntry["environmentId"],
    provider: "github",
    host: "github.com",
    projectId: "project-1" as EnvironmentPullRequestEntry["projectId"],
    projectTitle: "t3code",
    repository: "pingdotgg/t3code",
    number,
    title: "Add the pull requests page",
    url: `https://github.com/pingdotgg/t3code/pull/${number}`,
    author: { login: "octocat", name: null, avatarUrl: null },
    headBranch: `feat/branch-${number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    viewerReviewRequested: false,
    labels: [],
  };
}

describe("PullRequestRow interactive cursors", () => {
  it("shows a pointer on selectable rows", () => {
    const html = renderToStaticMarkup(
      <PullRequestRow
        entry={entry(42)}
        selected={false}
        showProjectTitle={false}
        showProvider={false}
        onSelect={() => {}}
      />,
    );

    expect(html).toContain("cursor-pointer");
  });
});
