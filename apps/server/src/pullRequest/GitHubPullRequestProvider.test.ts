import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { PullRequestReaction } from "@t3tools/contracts";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubPullRequestCli from "./GitHubPullRequestCli.ts";
import { gitHubViewerPermissions, loginAvatarUrl, make } from "./GitHubPullRequestProvider.ts";
import type { GitHubReviewThreadComments } from "./gitHubPullRequestJson.ts";

it.effect("uses one narrow read for a linked pull request summary", () =>
  Effect.gen(function* () {
    let summaryReads = 0;
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
          getPullRequestSummary: () =>
            Effect.sync(() => {
              summaryReads += 1;
              return {
                number: 7,
                title: "Summary",
                url: "https://github.com/acme/web/pull/7",
                headBranch: "feat/summary",
                baseBranch: "main",
                state: "open" as const,
                updatedAt: "2026-08-24T12:34:56.000Z",
              };
            }),
        }),
      ),
    );

    const readSummary = provider.getChangeRequestSummary;
    if (readSummary === undefined) return yield* Effect.die("summary read was not implemented");
    const summary = yield* readSummary({
      cwd: "/w",
      repository: "acme/web",
      host: "github.com",
      number: 7,
    });

    expect(summary.state).toBe("open");
    expect(summaryReads).toBe(1);
  }),
);

