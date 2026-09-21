import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BitbucketIssueApi from "./BitbucketIssueApi.ts";
import * as BitbucketIssueProvider from "./BitbucketIssueProvider.ts";
import type { BitbucketIssueDetail } from "./bitbucketIssueJson.ts";

it.effect("shows readable issues when permissions fail while refusing writes", () =>
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
              new BitbucketIssueApi.BitbucketIssueReadError({
                operation: "getRepositoryPermission",
                cause: new Error("unavailable"),
              }),
            ),
        }),
      ),
    );
    const reference = { cwd: "/w", repository: "acme/web", number: 7, host: "bitbucket.org" };
    const issue = yield* provider.getIssue(reference);
    assert.strictEqual(issue.body, "Issue body");
    assert.isFalse(issue.viewerPermissions!.edit);
    const error = yield* Effect.flip(provider.getViewerPermissions(reference));
    assert.strictEqual(error.operation, "getViewerPermissions");
  }),
);
