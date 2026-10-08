import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BitbucketApi from "../sourceControl/BitbucketApi.ts";
import * as BitbucketIssueApi from "./BitbucketIssueApi.ts";
import * as BitbucketIssueProvider from "./BitbucketIssueProvider.ts";
import type { BitbucketIssueDetail } from "./bitbucketIssueJson.ts";

it.effect.each([
  [false, undefined],
  [false, 120_000],
  [true, undefined],
  [true, 120_000],
] as const)(
  "preserves HTTP 429 retry time with unreadable body=%s, retryAt=%s",
  ([unreadable, retryAt]) =>
    Effect.gen(function* () {
      const fields = {
        operation: "request",
        status: 429,
        ...(retryAt === undefined ? {} : { retryAt }),
      } as const;
      const source = unreadable
        ? new BitbucketApi.BitbucketResponseBodyReadError({ ...fields, cause: new Error("body") })
        : new BitbucketApi.BitbucketResponseError({ ...fields, responseBodyLength: 0 });
      const provider = yield* BitbucketIssueProvider.make.pipe(
        Effect.provide(
          Layer.mock(BitbucketIssueApi.BitbucketIssueApi)({
            listIssues: () => Effect.fail(source),
            runAction: () => Effect.fail(source),
          }),
        ),
      );
      const reference = { cwd: "/repo", repository: "acme/web", host: "bitbucket.org" };
      for (const request of [
        provider.listIssues({
          ...reference,
          state: "open",
          involvement: "all",
          viewer: "ada",
          limit: 20,
        }),
        provider.runAction({ ...reference, number: 7, action: "close" }),
      ]) {
        const error = yield* Effect.flip(request);
        assert.strictEqual(error._tag, "IssueProviderError");
        assert.strictEqual(error.provider, "bitbucket");
        assert.strictEqual(error.reason, "rate-limited");
        assert.strictEqual(error.retryAt, retryAt);
        assert.strictEqual(error.detail, source.detail);
        assert.strictEqual(error.cause, source);
      }
    }),
);

it.effect.each([
  [401, "unauthenticated", "unauthenticated"],
  [403, "failed", "failed"],
  [404, "tracker-disabled", "failed"],
  [500, "failed", "failed"],
] as const)(
  "keeps authentication and tracker error mapping for HTTP %s",
  ([status, collectionReason, itemReason]) =>
    Effect.gen(function* () {
      const source = new BitbucketApi.BitbucketResponseError({
        operation: "request",
        status,
        responseBodyLength: 0,
      });
      const provider = yield* BitbucketIssueProvider.make.pipe(
        Effect.provide(
          Layer.mock(BitbucketIssueApi.BitbucketIssueApi)({
            listIssues: () => Effect.fail(source),
            createIssue: () => Effect.fail(source),
            getIssue: () => Effect.fail(source),
            getRepositoryPermission: () => Effect.succeed(false),
          }),
        ),
      );
      const reference = { cwd: "/repo", repository: "acme/web", host: "bitbucket.org" };
      const listError = yield* Effect.flip(
        provider.listIssues({
          ...reference,
          state: "open",
          involvement: "all",
          viewer: "ada",
          limit: 20,
        }),
      );
      const createError = yield* Effect.flip(
        provider.create({ ...reference, title: "Issue", body: "", labels: [], assignees: [] }),
      );
      const detailError = yield* Effect.flip(provider.getIssue({ ...reference, number: 7 }));
      assert.strictEqual(listError.reason, collectionReason);
      assert.strictEqual(createError.reason, collectionReason);
      assert.strictEqual(detailError.reason, itemReason);
    }),
);

it.effect.each(["failed", "limited", "unreadable"] as const)(
  "keeps permission failures safe for %s",
  (failure) =>
    Effect.gen(function* () {
      const provider = yield* BitbucketIssueProvider.make.pipe(
        Effect.provide(
          Layer.mock(BitbucketIssueApi.BitbucketIssueApi)({
            getIssue: () =>
              Effect.succeed({
                number: 7,
                title: "Readable issue",
                url: "https://bitbucket.org/acme/web/issues/7",
                body: "Issue body",
                author: null,
                assignee: null,
                state: "open",
                stateReason: null,
                createdAt: "2026-07-01T00:00:00Z",
                updatedAt: "2026-07-01T00:00:00Z",
                closedAt: null,
                milestone: null,
                commentCount: 0,
              } satisfies BitbucketIssueDetail),
            getRepositoryPermission: () =>
              Effect.fail(
                failure === "limited"
                  ? new BitbucketApi.BitbucketResponseError({
                      operation: "request",
                      status: 429,
                      responseBodyLength: 0,
                      retryAt: 120_000,
                    })
                  : failure === "unreadable"
                    ? new BitbucketApi.BitbucketResponseBodyReadError({
                        operation: "request",
                        status: 429,
                        retryAt: 120_000,
                        cause: new Error("body"),
                      })
                    : new BitbucketIssueApi.BitbucketIssueReadError({
                        operation: "getRepositoryPermission",
                        cause: new Error("unavailable"),
                      }),
              ),
          }),
        ),
      );
      const reference = { cwd: "/w", repository: "acme/web", number: 7, host: "bitbucket.org" };
      if (failure !== "failed") {
        const error = yield* Effect.flip(provider.getIssue(reference));
        assert.strictEqual(error.reason, "rate-limited");
        assert.strictEqual(error.retryAt, 120_000);
        return;
      }
      const issue = yield* provider.getIssue(reference);
      assert.strictEqual(issue.body, "Issue body");
      assert.isFalse(issue.viewerPermissions!.edit);
      const error = yield* Effect.flip(provider.getViewerPermissions(reference));
      assert.strictEqual(error.operation, "getViewerPermissions");
    }),
);
