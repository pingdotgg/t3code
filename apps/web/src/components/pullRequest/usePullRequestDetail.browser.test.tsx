import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetailView,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const queryState = vi.hoisted(() => ({ data: null as PullRequestDetailView | null }));

vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((query: unknown) => ({
    data: query === null ? null : queryState.data,
    dataUpdatedAt: queryState.data ? 1 : 0,
    isPending: query !== null && queryState.data === null,
    isSuccess: query !== null && queryState.data !== null,
    refresh: () => undefined,
  })) as never,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useServerConfigs: () => new Map(),
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));
vi.mock(import("~/state/pullRequests"), async (original) => ({
  ...(await original()),
  useSharedPullRequestSummary: () => null,
}));

import { render } from "../../../test/render";
import { usePullRequestDetail } from "./usePullRequestDetail";

const liveDetailFixture: PullRequestDetailView = {
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
  mergeability: "conflicting",
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
    comment: false,
    search: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: true, comment: false },
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

function Detail({ number = 1 }: { number?: number }) {
  const { detail } = usePullRequestDetail(
    EnvironmentId.make("environment"),
    { projectId: ProjectId.make("project"), repository: "owner/repo", number },
    null,
  );
  return <p>{detail?.title ?? "Loading pull request"}</p>;
}

function setup() {
  queryState.data = null;
}

it("loads live PR details and changes references when cache storage is denied", async () => {
  setup();
  using _storage = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
    throw new DOMException("Access to storage is denied", "SecurityError");
  });
  await using screen = await render(<Detail />, {
    // This tests the detail-loading hook, without navigation.
    router: false,
  });
  await expect.element(screen.getByText("Loading pull request")).toBeVisible();
  queryState.data = liveDetailFixture;
  await screen.rerender(<Detail />);
  await expect.element(screen.getByText(liveDetailFixture.title)).toBeVisible();
  queryState.data = null;
  await screen.rerender(<Detail number={2} />);
  await expect.element(screen.getByText("Loading pull request")).toBeVisible();
});
