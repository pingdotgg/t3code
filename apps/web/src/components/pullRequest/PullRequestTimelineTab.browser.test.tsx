import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetailView,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import "../../index.css";
import { PullRequestTimelineTab } from "./PullRequestTimelineTab";

const COMMITS = 2000;

const detail: PullRequestDetailView = {
  provider: SourceControlProviderKind.make("github"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Huge pull request",
  body: "",
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
  checks: [],
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: Array.from({ length: COMMITS }, (_, index) => ({
    oid: `${index.toString(16).padStart(7, "0")}${"0".repeat(33)}`,
    messageHeadline: `Commit number ${index}`,
    committedDate: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
  })),
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: true,
    search: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: false, comment: false },
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

it("mounts only the timeline rows near the viewport of a huge pull request", async () => {
  await using screen = await render(
    <div style={{ height: 600 }}>
      <PullRequestTimelineTab
        scrollerRef={() => {}}
        detail={detail}
        environmentId={EnvironmentId.make("environment")}
        reference={detail}
        order="oldest"
        onOpenCommit={() => {}}
        onRefresh={() => {}}
      />
    </div>,
  );
  await expect.element(screen.getByText("Commit number 0")).toBeVisible();
  const mounted = screen.container.querySelectorAll("button").length;
  expect(mounted).toBeGreaterThan(0);
  expect(mounted).toBeLessThan(COMMITS / 10);
});
