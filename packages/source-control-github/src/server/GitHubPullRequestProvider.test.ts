import {
  describe,
  expect,
  it,
} from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import type { PullRequestReaction } from "@t3tools/contracts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import type { GitHubPullRequestCore, GitHubPullRequestSearchItem } from "./gitHubPullRequestJson.ts";
import { loginAvatarUrl, make } from "./GitHubPullRequestProvider.ts";
import type { GitHubReviewThreadComments } from "./gitHubPullRequestJson.ts";
import { openDetail } from "./GitHubPullRequestProvider.part2.testkit.ts";

it.effect("does not classify same-repository gates as fork workflow approvals", () =>
  Effect.gen(function* () {
    const provider = yield* make;
    const detail = yield* provider.getChangeRequest({
      cwd: "/w",
      repository: "acme/web",
      host: "github.com",
      number: 7,
    });

    expect(detail.workflowApprovalsRequired).toBe(0);
    expect(detail.checks).toEqual([]);
  }).pipe(
    Effect.provide(
      Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
        revalidateChecks: (_input, read) => read,
        getPullRequestDetail: () => Effect.succeed({ ...openDetail, isCrossRepository: false }),
        listWorkflowRunsRequiringApproval: () =>
          Effect.die("same-repository pull requests must not probe fork workflow approvals"),
        getViewerAccess: () =>
          Effect.succeed({
            canWrite: true,
            canTriage: true,
            canUpdate: true,
            didAuthor: false,
            mergeCapabilities: { merge: true, squash: true, rebase: true },
            autoMergeAllowed: true,
          }),
      }),
    ),
  ),
);

it.effect("keeps an unsafe workflow approval scope visible as unknown", () =>
  Effect.gen(function* () {
    const provider = yield* make;
    const detail = yield* provider.getChangeRequest({
      cwd: "/w",
      repository: "acme/web",
      host: "github.com",
      number: 7,
    });

    expect(detail.workflowApprovalsRequired).toBeUndefined();
    expect(detail.checks).toEqual([
      {
        name: "Workflow approval status",
        status: "action-required",
        description: "GitHub could not determine whether workflows are awaiting approval.",
        url: null,
      },
    ]);
  }).pipe(
    Effect.provide(
      Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
        revalidateChecks: (_input, read) => read,
        getPullRequestDetail: () => Effect.succeed(openDetail),
        listWorkflowRunsRequiringApproval: () =>
          Effect.fail(
            new GitHubPullRequestApi.GitHubWorkflowApprovalRefusedError({
              cwd: "/w",
              number: 7,
              reason: "head-not-unique",
              observedCount: 2,
              limit: 1_000,
            }),
          ),
        getViewerAccess: () =>
          Effect.succeed({
            canWrite: true,
            canTriage: true,
            canUpdate: true,
            didAuthor: false,
            mergeCapabilities: { merge: true, squash: true, rebase: true },
            autoMergeAllowed: true,
          }),
      }),
    ),
  ),
);

