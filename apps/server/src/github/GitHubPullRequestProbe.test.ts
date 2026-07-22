import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { GitHubCli } from "../sourceControl/GitHubCli.ts";
import {
  GitHubPullRequestProbe,
  evaluateGitHubWaitpoint,
  layer,
} from "./GitHubPullRequestProbe.ts";

const rawSnapshot = JSON.stringify({
  comments: [{ id: "comment-1", createdAt: "2026-07-22T11:08:34Z" }],
  headRefOid: "abc123",
  mergedAt: null,
  reviews: [{ id: "review-1", submittedAt: "2026-07-22T11:10:03Z", state: "COMMENTED" }],
  state: "OPEN",
  statusCheckRollup: [
    { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "StatusContext", context: "preview", state: "PENDING" },
  ],
  updatedAt: "2026-07-22T11:16:04Z",
  url: "https://github.com/pingdotgg/t3code/pull/4262",
});

it.effect("reads and normalizes the narrow GitHub pull-request watch snapshot", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const gitHubCli = GitHubCli.of({
      execute: (input: Parameters<GitHubCli["Service"]["execute"]>[0]) =>
        Ref.update(calls, (current) => [...current, ...input.args]).pipe(
          Effect.as({ stdout: rawSnapshot, stderr: "", exitCode: 0 }),
        ),
    } as unknown as GitHubCli["Service"]);

    const snapshot = yield* Effect.gen(function* () {
      const probe = yield* GitHubPullRequestProbe;
      return yield* probe.get({
        cwd: "/tmp/project",
        repository: "pingdotgg/t3code",
        pullRequestNumber: 4262,
      });
    }).pipe(Effect.provide(layer.pipe(Layer.provide(Layer.succeed(GitHubCli, gitHubCli)))));

    assert.deepStrictEqual(snapshot, {
      url: "https://github.com/pingdotgg/t3code/pull/4262",
      state: "open",
      headSha: "abc123",
      mergedAt: null,
      updatedAt: "2026-07-22T11:16:04.000Z",
      checks: [
        { name: "test", status: "completed", conclusion: "success" },
        { name: "preview", status: "pending", conclusion: null },
      ],
      reviewActivity: [
        { id: "comment-1", occurredAt: "2026-07-22T11:08:34.000Z" },
        { id: "review-1", occurredAt: "2026-07-22T11:10:03.000Z" },
      ],
    });
    assert.deepStrictEqual(yield* Ref.get(calls), [
      "pr",
      "view",
      "4262",
      "--repo",
      "pingdotgg/t3code",
      "--json",
      "headRefOid,state,mergedAt,updatedAt,statusCheckRollup,comments,reviews,url",
    ]);
  }),
);

it("wakes only when the selected GitHub condition changes", () => {
  const baseline: import("./GitHubPullRequestProbe.ts").GitHubPullRequestSnapshot = {
    url: "https://github.com/pingdotgg/t3code/pull/4262",
    state: "open" as const,
    headSha: "abc123",
    mergedAt: null,
    updatedAt: "2026-07-22T11:16:04.000Z",
    checks: [{ name: "test", status: "pending", conclusion: null }],
    reviewActivity: [{ id: "review-1", occurredAt: "2026-07-22T11:10:03.000Z" }],
  };

  assert.isFalse(evaluateGitHubWaitpoint("checks_settled", baseline, baseline).satisfied);
  assert.isTrue(
    evaluateGitHubWaitpoint("checks_settled", baseline, {
      ...baseline,
      checks: [{ name: "test", status: "completed", conclusion: "failure" }],
    }).satisfied,
  );
  assert.isTrue(
    evaluateGitHubWaitpoint("new_review_activity", baseline, {
      ...baseline,
      reviewActivity: [
        ...baseline.reviewActivity,
        { id: "comment-2", occurredAt: "2026-07-22T12:00:00.000Z" },
      ],
    }).satisfied,
  );
  assert.isTrue(
    evaluateGitHubWaitpoint("pull_request_closed", baseline, {
      ...baseline,
      state: "merged",
      mergedAt: "2026-07-22T12:00:00.000Z",
    }).satisfied,
  );
});
