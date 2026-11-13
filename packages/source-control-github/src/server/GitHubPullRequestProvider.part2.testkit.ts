// @effect-diagnostics preferSchemaOverJson:off effectFnOpportunity:off
import {
  describe,
  expect,
  it,
} from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import { gitHubViewerPermissions, make } from "./GitHubPullRequestProvider.ts";

const coreFields = {
  maintainerCanModify: true,
  canEditMaintainerEdits: false,
  reviewRequestTeams: [],
  checksTruncated: false,
  comparison: { behindBy: 0, viewerCanUpdate: true },
  viewerAccess: {
    canWrite: true,
    canTriage: true,
    canUpdate: true,
    didAuthor: false,
    mergeCapabilities: { merge: true, squash: true, rebase: true },
    autoMergeAllowed: true,
  },
};

it.effect("maps credential verification failures without relabeling operation failures", () =>
  Effect.gen(function* () {
    let verificationFails = true;
    let operations = 0;
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
          revalidateChecks: (_input, read) => read,
          withVerifiedCredential: (_input, use) =>
            verificationFails
              ? Effect.fail(
                  new GitHubPullRequestApi.GitHubViewerLoginUnavailableError({
                    cwd: "/w",
                  }),
                )
              : use({ accountId: "123", viewer: "viewer", credentialFingerprint: "fingerprint" }),
        }),
      ),
    );
    const verify = provider.withVerifiedCredential;
    if (verify === undefined)
      return yield* Effect.die("credential verification was not implemented");
    const input = { cwd: "/w", host: "github.com" };
    const operation = () =>
      Effect.sync(() => {
        operations++;
      }).pipe(Effect.andThen(Effect.fail("operation-failed")));
    expect(yield* verify(input, operation).pipe(Effect.flip)).toMatchObject({
      _tag: "PullRequestProviderError",
      operation: "routeIdentity",
    });
    expect(operations).toBe(0);
    verificationFails = false;
    expect(yield* verify(input, operation).pipe(Effect.flip)).toBe("operation-failed");
    expect(operations).toBe(1);
  }),
);

it.effect.each([
  { status: 403, githubErrorTypes: [], reason: "forbidden" },
  { status: 503, githubErrorTypes: [], reason: "failed" },
  { status: 200, githubErrorTypes: ["FORBIDDEN"], reason: "forbidden" },
  { status: 200, githubErrorTypes: ["INTERNAL"], reason: "failed" },
  { status: 200, githubErrorTypes: ["FORBIDDEN", "NOT_FOUND"], reason: "forbidden" },
  { status: 200, githubErrorTypes: ["FORBIDDEN", "INTERNAL"], reason: "failed" },
  { status: 200, githubErrorTypes: ["FORBIDDEN", null], reason: "failed" },
])("classifies GitHub response $status as $reason", ({ status, githubErrorTypes, reason }) =>
  Effect.gen(function* () {
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
          revalidateChecks: (_input, read) => read,
          getPullRequestDetail: () =>
            Effect.fail(
              new GitHubRequestPolicy.GitHubApiResponseError({
                host: "github.com",
                operation: "detail",
                status,
                githubErrorTypes,
              }),
            ),
        }),
      ),
    );
    const error = yield* provider
      .getChangeRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      })
      .pipe(Effect.flip);
    expect(error.reason).toBe(reason);
  }),
);

it.effect("advertises standalone branch deletion for source repository writers", () =>
  Effect.gen(function* () {
    let action: string | undefined;
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
          runPullRequestAction: (input) =>
            Effect.sync(() => {
              action = input.action;
            }),
        }),
      ),
    );
    expect(provider.capabilities.deleteBranch).toBe(true);
    expect(provider.capabilities.actions).toContain("delete-branch");
    yield* provider.runAction({
      cwd: "/w",
      repository: "acme/web",
      host: "github.com",
      number: 7,
      action: "delete-branch",
    });
    expect(action).toBe("delete-branch");
    const access = {
      canWrite: false,
      canTriage: false,
      canUpdate: false,
      didAuthor: false,
      canDeleteBranch: true,
      autoMergeAllowed: true,
    };
    expect(gitHubViewerPermissions(access).actions).toContain("delete-branch");
    expect(
      gitHubViewerPermissions({
        ...access,
        canWrite: true,
        didAuthor: true,
        canDeleteBranch: false,
      }).actions,
    ).not.toContain("delete-branch");
  }),
);

