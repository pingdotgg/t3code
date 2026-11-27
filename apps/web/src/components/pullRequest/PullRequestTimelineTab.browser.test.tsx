import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  ThreadId,
  type PullRequestDetailView,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const linkState = vi.hoisted(() => ({
  openLink: vi.fn(async () => {}),
  useOpenLink: vi.fn(),
}));
vi.mock(import("~/browser/useOpenLink"), () => ({
  useOpenLink: (threadRef: unknown) => {
    linkState.useOpenLink(threadRef);
    return linkState.openLink;
  },
}));

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
        order="oldest"
        onOpenCommit={() => {}}
      />
    </div>,
  );
  await expect.element(screen.getByText("Commit number 0")).toBeVisible();
  const mounted = screen.container.querySelectorAll("button").length;
  expect(mounted).toBeGreaterThan(0);
  expect(mounted).toBeLessThan(COMMITS / 10);
});

it("opens sparse activity and keeps manual choices when more events arrive", async () => {
  const sparse: PullRequestDetailView = {
    ...detail,
    body: "The full pull request description.",
    commits: detail.commits.slice(0, 1),
    comments: [
      {
        id: "review",
        kind: "review",
        author: detail.author,
        body: "The full review text.",
        createdAt: detail.createdAt,
        url: null,
        path: null,
        reviewState: "APPROVED",
      },
    ],
  };
  const tab = (value: PullRequestDetailView) => (
    <div style={{ height: 600 }}>
      <PullRequestTimelineTab
        detail={value}
        environmentId={EnvironmentId.make("environment")}
        order="oldest"
        onOpenCommit={() => {}}
      />
    </div>
  );
  await using screen = await render(tab(sparse));
  await expect.element(screen.getByRole("button", { name: "Hide review text" })).toBeVisible();
  await expect.element(screen.getByText(sparse.body)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Hide review text" }));
  await screen.rerender(tab({ ...sparse, commits: detail.commits.slice(0, 2) }));
  await expect.element(screen.getByRole("button", { name: "Show review text" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Show review text" }));
  await screen.rerender(tab(sparse));
  await expect.element(screen.getByRole("button", { name: "Hide review text" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Hide description" }));
  await screen.rerender(tab({ ...sparse, commits: detail.commits.slice(0, 2) }));
  await screen.rerender(tab(sparse));
  await expect.element(screen.getByRole("button", { name: "Show description" })).toBeVisible();
});

it("gives each review a heading for screen reader navigation", async () => {
  const commented: PullRequestDetailView = {
    ...detail,
    commits: [],
    comments: [
      {
        id: "review",
        kind: "review",
        author: { login: "bob", name: null, avatarUrl: null },
        body: "Looks good",
        createdAt: "2026-10-01T00:00:00Z",
        url: `${detail.url}#pullrequestreview-1`,
        path: null,
        reviewState: "APPROVED",
      },
      {
        id: "comment",
        kind: "issue-comment",
        author: { login: "alice", name: null, avatarUrl: null },
        body: "One question",
        createdAt: "2026-10-01T00:01:00Z",
        url: `${detail.url}#issuecomment-2`,
        path: null,
        reviewState: null,
      },
    ],
  };
  await using screen = await render(
    <div style={{ height: 600 }}>
      <PullRequestTimelineTab
        scrollerRef={() => {}}
        detail={commented}
        environmentId={EnvironmentId.make("environment")}
        order="oldest"
        onOpenCommit={() => {}}
      />
    </div>,
  );
  await expect.element(screen.getByRole("heading", { name: /bob approved/i })).toBeVisible();
});

it("opens activity host links through the link-target setting", async () => {
  linkState.openLink.mockClear();
  linkState.useOpenLink.mockClear();
  const reviewUrl = `${detail.url}#pullrequestreview-1`;
  const commentUrl = `${detail.url}#issuecomment-2`;
  const threadRef = {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread-1"),
  };
  const commented: PullRequestDetailView = {
    ...detail,
    commits: [],
    comments: [
      {
        id: "review",
        kind: "review",
        author: { login: "bob", name: null, avatarUrl: null },
        body: "Looks good",
        createdAt: "2026-10-01T00:00:00Z",
        url: reviewUrl,
        path: null,
        reviewState: "APPROVED",
      },
      {
        id: "comment",
        kind: "issue-comment",
        author: { login: "alice", name: null, avatarUrl: null },
        body: "One question",
        createdAt: "2026-10-01T00:01:00Z",
        url: commentUrl,
        path: null,
        reviewState: null,
      },
    ],
  };
  await using screen = await render(
    <div style={{ height: 600 }}>
      <PullRequestTimelineTab
        scrollerRef={() => {}}
        detail={commented}
        environmentId={threadRef.environmentId}
        threadRef={threadRef}
        order="oldest"
        onOpenCommit={() => {}}
      />
    </div>,
  );
  // The rail links reviews to the host; its comments have no host button.
  await userEvent.click(screen.getByRole("button", { name: "Open review on host" }));
  expect(linkState.useOpenLink).toHaveBeenCalledWith(threadRef);
  expect(linkState.openLink).toHaveBeenLastCalledWith(reviewUrl, {
    event: expect.objectContaining({ metaKey: false, ctrlKey: false }),
  });
});