describe("gitHubViewerPermissions", () => {
  it("offers everything to a viewer who can write to the repository", () => {
    expect(
      gitHubViewerPermissions({
        canWrite: true,
        canTriage: true,
        canUpdate: true,
        didAuthor: false,
      }),
    ).toEqual({
      // Arming a merge for later is the merge, so it travels with it.
      actions: [
        "merge",
        "enable-auto-merge",
        "disable-auto-merge",
        "revert",
        "approve-workflows",
        "ready",
        "draft",
        "close",
        "reopen",
      ],
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve", "request-changes"],
      requestReviewers: true,
      labels: true,
    });
  });

  it("leaves a passer-by on a repository they can only read nothing but the review", () => {
    // Every open-source pull request somebody else opened: GitHub says no to all five actions
    // and to resolving, and yes to commenting and to every verdict.
    expect(
      gitHubViewerPermissions({
        canWrite: false,
        canTriage: false,
        canUpdate: false,
        didAuthor: false,
      }),
    ).toEqual({
      actions: [],
      comment: true,
      resolve: false,
      verdicts: ["comment", "approve", "request-changes"],
      // Asking somebody else to review is the one thing read access never stretches to.
      requestReviewers: false,
      labels: false,
    });
  });

  it("lets a triager label without letting them merge or ask for a review", () => {
    const permissions = gitHubViewerPermissions({
      canWrite: false,
      canTriage: true,
      canUpdate: false,
      didAuthor: false,
    });
    expect(permissions.labels).toBe(true);
    expect(permissions.requestReviewers).toBe(false);
    expect(permissions.actions).toEqual([]);
  });

  it("keeps an author's own pull request theirs to close, with read access and no more", () => {
    expect(
      gitHubViewerPermissions({
        canWrite: false,
        canTriage: false,
        canUpdate: true,
        didAuthor: true,
      }),
    ).toEqual({
      // Merging is the one thing writing is needed for, now or later; the rest an author may do.
      actions: ["ready", "draft", "close", "reopen"],
      comment: true,
      resolve: true,
      // GitHub refuses an author's approval of their own change, so the page does not offer one.
      verdicts: ["comment"],
      requestReviewers: false,
      labels: false,
    });
  });

  it.effect("uses the small viewer-access read for core permissions", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const detail = yield* provider.getChangeRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      expect(detail.viewerPermissions).toEqual({
        actions: ["ready", "draft", "close", "reopen"],
        comment: true,
        resolve: false,
        verdicts: ["comment", "approve", "request-changes"],
        requestReviewers: false,
        labels: false,
      });
      expect(detail.workflowApprovalsRequired).toBeUndefined();
      expect(detail.checks).toContainEqual({
        name: "Workflow approval status",
        status: "action-required",
        description: "GitHub could not determine whether workflows are awaiting approval.",
        url: null,
      });
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
          getPullRequestDetail: () =>
            Effect.succeed({
              authorId: null,
              number: 7,
              title: "Pull request 7",
              url: "https://github.com/acme/web/pull/7",
              author: null,
              isCrossRepository: true,
              headRepositoryOwner: null,
              headBranch: "feat/page",
              baseBranch: "main",
              state: "open",
              isDraft: false,
              mergeability: "mergeable",
              reviewDecision: null,
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
              commits: [],
            }),
          getRepositoryAccess: () =>
            Effect.succeed({
              canWrite: false,
              mergeCapabilities: { merge: true, squash: true, rebase: true },
            }),
          getViewerAccess: () =>
            Effect.succeed({
              canWrite: false,
              canTriage: false,
              canUpdate: true,
              didAuthor: false,
            }),
        }),
      ),
    ),
  );

  it.effect("keeps fork workflows awaiting approval out of the passing state", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const detail = yield* provider.getChangeRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      expect(detail.workflowApprovalsRequired).toBe(1);
      expect(detail.checks).toEqual([
        {
          name: "manual gate",
          status: "action-required",
          description: null,
          url: "https://example.com/manual-gate",
        },
        {
          name: "build",
          status: "success",
          description: null,
          url: null,
        },
        {
          name: "contributor tests",
          status: "action-required",
          description: "A maintainer must approve this workflow before it can run.",
          url: "https://github.com/acme/web/actions/runs/123",
        },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
          getPullRequestDetail: () =>
            Effect.succeed({
              authorId: null,
              number: 7,
              title: "Pull request 7",
              url: "https://github.com/acme/web/pull/7",
              author: null,
              isCrossRepository: true,
              headRepositoryOwner: "octocat",
              headSha: "abc123",
              headBranch: "feat/page",
              baseBranch: "main",
              state: "open",
              isDraft: false,
              mergeability: "mergeable",
              reviewDecision: null,
              additions: 1,
              deletions: 1,
              createdAt: "2026-07-01T00:00:00Z",
              updatedAt: "2026-07-02T00:00:00Z",
              reviewRequestLogins: [],
              hasTeamReviewRequest: false,
              checksState: "passing",
              labels: [],
              body: "",
              changedFiles: 1,
              mergedAt: null,
              closedAt: null,
              checks: [
                {
                  name: "manual gate",
                  status: "action-required",
                  description: null,
                  url: "https://example.com/manual-gate",
                },
                { name: "build", status: "success", description: null, url: null },
              ],
              comments: [],
              commits: [],
            }),
          listWorkflowRunsRequiringApproval: () =>
            Effect.succeed([
              {
                id: 123,
                name: "contributor tests",
                url: "https://github.com/acme/web/actions/runs/123",
              },
            ]),
          getPullRequestBaseComparison: () =>
            Effect.succeed({ behindBy: 0, viewerCanUpdate: true }),
          getRepositoryAccess: () =>
            Effect.succeed({
              canWrite: true,
              mergeCapabilities: { merge: true, squash: true, rebase: true },
            }),
          getViewerAccess: () =>
            Effect.succeed({ canWrite: true, canTriage: true, canUpdate: true, didAuthor: false }),
        }),
      ),
    ),
  );
});

const openDetail = {
  authorId: null,
  number: 7,
  title: "Pull request 7",
  url: "https://github.com/acme/web/pull/7",
  author: null,
  isCrossRepository: true,
  headRepositoryOwner: "acme",
  headSha: "abc123",
  headBranch: "feat/page",
  baseBranch: "main",
  state: "open" as const,
  isDraft: false,
  mergeability: "mergeable" as const,
  reviewDecision: null,
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
  commits: [],
};

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
      Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
        getPullRequestDetail: () => Effect.succeed({ ...openDetail, isCrossRepository: false }),
        getPullRequestBaseComparison: () => Effect.succeed({ behindBy: 0, viewerCanUpdate: true }),
        listWorkflowRunsRequiringApproval: () =>
          Effect.die("same-repository pull requests must not probe fork workflow approvals"),
        getRepositoryAccess: () =>
          Effect.succeed({
            canWrite: true,
            mergeCapabilities: { merge: true, squash: true, rebase: true },
          }),
        getViewerAccess: () =>
          Effect.succeed({ canWrite: true, canTriage: true, canUpdate: true, didAuthor: false }),
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
      Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
        getPullRequestDetail: () => Effect.succeed(openDetail),
        getPullRequestBaseComparison: () => Effect.succeed({ behindBy: 0, viewerCanUpdate: true }),
        listWorkflowRunsRequiringApproval: () =>
          Effect.fail(
            new GitHubPullRequestCli.GitHubWorkflowApprovalRefusedError({
              command: "gh",
              cwd: "/w",
              number: 7,
              reason: "head-not-unique",
              observedCount: 2,
              limit: 1_000,
            }),
          ),
        getRepositoryAccess: () =>
          Effect.succeed({
            canWrite: true,
            mergeCapabilities: { merge: true, squash: true, rebase: true },
          }),
        getViewerAccess: () =>
          Effect.succeed({ canWrite: true, canTriage: true, canUpdate: true, didAuthor: false }),
      }),
    ),
  ),
);

