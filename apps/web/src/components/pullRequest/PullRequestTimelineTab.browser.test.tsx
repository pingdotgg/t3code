import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetailView,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { PullRequestReviewContext } from "./PullRequestReviewContext";
import { PullRequestTimelineTab } from "./PullRequestTimelineTab";

const detail: PullRequestDetailView = {
  provider: SourceControlProviderKind.make("github"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Test pull request",
  body: "Original description",
  url: "https://github.com/owner/repo/pull/1",
  author: { login: "author", name: null, avatarUrl: null },
  viewer: "author",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [{ name: "Unit tests", status: "success", description: null, url: null }],
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: true,
    search: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: true, comment: true },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

it.each(["first visit", "no review context"])(
  "does not offer What's new with %s",
  async (visit) => {
    const environmentId = EnvironmentId.make("environment");
    await using screen = await render(
      <PullRequestReviewContext
        value={
          visit === "first visit"
            ? {
                environmentId,
                reference: detail,
                azure: false,
                previousVisit: null,
              }
            : null
        }
      >
        <PullRequestTimelineTab
          scrollerRef={() => {}}
          environmentId={environmentId}
          reference={detail}
          detail={detail}
          order="newest"
          onOpenCommit={() => {}}
          onRefresh={() => {}}
        />
      </PullRequestReviewContext>,
    );
    await expect
      .element(screen.getByRole("button", { name: "What's new", exact: true }))
      .not.toBeInTheDocument();
  },
);

it("explains an empty What's new timeline and restores activity when the filter is cleared", async () => {
  const environmentId = EnvironmentId.make("environment");
  const activity = "Reviewer approved the pull request with suggestions";
  const azure: PullRequestDetailView = {
    ...detail,
    provider: SourceControlProviderKind.make("azure-devops"),
    events: [
      {
        id: "vote",
        kind: "approved",
        actor: { login: "reviewer", name: "Reviewer", avatarUrl: null },
        body: activity,
        createdAt: detail.createdAt,
      },
    ],
  };
  await using screen = await render(
    <PullRequestReviewContext
      value={{
        environmentId,
        reference: azure,
        azure: true,
        previousVisit: "2026-09-02T00:00:00Z",
      }}
    >
      <PullRequestTimelineTab
        scrollerRef={() => {}}
        environmentId={environmentId}
        reference={azure}
        detail={azure}
        order="newest"
        onOpenCommit={() => {}}
        onRefresh={() => {}}
      />
    </PullRequestReviewContext>,
  );
  await expect.element(screen.getByText(activity, { exact: true })).toBeVisible();
  const filter = screen.getByRole("button", { name: "What's new", exact: true });
  await filter.click();
  await expect.element(screen.getByText("Nothing new since your last visit.")).toBeVisible();
  await expect.element(screen.getByText(activity, { exact: true })).not.toBeInTheDocument();
  await filter.click();
  await expect.element(screen.getByText(activity, { exact: true })).toBeVisible();
  await expect
    .element(screen.getByText("Nothing new since your last visit."))
    .not.toBeInTheDocument();
});
