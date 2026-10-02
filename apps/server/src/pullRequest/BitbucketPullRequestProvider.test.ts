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

for (const operation of [
  "getMergeability",
  "listChecks",
  "getRepositoryPermission",
  "listComments",
  "listCommits",
] as const) {
  it.effect.each(["response", "body read"])(
    `preserves rate limits from ${operation} on %s errors while recovering other optional-read failures`,
    (variant) =>
      Effect.gen(function* () {
        const pullRequest = Result.getOrThrow(
          decodePullRequestJson(`{
            "id": 1, "title": "Check polling", "state": "OPEN",
            "source": { "branch": { "name": "feature" } },
            "destination": { "branch": { "name": "main" } },
            "created_on": "2026-09-16T00:00:00Z",
            "updated_on": "2026-09-16T00:00:00Z",
            "links": { "html": { "href": "https://bitbucket.org/acme/web/pull-requests/1" } }
          }`),
        );
        for (const status of [429, 403]) {
          const provider = yield* make.pipe(
            Effect.provide(
              Layer.mock(BitbucketPullRequestApi.BitbucketPullRequestApi)({
                getPullRequest: () => Effect.succeed(pullRequest),
                getDiffStat: () => Effect.succeed({ additions: 0, deletions: 0, changedFiles: 0 }),
                getMergeability: () => Effect.succeed("unknown" as const),
                listChecks: () => Effect.succeed([]),
                getRepositoryPermission: () => Effect.succeed(true),
                listComments: () => Effect.succeed({ comments: [], threads: [], truncated: false }),
                listCommits: () => Effect.succeed([]),
                [operation]: () =>
                  Effect.fail(
                    variant === "response"
                      ? new BitbucketApi.BitbucketResponseError({
                          operation: "request",
                          status,
                          responseBodyLength: 0,
                          retryAt: 120_000,
                        })
                      : new BitbucketApi.BitbucketResponseBodyReadError({
                          operation: "request",
                          status,
                          cause: new Error("response stream failed"),
                          retryAt: 120_000,
                        }),
                  ),
              }),
            ),
          );
          const reference = {
            cwd: "/repo",
            repository: "acme/web",
            number: 1,
            host: "bitbucket.org",
          };
          const result = yield* operation === "listComments" || operation === "listCommits"
            ? Effect.result(provider.getChangeRequestActivity(reference))
            : Effect.result(provider.getChangeRequest(reference));
          if (status === 429) {
            expect(result).toMatchObject({
              _tag: "Failure",
              failure: { reason: "rate-limited", retryAt: 120_000 },
            });
          } else {
            expect(result._tag).toBe("Success");
          }
        }
      }),
  );
}

it.effect("reads checks and PR state without diff, mergeability, or permission requests", () =>
  Effect.gen(function* () {
    const pullRequest = Result.getOrThrow(
      decodePullRequestJson(`{
      "id": 1, "title": "Checks", "state": "OPEN",
      "source": { "branch": { "name": "feature" } },
      "destination": { "branch": { "name": "main" } },
      "created_on": "2026-09-16T00:00:00Z", "updated_on": "2026-09-16T00:00:00Z",
      "links": { "html": { "href": "https://bitbucket.org/acme/web/pull-requests/1" } }
    }`),
    );
    let limited = false;
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(BitbucketPullRequestApi.BitbucketPullRequestApi)({
          getPullRequest: () => Effect.succeed(pullRequest),
          listChecks: () =>
            limited
              ? Effect.fail(
                  new BitbucketApi.BitbucketResponseError({
                    operation: "request",
                    status: 429,
                    responseBodyLength: 0,
                    retryAt: 120_000,
                  }),
                )
              : Effect.succeed([
                  { name: "build", status: "failure" as const, description: null, url: null },
                ]),
        }),
      ),
    );
    const read = provider.getChangeRequestChecks;
    if (read === undefined) return yield* Effect.die("checks read missing");
    const input = { cwd: "/repo", repository: "acme/web", host: "bitbucket.org", number: 1 };
    expect((yield* read(input)).checks[0]?.status).toBe("failure");
    limited = true;
    expect(yield* Effect.flip(read(input))).toMatchObject({
      reason: "rate-limited",
      retryAt: 120_000,
    });
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
