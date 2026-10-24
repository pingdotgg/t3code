import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetailView,
  type PullRequestDiffResult,
  type PullRequestFilesViewedResult,
} from "@t3tools/contracts";
import { expect, it, onTestFinished, vi } from "vite-plus/test";

import "~/index.css";

const { diffAtom, filesViewedAtom } = await vi.hoisted(async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const firstPage: PullRequestDiffResult = {
    patch: [
      "diff --git a/a.ts b/a.ts",
      "index 1111111..2222222 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-before()",
      "+after()",
      "",
    ].join("\n"),
    truncated: false,
    nextCursor: null,
  };
  // An environment query whose refetch returns equal content hands back the previous value
  // itself, so a refresh publishes a new result around the very same page.
  const filesViewed: PullRequestFilesViewedResult = {
    files: [{ path: "a.ts", state: "viewed" }],
    truncated: false,
  };
  return {
    diffAtom: Atom.make(() => AsyncResult.success(firstPage)),
    filesViewedAtom: Atom.make(() => AsyncResult.success(filesViewed)),
  };
});

const settingsOverrides = vi.hoisted((): { diffFilesCollapsed?: boolean } => ({}));
vi.mock(import("~/hooks/useSettings"), async (original) => {
  const actual = await original();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  function useClientSettings<T = Settings>(select?: (settings: Settings) => T): T {
    const settings = { ...actual.getClientSettings(), ...settingsOverrides };
    return select ? select(settings) : (settings as T);
  }
  return { ...actual, useClientSettings };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      diff: (() => diffAtom) as never,
      filesViewed: (() => filesViewedAtom) as never,
    },
  };
});

import { render } from "../../../test/render";
import PullRequestCodeTab from "./PullRequestCodeTab";

const detail: PullRequestDetailView = {
  provider: SourceControlProviderKind.make("github"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Test pull request",
  body: "",
  url: "https://github.com/owner/repo/pull/1",
  author: { login: "author", name: null, avatarUrl: null },
  viewer: "author",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 1,
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
  commits: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: false,
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

const tab = (refreshToken: number, tabDetail: PullRequestDetailView = detail) => (
  <PullRequestCodeTab
    scrollerRef={() => {}}
    environmentId={EnvironmentId.make("environment")}
    reference={tabDetail}
    detail={tabDetail}
    selectedCommitOid={null}
    onSelectedCommitChange={() => {}}
    onRefresh={() => {}}
    refreshToken={refreshToken}
  />
);

it("keeps the diff after a refresh that brings back the same page", async () => {
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  await using screen = await render(tab(0), { container });
  await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();

  await screen.rerender(tab(1));

  await expect
    .element(screen.getByText("This pull request has no file changes."))
    .not.toBeInTheDocument();
  await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();
});

it("opens a file already marked viewed folded when diffs open expanded", async () => {
  settingsOverrides.diffFilesCollapsed = false;
  onTestFinished(() => {
    delete settingsOverrides.diffFilesCollapsed;
  });
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  const viewedDetail: PullRequestDetailView = {
    ...detail,
    capabilities: { ...detail.capabilities, viewedFiles: "host" },
  };
  await using screen = await render(tab(0, viewedDetail), { container });

  await expect.element(screen.getByRole("checkbox", { name: "Viewed" })).toBeChecked();
  await expect.element(screen.getByRole("button", { name: "Expand diff" })).toBeVisible();
});
