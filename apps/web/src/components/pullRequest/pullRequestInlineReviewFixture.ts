import {
  EnvironmentId,
  ProjectId,
  type PullRequestActivity,
  type PullRequestDetail,
  type PullRequestDiffResult,
  type PullRequestRef,
} from "@t3tools/contracts";

export const PULL_REQUEST_INLINE_REVIEW_ENVIRONMENT_ID = EnvironmentId.make(
  "environment-inline-review-fixture",
);

export const PULL_REQUEST_INLINE_REVIEW_REFERENCE: PullRequestRef = {
  projectId: ProjectId.make("project-inline-review-fixture"),
  repository: "octocat/engine",
  number: 42,
};

export const PULL_REQUEST_INLINE_REVIEW_DETAIL: PullRequestDetail = {
  provider: "github",
  capabilities: {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: false,
    review: {
      inlineComment: true,
      reply: false,
      resolve: false,
      verdicts: ["comment"],
    },
    reviewers: {
      request: false,
      listCandidates: false,
    },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: false,
    verdicts: ["comment"],
    requestReviewers: false,
  },
  projectId: PULL_REQUEST_INLINE_REVIEW_REFERENCE.projectId,
  projectTitle: "Engine",
  workspaceRoot: "/fixtures/engine",
  repository: PULL_REQUEST_INLINE_REVIEW_REFERENCE.repository,
  number: PULL_REQUEST_INLINE_REVIEW_REFERENCE.number,
  title: "Stabilize engine updates",
  body: "Keep updates deterministic.",
  url: "https://github.com/octocat/engine/pull/42",
  author: { login: "octocat", name: "Octo Cat", avatarUrl: null },
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  headBranch: "fix/stable-updates",
  baseBranch: "main",
  createdAt: "2026-08-10T12:00:00.000Z",
  updatedAt: "2026-08-11T12:00:00.000Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [],
  mergeCapabilities: {
    merge: false,
    squash: false,
    rebase: false,
  },
};

export const PULL_REQUEST_INLINE_REVIEW_ACTIVITY: PullRequestActivity = {
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
};

export const PULL_REQUEST_INLINE_REVIEW_DIFF: PullRequestDiffResult = {
  patch: [
    "diff --git a/src/engine.ts b/src/engine.ts",
    "index 12ab345..67cd890 100644",
    "--- a/src/engine.ts",
    "+++ b/src/engine.ts",
    "@@ -1,6 +1,6 @@",
    " export function settle(value: number) {",
    "   const before = value;",
    "-  const previous = before - 1;",
    "+  const current = before + 1;",
    "   const stable = before;",
    "   return stable;",
    " }",
  ].join("\n"),
  truncated: false,
  nextCursor: null,
};
