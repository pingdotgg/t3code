import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitHubPullRequestCli from "./GitHubPullRequestCli.ts";
import * as GitHubPullRequestProvider from "./GitHubPullRequestProvider.ts";
import type { GitHubPullRequestActivity } from "./gitHubPullRequestJson.ts";

const pullRequestActivity: GitHubPullRequestActivity = {
  author: null,
  comments: [
    {
      id: "issue-comment-1",
      kind: "issue-comment",
      author: null,
      body: "Please take another look.",
      createdAt: "2026-08-10T00:00:00Z",
      url: null,
      path: null,
      reviewState: null,
    },
  ],
  commits: [],
};

it.effect("reports a strict comment-count lower bound when review-thread loading fails", () =>
  Effect.gen(function* () {
    const provider = yield* GitHubPullRequestProvider.make.pipe(
      Effect.provide(
        Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
          getPullRequestActivity: () => Effect.succeed(pullRequestActivity),
          listReviewThreadComments: () =>
            Effect.fail(
              new GitHubPullRequestCli.GitHubPullRequestReadError({
                command: "gh",
                cwd: "/workspace/web",
                operation: "listReviewThreadComments",
                cause: new Error("GitHub GraphQL unavailable"),
              }),
            ),
        }),
      ),
    );

    const activity = yield* provider.getChangeRequestActivity({
      cwd: "/workspace/web",
      repository: "acme/web",
      host: "github.com",
      number: 42,
    });

    assert.strictEqual(activity.comments.length, 1);
    assert.strictEqual(activity.commentsTruncated, true);
    assert.strictEqual(activity.commentCount, 2);
  }),
);

it.effect("reports a strict comment-count lower bound when review-thread loading is capped", () =>
  Effect.gen(function* () {
    const provider = yield* GitHubPullRequestProvider.make.pipe(
      Effect.provide(
        Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
          getPullRequestActivity: () => Effect.succeed(pullRequestActivity),
          listReviewThreadComments: () =>
            Effect.succeed({
              comments: [],
              reviewThreads: [],
              commentCount: 0,
              truncated: true,
              reviewers: [],
              avatarsByLogin: new Map<string, string>(),
              commitStats: new Map<
                string,
                { readonly additions: number; readonly deletions: number }
              >(),
              commits: [],
              viewer: { canUpdate: true, didAuthor: false },
            }),
        }),
      ),
    );

    const activity = yield* provider.getChangeRequestActivity({
      cwd: "/workspace/web",
      repository: "acme/web",
      host: "github.com",
      number: 42,
    });

    assert.strictEqual(activity.comments.length, 1);
    assert.strictEqual(activity.commentsTruncated, true);
    assert.strictEqual(activity.commentCount, 2);
  }),
);