describe("getViewerPermissions", () => {
  const access = {
    canWrite: true,
    canTriage: true,
    canUpdate: true,
    didAuthor: false,
    mergeCapabilities: { merge: true, squash: true, rebase: true },
    autoMergeAllowed: true,
  };

  const layerWithDetail = (
    detail: Effect.Effect<GitHubPullRequestCore, GitHubPullRequestApi.GitHubPullRequestApiError>,
    onDetail: (allowReserve: boolean) => void = () => {},
  ) =>
    Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
      revalidateChecks: (_input, read) => read,
      getPullRequestDetail: () =>
        SourceControlRateLimit.Interactive.pipe(
          Effect.tap((allowReserve) => Effect.sync(() => onDetail(allowReserve))),
          Effect.flatMap(() => detail),
        ),
      getViewerAccess: () => Effect.die("Unexpected access read"),
    });

  it.effect("answers access and update-branch from the one detail read", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const permissions = yield* provider.getViewerPermissions({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      expect(permissions.actions).toContain("merge");
      expect(permissions.actions).toContain("update-branch");
      expect(permissions.updateMethods).toEqual(["merge", "rebase"]);
    }).pipe(
      Effect.provide(
        layerWithDetail(
          Effect.succeed({ ...openDetail, comparison: { behindBy: 3, viewerCanUpdate: true } }),
        ),
      ),
    ),
  );

  it.effect("still answers from the light access read when the detail read fails", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const permissions = yield* provider.getViewerPermissions({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });
      expect(permissions.actions).toContain("merge");
      expect(permissions.actions).not.toContain("update-branch");
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
          revalidateChecks: (_input, read) => read,
          getPullRequestDetail: () =>
            Effect.fail(
              new GitHubPullRequestApi.GitHubPullRequestReadError({
                cwd: "/w",
                operation: "getPullRequestDetail",
                cause: new Error("head changed"),
              }),
            ),
          getViewerAccess: () => Effect.succeed(access),
        }),
      ),
    ),
  );

  it.effect("withholds update-branch where GitHub could not compare the branch", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const permissions = yield* provider.getViewerPermissions({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      expect(permissions.actions).not.toContain("update-branch");
      expect(permissions.updateMethods).toBeUndefined();
      expect(permissions.actions).toContain("merge");
    }).pipe(Effect.provide(layerWithDetail(Effect.succeed({ ...openDetail, comparison: null })))),
  );
});

describe("getChangeRequest commits", () => {
  const baseDetail = {
    number: 7,
    title: "Pull request 7",
    url: "https://github.com/acme/web/pull/7",
    author: null,
    headBranch: "feat/page",
    baseBranch: "main",
    state: "open" as const,
    isDraft: false,
    mergeability: "mergeable" as const,
    additions: 1,
    deletions: 1,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    reviewRequestLogins: [],
    hasTeamReviewRequest: false,
    checksState: null,
    labels: [],
    body: "",
    changedFiles: 1,
    mergedAt: null,
    closedAt: null,
    checks: [],
    comments: [],
  };

  const baseThreadComments = {
    comments: [],
    dismissalsByReviewId: new Map<string, string>(),
    reviewThreads: [],
    commentCount: 0,
    truncated: false,
    reviewThreadsTruncated: false,
    reactions: [],
    reactionsById: new Map<string, ReadonlyArray<PullRequestReaction>>(),
    editedAtById: new Map<string, string>(),
    reviewers: [],
    avatarsByLogin: new Map<string, string>(),
    botLogins: new Set<string>(),
    viewer: { canUpdate: true, didAuthor: false },
  };

  const layerWith = (commits: GitHubReviewThreadComments["commits"]) =>
    Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
      revalidateChecks: (_input, read) => read,
      getPullRequestActivity: () =>
        Effect.succeed({
          author: baseDetail.author,
          comments: baseDetail.comments,
          commits: [
            {
              oid: "graphql-newest",
              messageHeadline: "Activity metadata",
              committedDate: "2026-07-06T00:00:00Z",
              additions: 18,
              deletions: 7,
              authors: [],
            },
            {
              oid: "view-oldest",
              messageHeadline: "gh pr view's oldest commit",
              committedDate: "2026-01-01T00:00:00Z",
              authors: [],
            },
          ],
        }),
      listReviewThreadComments: () => Effect.succeed({ ...baseThreadComments, commits }),
    });

  it.effect("prefers the GraphQL commits, which are the newest, over the gh view list", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const detail = yield* provider.getChangeRequestActivity({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      expect(detail.commits.map((commit) => commit.oid)).toEqual(["graphql-newest"]);
      expect(detail.commits[0]).toMatchObject({
        messageHeadline: "the newest commit gh pr view drops",
        additions: 18,
        deletions: 7,
      });
    }).pipe(
      Effect.provide(
        layerWith([
          {
            oid: "graphql-newest",
            messageHeadline: "the newest commit gh pr view drops",
            committedDate: "2026-07-06T00:00:00Z",
            authors: [],
          },
        ]),
      ),
    ),
  );

  it.effect("falls back to the gh view list when the GraphQL read has no commits", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const detail = yield* provider.getChangeRequestActivity({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      expect(detail.commits.map((commit) => commit.oid)).toEqual(["graphql-newest", "view-oldest"]);
    }).pipe(Effect.provide(layerWith([]))),
  );
});