it.effect("propagates workflow discovery rate limits", () =>
  Effect.gen(function* () {
    const provider = yield* make;
    const error = yield* provider
      .getChangeRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      })
      .pipe(Effect.flip);

    expect(error.operation).toBe("getChangeRequest");
    expect(error.reason).toBe("rate-limited");
  }).pipe(
    Effect.provide(
      Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
        getPullRequestDetail: () => Effect.succeed(openDetail),
        getPullRequestBaseComparison: () => Effect.succeed({ behindBy: 0, viewerCanUpdate: true }),
        listWorkflowRunsRequiringApproval: () =>
          Effect.fail(
            new GitHubCli.GitHubCliRateLimitError({
              command: "gh",
              cwd: "/w",
              cause: new Error("rate limited"),
            }),
          ),
        getRepositoryAccess: () =>
          Effect.succeed({
            canWrite: true,
            mergeCapabilities: { merge: true, squash: true, rebase: true },
          }),
        getViewerAccess: () =>
          Effect.succeed({ canWrite: true, canTriage: true, canUpdate: true, didAuthor: false }),
      }),
    ),
  ),
);

describe("getViewerPermissions", () => {
  const layerWithComparison = (
    comparison: Effect.Effect<{
      readonly behindBy: number | null;
      readonly viewerCanUpdate: boolean;
    }>,
  ) =>
    Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
      getPullRequestDetail: () => Effect.succeed(openDetail),
      getPullRequestBaseComparison: () => comparison,
      getViewerAccess: () =>
        Effect.succeed({ canWrite: true, canTriage: true, canUpdate: true, didAuthor: false }),
    });

  it.effect("offers update-branch when the comparison grants it", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const permissions = yield* provider.getViewerPermissions({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      expect(permissions.actions).toContain("update-branch");
      expect(permissions.updateMethods).toEqual(["merge", "rebase"]);
    }).pipe(
      Effect.provide(layerWithComparison(Effect.succeed({ behindBy: 3, viewerCanUpdate: true }))),
    ),
  );

  it.effect("uses the GraphQL reserve for manual permission checks", () => {
    let viewerAllowReserve: boolean | undefined;
    let comparisonAllowReserve: boolean | undefined;
    return Effect.gen(function* () {
      const provider = yield* make;
      yield* provider.getViewerPermissions({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      expect(viewerAllowReserve).toBe(true);
      expect(comparisonAllowReserve).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
          getPullRequestDetail: () => Effect.succeed(openDetail),
          getPullRequestBaseComparison: (input) =>
            Effect.sync(() => {
              comparisonAllowReserve = input.allowReserve;
              return { behindBy: 3, viewerCanUpdate: true };
            }),
          getViewerAccess: (input) =>
            Effect.sync(() => {
              viewerAllowReserve = input.allowReserve;
              return { canWrite: true, canTriage: true, canUpdate: true, didAuthor: false };
            }),
        }),
      ),
    );
  });

  it.effect("withholds update-branch when the comparison cannot be read", () =>
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
      // The rest of the answer survives a comparison nobody could make.
      expect(permissions.actions).toContain("merge");
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
          getPullRequestDetail: () => Effect.succeed(openDetail),
          getPullRequestBaseComparison: () =>
            Effect.fail(
              new GitHubPullRequestCli.GitHubPullRequestReadError({
                command: "gh",
                cwd: "/w",
                operation: "getPullRequestBaseComparison",
                cause: new Error("unreadable"),
              }),
            ),
          getViewerAccess: () =>
            Effect.succeed({ canWrite: true, canTriage: true, canUpdate: true, didAuthor: false }),
        }),
      ),
    ),
  );
});