describe("gitHubViewerPermissions", () => {
  it("offers everything to a viewer who can write to the repository", () => {
    expect(
      gitHubViewerPermissions({
        canWrite: true,
        canDeleteBranch: true,
        canTriage: true,
        canUpdate: true,
        didAuthor: false,
        autoMergeAllowed: true,
      }),
    ).toEqual({
      actions: [
        "delete-branch",
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
      stackRebase: true,
      verdicts: ["comment", "approve", "request-changes"],
      requestReviewers: true,
      labels: true,
    });
  });

  it("leaves a passer-by on a repository they can only read nothing but the review", () => {
    expect(
      gitHubViewerPermissions({
        canWrite: false,
        canTriage: false,
        canUpdate: false,
        didAuthor: false,
        autoMergeAllowed: true,
      }),
    ).toEqual({
      actions: [],
      comment: true,
      resolve: false,
      verdicts: ["comment", "approve", "request-changes"],
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
      autoMergeAllowed: true,
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
        autoMergeAllowed: true,
      }),
    ).toEqual({
      actions: ["ready", "draft", "close", "reopen"],
      comment: true,
      resolve: true,
      verdicts: ["comment"],
      requestReviewers: false,
      labels: false,
    });
  });

  it.effect("uses the permissions carried by the core read without a second request", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const detail = yield* provider.getChangeRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      expect(detail.viewerPermissions).toEqual({
        maintainerEdits: false,
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
      for (const fingerprint of ["broad", "restricted", "broad"]) {
        const scoped = yield* provider
          .getChangeRequest({
            cwd: "/w",
            repository: "acme/web",
            host: "github.com",
            number: 7,
          })
          .pipe(
            Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
              host: "github.com",
              token: Redacted.make("credential"),
              credentialFingerprint: fingerprint,
            }),
          );
        expect(scoped.mergeCapabilities.squash).toBe(fingerprint !== "restricted");
      }
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
          revalidateChecks: (_input, read) => read,
          getPullRequestDetail: () =>
            Effect.succeed({
              ...coreFields,
              comparison: null,
              viewerAccess: { ...coreFields.viewerAccess, canWrite: false, canTriage: false },
              number: 7,
              title: "Pull request 7",
              url: "https://github.com/acme/web/pull/7",
              author: null,
              isCrossRepository: true,
              headRepositoryOwner: null,
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
            }).pipe(
              Effect.flatMap((detail) =>
                GitHubRequestPolicy.PinnedGitHubCredential.pipe(
                  Effect.map((credential) => ({
                    ...detail,
                    viewerAccess: {
                      ...detail.viewerAccess,
                      mergeCapabilities: {
                        ...detail.viewerAccess.mergeCapabilities,
                        squash: credential?.credentialFingerprint !== "restricted",
                      },
                    },
                  })),
                ),
              ),
            ),
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

      const readChecks = provider.getChangeRequestChecks;
      if (readChecks === undefined) return yield* Effect.die("checks read missing");
      expect(
        yield* readChecks({ cwd: "/w", repository: "acme/web", host: "github.com", number: 7 }),
      ).toEqual({ state: detail.state, checks: detail.checks });
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
        Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
          revalidateChecks: (_input, read) => read,
          getPullRequestDetail: () =>
            Effect.succeed({
              ...coreFields,
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
});

export const openDetail = {
  ...coreFields,
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