describe("getChangeRequestActivity dismissed reviews", () => {
  const dismissedReview = (body: string) => ({
    id: "PRR_1",
    kind: "review" as const,
    author: { login: "macroscopeapp", name: null, avatarUrl: null },
    body,
    createdAt: "2026-07-03T00:00:00Z",
    url: null,
    path: null,
    reviewState: "DISMISSED",
  });
  const threadComments: GitHubReviewThreadComments = {
    comments: [],
    dismissalsByReviewId: new Map([["PRR_1", "Dismissing prior approval to re-evaluate 9b66581"]]),
    reviewThreads: [],
    commentCount: 0,
    truncated: false,
    reviewThreadsTruncated: false,
    reactions: [],
    reactionsById: new Map(),
    editedAtById: new Map([["PRR_1", "2026-07-04T00:00:00Z"]]),
    reviewers: [],
    avatarsByLogin: new Map(),
    botLogins: new Set(["macroscopeapp"]),
    commits: [],
    viewer: { canUpdate: true, didAuthor: false },
  };
  const layerFor = (body: string) =>
    Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
      revalidateChecks: (_input, read) => read,
      getPullRequestActivity: () =>
        Effect.succeed({ author: null, comments: [dismissedReview(body)], commits: [] }),
      listReviewThreadComments: () => Effect.succeed(threadComments),
    });
  const readActivity = Effect.gen(function* () {
    const provider = yield* make;
    return yield* provider.getChangeRequestActivity({
      cwd: "/w",
      repository: "acme/web",
      host: "github.com",
      number: 7,
    });
  });

  it.effect("fills a marker-only dismissed review with the timeline's reason", () =>
    readActivity.pipe(
      Effect.map((activity) => {
        expect(activity.comments[0]?.body).toBe("Dismissing prior approval to re-evaluate 9b66581");
        expect(activity.comments[0]?.author?.isBot).toBe(true);
        expect(activity.comments[0]?.editedAt).toBe("2026-07-04T00:00:00Z");
      }),
      Effect.provide(layerFor("<!-- Macroscope (Approvability) review body marker -->")),
    ),
  );
});

describe("loginAvatarUrl", () => {
  it("refuses anything that is not a login, rather than building a URL out of it", () => {
    for (const login of ["../../etc", "a b", "-leading", "x".repeat(40), ""]) {
      expect(loginAvatarUrl(login, "github.com")).toBeNull();
    }
  });
});

