import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import * as BitbucketApi from "../sourceControl/BitbucketApi.ts";
import * as BitbucketPullRequestApi from "./BitbucketPullRequestApi.ts";
import { decodePullRequestJson } from "./bitbucketPullRequestJson.ts";
import {
  bitbucketProviderFailure,
  bitbucketViewerPermissions,
  make,
} from "./BitbucketPullRequestProvider.ts";

const forkPullRequest = Result.getOrThrow(
  decodePullRequestJson(
    '{"id":7,"title":"PR","state":"MERGED","created_on":"2026-09-05T12:00:00Z","updated_on":"2026-09-05T12:00:00Z","source":{"branch":{"name":"feature"},"repository":{"full_name":"fork/web"}},"destination":{"branch":{"name":"main"}},"links":{"html":{"href":"https://bitbucket.org/acme/web/pull-requests/7"}}}',
  ),
);

it.effect.each([true, false, "failed", "source-read-failed"] as const)(
  "checks fork source access before authorization (%s)",
  (sourceAccess) =>
    Effect.gen(function* () {
      const failure = new BitbucketApi.BitbucketResponseError({
        operation: "request",
        status: 403,
        responseBodyLength: 0,
      });
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(BitbucketPullRequestApi.BitbucketPullRequestApi)({
            getPullRequest: () =>
              sourceAccess === "source-read-failed"
                ? Effect.fail(failure)
                : Effect.succeed(forkPullRequest),
            getRepositoryPermission: () => Effect.succeed(true),
            getSourceRepositoryPermission: (input) => {
              expect(input.repository).toBe("fork/web");
              return sourceAccess === "failed" || sourceAccess === "source-read-failed"
                ? Effect.fail(failure)
                : Effect.succeed(sourceAccess);
            },
          }),
        ),
      );
      const permissions = yield* provider.getViewerPermissions({
        cwd: "/w",
        host: "bitbucket.org",
        repository: "acme/web",
        number: 7,
      });
      expect(permissions.deleteSourceBranch).toBe(sourceAccess === true);
      expect(permissions.actions).toEqual(["merge", "close"]);
    }),
);

it.effect("reports a failed Bitbucket timeline read as incomplete activity", () =>
  Effect.gen(function* () {
    const failure = new BitbucketApi.BitbucketResponseError({
      operation: "request",
      status: 500,
      responseBodyLength: 0,
    });
    const comment = {
      id: "comment",
      kind: "issue-comment" as const,
      author: null,
      body: "Keep this",
      createdAt: forkPullRequest.createdAt,
      url: null,
      path: null,
      reviewState: null,
    };
    const thread = {
      id: "thread",
      path: "app.ts",
      line: 1,
      side: "right" as const,
      isResolved: false,
      isOutdated: false,
      comments: [comment],
    };
    const commit = {
      oid: "abc123",
      messageHeadline: "Keep this commit",
      committedDate: forkPullRequest.createdAt,
    };
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(BitbucketPullRequestApi.BitbucketPullRequestApi)({
          getPullRequest: () => Effect.succeed(forkPullRequest),
          listComments: () =>
            Effect.succeed({ comments: [comment], threads: [thread], truncated: false }),
          listCommits: () => Effect.succeed([commit]),
          listTimelineEvents: () => Effect.fail(failure),
        }),
      ),
    );
    const activity = yield* provider.getChangeRequestActivity({
      cwd: "/w",
      host: "bitbucket.org",
      repository: "acme/web",
      number: 7,
    });
    expect(activity.timelineTruncated).toBe(true);
    expect(activity.timelineEvents).toEqual([]);
    expect(activity.comments).toEqual([comment]);
    expect(activity.reviewThreads).toEqual([thread]);
    expect(activity.commits).toEqual([commit]);
  }),
);

