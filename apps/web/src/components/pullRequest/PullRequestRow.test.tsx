import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PullRequestRow } from "./PullRequestRow";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";

const entry = {
  environmentId: "env-1" as EnvironmentPullRequestEntry["environmentId"],
  provider: "github",
  host: "github.com",
  projectId: "project-1" as EnvironmentPullRequestEntry["projectId"],
  projectTitle: "T3 Code",
  repository: "pingdotgg/t3code",
  number: 6315,
  title: "Add the issues workspace",
  url: "https://github.com/pingdotgg/t3code/pull/6315",
  author: { login: "octocat", name: null, avatarUrl: null },
  headBranch: "feat/issues-page",
  baseBranch: "main",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  createdAt: "2026-08-27T00:00:00Z",
  updatedAt: "2026-08-28T00:00:00Z",
  viewerReviewRequested: false,
  labels: [],
} as EnvironmentPullRequestEntry;

describe("PullRequestRow", () => {
  it("uses a checkbox for task selection without marking the row current", () => {
    const markup = renderToStaticMarkup(
      <PullRequestRow
        entry={entry}
        selected={false}
        selectionChecked={false}
        showProjectTitle={false}
        showProvider={false}
        onSelect={() => undefined}
        onToggleSelection={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Select pingdotgg/t3code pull request #6315"');
    expect(markup).toContain("group-hover/row:opacity-100");
    expect(markup).toContain("[&amp;&gt;button]:pl-10");
    expect(markup).not.toContain("aria-current");
    expect(
      markup.indexOf('aria-label="Select pingdotgg/t3code pull request #6315"'),
    ).toBeGreaterThan(markup.indexOf("</button>"));
  });
});
