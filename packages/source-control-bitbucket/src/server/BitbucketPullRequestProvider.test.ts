import { SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

import * as BitbucketApi from "./BitbucketApi.ts";
import * as BitbucketPullRequestApi from "./BitbucketPullRequestApi.ts";
import { decodePullRequestJson } from "./bitbucketPullRequestJson.ts";
import {
  bitbucketProviderFailure,
  bitbucketViewerPermissions,
  make,
} from "./BitbucketPullRequestProvider.ts";

it.effect.each([
  { state: "MERGED", mergedAt: "2025-06-16T23:40:46.222Z", closedAt: null },
  { state: "DECLINED", mergedAt: null, closedAt: "2025-06-16T23:40:46.222Z" },
  { state: "OPEN", mergedAt: null, closedAt: null },
])("reads the $state time from closed_on", ({ state, mergedAt, closedAt }) =>
  Effect.gen(function* () {
    const pullRequest = Result.getOrThrow(
      decodePullRequestJson(
        JSON.stringify({
          id: 52,
          title: "Release",
          state,
          source: { branch: { name: "release" } },
          destination: { branch: { name: "master" } },
          created_on: "2025-06-16T06:20:58.415108+00:00",
          // Comments after merging move this timestamp.
          updated_on: "2025-06-20T10:00:00.000000+00:00",
          closed_on: state === "OPEN" ? null : "2025-06-16T23:40:46.222238+00:00",
          links: { html: { href: "https://bitbucket.org/acme/web/pull-requests/52" } },
        }),
      ),
    );
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(BitbucketPullRequestApi.BitbucketPullRequestApi)({
          getPullRequest: () => Effect.succeed(pullRequest),
          getDiffStat: () => Effect.succeed({ additions: 0, deletions: 0, changedFiles: 0 }),
          getMergeability: () => Effect.succeed("unknown"),
          listChecks: () => Effect.succeed([]),
          getRepositoryPermission: () => Effect.succeed(true),
        }),
      ),
    );
    const detail = yield* provider.getChangeRequest({
      cwd: "/repo",
      repository: "acme/web",
      host: "bitbucket.org",
      number: 52,
    });

    expect({ mergedAt: detail.mergedAt, closedAt: detail.closedAt }).toEqual({
      mergedAt,
      closedAt,
    });
  }),
);

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

it.effect("rereads only the pull request when sync reads an unchanged pull request again", () =>
  Effect.gen(function* () {
    const pullRequest = Result.getOrThrow(
      decodePullRequestJson(`{
      "id": 1, "title": "Sync", "state": "OPEN",
      "source": { "branch": { "name": "feature" }, "commit": { "hash": "abc123" } },
      "destination": { "branch": { "name": "main" }, "commit": { "hash": "def456" } },
      "created_on": "2026-09-16T00:00:00Z", "updated_on": "2026-09-16T00:00:00Z",
      "links": { "html": { "href": "https://bitbucket.org/acme/web/pull-requests/1" } }
    }`),
    );
    const calls: Array<string> = [];
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(BitbucketPullRequestApi.BitbucketPullRequestApi)({
          getPullRequest: () =>
            Effect.sync(() => calls.push("pullRequest")).pipe(Effect.as(pullRequest)),
          getDiffStat: () =>
            Effect.sync(() => calls.push("diffstat")).pipe(
              Effect.as({ additions: 12, deletions: 3, changedFiles: 2 }),
            ),
          getMergeability: () =>
            Effect.sync(() => calls.push("conflicts")).pipe(Effect.as("conflicting" as const)),
          listChecks: () => Effect.sync(() => calls.push("statuses")).pipe(Effect.as([])),
          getRepositoryPermission: () =>
            Effect.sync(() => calls.push("permission")).pipe(Effect.as(true)),
        }),
      ),
    );
    const readSummary = provider.getChangeRequestSummary ?? provider.getChangeRequest;
    const input = { cwd: "/repo", repository: "acme/web", host: "bitbucket.org", number: 1 };
    const expected = { additions: 12, deletions: 3, changedFiles: 2, mergeability: "conflicting" };

    expect(yield* readSummary(input)).toMatchObject(expected);
    const firstRead = calls.splice(0).toSorted();
    expect(yield* readSummary(input)).toMatchObject(expected);
    const secondRead = calls.splice(0).toSorted();

    expect({ firstRead, secondRead }).toEqual({
      firstRead: ["conflicts", "diffstat", "pullRequest"],
      secondRead: ["pullRequest"],
    });
  }),
);