describe("getChangeRequest commits", () => {
  const baseDetail = {
    authorId: null,
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
    reactions: [],
    reactionsById: new Map<string, ReadonlyArray<PullRequestReaction>>(),
    reviewers: [],
    avatarsByLogin: new Map<string, string>(),
    commitStats: new Map<string, { readonly additions: number; readonly deletions: number }>(),
    viewer: { canUpdate: true, didAuthor: false },
  };

  const layerWith = (commits: GitHubReviewThreadComments["commits"]) =>
    Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
      getPullRequestActivity: () =>
        Effect.succeed({
          author: baseDetail.author,
          comments: baseDetail.comments,
          commits: [
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

      expect(detail.commits.map((commit) => commit.oid)).toEqual(["view-oldest"]);
    }).pipe(Effect.provide(layerWith([]))),
  );
});

describe("getChangeRequestActivity dismissed reviews", () => {
  const dismissedReview = (body: string) => ({
    id: "PRR_1",
    kind: "review" as const,
    author: null,
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
    reactions: [],
    reactionsById: new Map(),
    reviewers: [],
    avatarsByLogin: new Map(),
    commitStats: new Map(),
    commits: [],
    viewer: { canUpdate: true, didAuthor: false },
  };
  const layerFor = (body: string) =>
    Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
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
    // Macroscope's approvals carry only an HTML comment, which markdown renders as nothing —
    // an empty-string check misses them and the card opens onto nothing.
    readActivity.pipe(
      Effect.map((activity) => {
        expect(activity.comments[0]?.body).toBe("Dismissing prior approval to re-evaluate 9b66581");
      }),
      Effect.provide(layerFor("<!-- Macroscope (Approvability) review body marker -->")),
    ),
  );

  it.effect("keeps the words of a dismissed review that has its own", () =>
    readActivity.pipe(
      Effect.map((activity) => {
        expect(activity.comments[0]?.body).toBe("These findings still stand.");
      }),
      Effect.provide(layerFor("These findings still stand.")),
    ),
  );
});

describe("editing", () => {
  const rewrites: Array<unknown> = [];

  it.effect("hands a rewrite to the CLI as the request named it", () =>
    Effect.gen(function* () {
      const provider = yield* make;

      expect(provider.capabilities.edit).toEqual({ changeRequest: true, comment: true });
      yield* provider.updateChangeRequest!({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        title: "A better title",
      });
      yield* provider.updateComment!({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        commentId: "IC_1",
        kind: "review-comment",
        body: "Reworded.",
      });

      expect(rewrites).toEqual([
        {
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          title: "A better title",
        },
        {
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          commentId: "IC_1",
          kind: "review-comment",
          body: "Reworded.",
        },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
          updatePullRequest: (input) => Effect.sync(() => void rewrites.push(input)),
          updateComment: (input) => Effect.sync(() => void rewrites.push(input)),
        }),
      ),
    ),
  );
});

describe("loginAvatarUrl", () => {
  it("serves a user's picture from the host they belong to", () => {
    expect(loginAvatarUrl("octocat", "github.com")).toBe("https://github.com/octocat.png?size=80");
    expect(loginAvatarUrl("octocat", "ghe.example.com")).toBe(
      "https://ghe.example.com/octocat.png?size=80",
    );
  });

  it("has nothing for an app, which names no page", () => {
    // `dependabot[bot]` has a picture, but not at `/dependabot[bot].png` — a guess that 404s is
    // worse than the initials it would replace.
    expect(loginAvatarUrl("dependabot[bot]", "github.com")).toBeNull();
  });

  it("refuses anything that is not a login, rather than building a URL out of it", () => {
    for (const login of ["../../etc", "a b", "-leading", "x".repeat(40), ""]) {
      expect(loginAvatarUrl(login, "github.com")).toBeNull();
    }
  });
});