describe("bitbucketProviderFailure", () => {
  it("treats only an HTTP 401 as unusable credentials", () => {
    const responseError = (status: number) =>
      new BitbucketApi.BitbucketResponseError({
        operation: "request",
        status,
        responseBodyLength: 0,
      });

    expect(bitbucketProviderFailure(responseError(401)).reason).toBe("unauthenticated");
    expect(bitbucketProviderFailure(responseError(403)).reason).toBe("failed");
  });
});

describe("bitbucketViewerPermissions", () => {
  it("offers both actions to credentials with write access", () => {
    expect(bitbucketViewerPermissions({ canWrite: true })).toEqual({
      deleteSourceBranch: false,
      actions: ["merge", "close"],
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve", "request-changes"],
      // Bitbucket says nothing about who may set a reviewer, and an unreported permission is
      // granted.
      requestReviewers: true,
    });
  });

  it("keeps merge from credentials that can only read the repository", () => {
    expect(bitbucketViewerPermissions({ canWrite: false })).toEqual({
      deleteSourceBranch: false,
      actions: ["close"],
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve", "request-changes"],
      requestReviewers: true,
    });
  });

  it("treats an author with read access as any other reader, which is all Bitbucket says", () => {
    // The repository permission is the whole of what Bitbucket reports per account; it says
    // nothing about who opened this pull request, and its author may decline it with read access
    // alone — so declining stays offered rather than being taken from them.
    expect(bitbucketViewerPermissions({ canWrite: false }).actions).toEqual(["close"]);
  });
});

it.effect("keeps historical verdict events while removing current review duplicates", () =>
  Effect.gen(function* () {
    const current = "2026-09-05T12:00:00.000Z";
    const older = "2026-09-04T12:00:00.000Z";
    const actor = (login: string) => ({ login, name: null, avatarUrl: null });
    const review = (login: string, reviewState: string) => ({
      id: login,
      kind: "review" as const,
      author: actor(login),
      body: "",
      createdAt: current,
      url: null,
      path: null,
      reviewState,
    });
    const event = (id: string, kind: string, login: string, createdAt: string) => ({
      id,
      kind,
      actor: actor(login),
      createdAt,
      url: null,
      body: kind,
    });
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(BitbucketPullRequestApi.BitbucketPullRequestApi)({
          getPullRequest: () =>
            Effect.succeed({
              number: 7,
              title: "Pull request 7",
              url: "https://bitbucket.org/acme/web/pull-requests/7",
              author: null,
              headBranch: "feature",
              headRepositoryNameWithOwner: null,
              baseBranch: "main",
              state: "open" as const,
              isDraft: false,
              mergeability: "unknown" as const,
              createdAt: older,
              updatedAt: current,
              body: "",
              reviewRequestLogins: [],
              reviewers: [],
              reviewerIds: [],
              reviews: [review("julius", "APPROVED"), review("theo", "CHANGES_REQUESTED")],
            }),
          listComments: () => Effect.succeed({ comments: [], threads: [], truncated: false }),
          listCommits: () => Effect.succeed([]),
          listTimelineEvents: () =>
            Effect.succeed([
              event("approved-current", "approved", "julius", current),
              event("approved-old", "approved", "julius", older),
              event("changes-current", "changes-requested", "theo", current),
              event("changes-old", "changes-requested", "theo", older),
            ]),
        }),
      ),
    );
    const activity = yield* provider.getChangeRequestActivity({
      cwd: "/w",
      repository: "acme/web",
      host: "bitbucket.org",
      number: 7,
    });
    expect(activity.timelineEvents?.map((entry) => entry.id)).toEqual([
      "approved-old",
      "changes-old",
    ]);
  }),
);

it.each([true, false, undefined])(
  "requires known source access for deletion (%s)",
  (sourceAccess) => {
    expect(
      bitbucketViewerPermissions({
        canWrite: true,
        ...(sourceAccess === undefined ? {} : { canWriteSource: sourceAccess }),
      }).deleteSourceBranch,
    ).toBe(sourceAccess === true);
  },
);