it.effect(
  "rereads diffstat and conflicts when a commit moves, the reads expire or are forgotten, or conflicts failed",
  () =>
    Effect.gen(function* () {
      const pullRequestAt = (head: string, base: string) =>
        Result.getOrThrow(
          decodePullRequestJson(
            JSON.stringify({
              id: 1,
              title: "Sync",
              state: "OPEN",
              source: { branch: { name: "feature" }, commit: { hash: head } },
              destination: { branch: { name: "main" }, commit: { hash: base } },
              created_on: "2026-09-16T00:00:00Z",
              updated_on: "2026-09-16T00:00:00Z",
              links: { html: { href: "https://bitbucket.org/acme/web/pull-requests/1" } },
            }),
          ),
        );
      let pullRequest = pullRequestAt("abc123", "def456");
      let statReads = 0;
      let conflictsFail = false;
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(BitbucketPullRequestApi.BitbucketPullRequestApi)({
            getPullRequest: () => Effect.sync(() => pullRequest),
            getDiffStat: () =>
              Effect.sync(() => ++statReads).pipe(
                Effect.as({ additions: 1, deletions: 0, changedFiles: 1 }),
              ),
            getMergeability: () =>
              conflictsFail
                ? Effect.fail(
                    new BitbucketApi.BitbucketResponseError({
                      operation: "request",
                      status: 503,
                      responseBodyLength: 0,
                    }),
                  )
                : Effect.succeed("mergeable" as const),
          }),
        ),
      );
      const readSummary = provider.getChangeRequestSummary;
      const forget = provider.forgetChangeRequestReads;
      if (readSummary === undefined || forget === undefined) {
        return yield* Effect.die("summary reads missing");
      }
      const input = { cwd: "/repo", repository: "acme/web", host: "bitbucket.org", number: 1 };

      yield* readSummary(input);
      pullRequest = pullRequestAt("abc123", "fed789");
      yield* readSummary(input);
      pullRequest = pullRequestAt("cba321", "fed789");
      yield* readSummary(input);
      yield* readSummary(input);
      yield* forget({ repository: "Acme/Web", number: 1 });
      yield* readSummary(input);
      yield* TestClock.adjust(Duration.minutes(15));
      yield* readSummary(input);
      pullRequest = pullRequestAt("cba321", "0a0b0c");
      conflictsFail = true;
      expect((yield* readSummary(input)).mergeability).toBe("unknown");
      conflictsFail = false;
      expect((yield* readSummary(input)).mergeability).toBe("mergeable");

      expect(statReads).toBe(7);
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

  it("reports a request held back by the host-wide pause as rate limited until it ends", () => {
    const paused = new SourceControlRateLimit.SourceControlRateLimitPausedError({
      provider: SourceControlProviderKind.make("bitbucket"),
      host: "bitbucket.org",
      retryAt: 120_000,
    });

    expect(bitbucketProviderFailure(paused)).toEqual({ reason: "rate-limited", retryAt: 120_000 });
  });
});

describe("bitbucketViewerPermissions", () => {
  it("offers both actions to credentials with write access", () => {
    expect(bitbucketViewerPermissions({ canWrite: true })).toEqual({
      actions: ["merge", "close"],
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve", "request-changes"],
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
});