describe("listChangeRequestsAcross", () => {
  const searched = (repository: string): GitHubPullRequestSearchItem => ({
    repository,
    number: 1,
    title: "Change",
    url: `https://github.com/${repository}/pull/1`,
    author: null,
    headBranch: "feature",
    baseBranch: "main",
    state: "open" as const,
    isDraft: false,
    mergeability: "mergeable" as const,
    additions: 0,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    reviewRequestLogins: [],
    hasTeamReviewRequest: false,
    labels: [],
    reviewDecision: null,
    checksState: null,
  });
  const across = {
    cwd: "/w",
    host: "github.com",
    repositories: ["acme/web", "acme/docs"],
    state: "open" as const,
    involvement: "all" as const,
    viewer: "viewer",
    limit: 50,
  };
  type Search = Parameters<
    GitHubPullRequestApi.GitHubPullRequestApi["Service"]["searchPullRequests"]
  >[0];
  // Pages answer in turn; a one-repository check for any pull request answers from `covered`.
  const providerAnswering = (input: {
    readonly pages: Array<GitHubPullRequestApi.GitHubPullRequestSearchBatch>;
    readonly covered?: (repository: string) => boolean;
    readonly checks?: Array<string>;
  }) =>
    make.pipe(
      Effect.provide(
        Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
          searchPullRequests: (search: Search) => {
            if (search.state !== "all") return Effect.succeed(input.pages.shift()!);
            const repository = search.repositories[0]!;
            input.checks?.push(repository);
            return input.covered === undefined
              ? Effect.fail(
                  new GitHubPullRequestApi.GitHubViewerLoginUnavailableError({ cwd: search.cwd }),
                )
              : Effect.succeed({
                  items: input.covered(repository) ? [searched(repository)] : [],
                  truncated: false,
                });
          },
        }),
      ),
      Effect.map((provider) => provider.listChangeRequestsAcross!),
    );

  it.effect("believes silence about a repository search covers, and checks it once", () =>
    Effect.gen(function* () {
      const checks: Array<string> = [];
      const read = yield* providerAnswering({
        pages: [
          { items: [searched("acme/web")], truncated: false },
          { items: [searched("acme/web")], truncated: false },
        ],
        covered: () => true,
        checks,
      });
      expect((yield* read(across)).unresolved).toEqual([]);
      expect((yield* read(across)).unresolved).toEqual([]);
      expect(checks).toEqual(["acme/docs"]);
    }),
  );

  it.effect("leaves a repository search does not cover to be read on its own", () =>
    Effect.gen(function* () {
      const read = yield* providerAnswering({
        pages: [{ items: [searched("acme/web")], truncated: false }],
        covered: (repository) => repository !== "acme/docs",
      });
      expect((yield* read(across)).unresolved).toEqual(["acme/docs"]);
    }),
  );

  it.effect("does not check a repository a page had rows for", () =>
    Effect.gen(function* () {
      const checks: Array<string> = [];
      const read = yield* providerAnswering({
        pages: [
          { items: [searched("acme/web"), searched("acme/docs")], truncated: false },
          { items: [searched("acme/web")], truncated: false },
        ],
        covered: () => true,
        checks,
      });
      yield* read(across);
      expect((yield* read(across)).unresolved).toEqual([]);
      expect(checks).toEqual([]);
    }),
  );

  it.effect("vouches for no silent repository in a truncated first slice", () =>
    Effect.gen(function* () {
      const read = yield* providerAnswering({
        pages: [{ items: [searched("acme/web")], truncated: true }],
        covered: () => true,
      });
      expect((yield* read(across)).unresolved).toEqual(["acme/docs"]);
    }),
  );

  it.effect("past the first slice, believes a covered repository and not an uncovered one", () =>
    Effect.gen(function* () {
      const read = yield* providerAnswering({
        pages: [
          { items: [searched("acme/web")], truncated: true },
          { items: [searched("acme/web")], truncated: true },
        ],
        covered: (repository) => repository !== "acme/renamed",
      });
      const later = { ...across, cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 1 } };
      expect((yield* read(later)).unresolved).toEqual([]);
      expect(
        (yield* read({ ...later, repositories: ["acme/web", "acme/renamed"] })).unresolved,
      ).toEqual(["acme/renamed"]);
    }),
  );

  it.effect("asks again after a failed check, and after coverage has had time to change", () =>
    Effect.gen(function* () {
      const checks: Array<string> = [];
      const failing = yield* providerAnswering({
        pages: [
          { items: [searched("acme/web")], truncated: false },
          { items: [searched("acme/web")], truncated: false },
        ],
        checks,
      });
      expect((yield* failing(across)).unresolved).toEqual(["acme/docs"]);
      expect((yield* failing(across)).unresolved).toEqual(["acme/docs"]);
      expect(checks).toEqual(["acme/docs", "acme/docs"]);

      checks.length = 0;
      const read = yield* providerAnswering({
        pages: [
          { items: [searched("acme/web")], truncated: false },
          { items: [searched("acme/web")], truncated: false },
        ],
        covered: () => true,
        checks,
      });
      yield* read(across);
      yield* TestClock.adjust("61 minutes");
      yield* read(across);
      expect(checks).toEqual(["acme/docs", "acme/docs"]);
    }),
  );
});
