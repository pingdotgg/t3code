import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ProviderInstanceId } from "@t3tools/contracts";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as AutoReviewJobStore from "./AutoReviewJobStore.ts";
import * as AutoReviewRunner from "./AutoReviewRunner.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};

const makeGithub = (overrides: Partial<GitHubCli.GitHubCli["Service"]> = {}) =>
  GitHubCli.GitHubCli.of({
    execute: () => Effect.die("unused"),
    listOpenPullRequests: () => Effect.succeed([]),
    listRepositoryOpenPullRequests: () => Effect.succeed([]),
    listPullRequestIssueComments: () => Effect.succeed([]),
    getPullRequestDiff: () => Effect.succeed("diff --git a/a.ts b/a.ts\n+const x = 1\n"),
    submitPullRequestReview: () =>
      Effect.succeed({
        reviewId: "r1",
        url: "https://github.com/o/r/pull/1#pullrequestreview-1",
      }),
    getPullRequest: () =>
      Effect.succeed({
        number: 1,
        title: "Test",
        url: "https://github.com/o/r/pull/1",
        baseRefName: "main",
        headRefName: "feat",
        headRefOid: "abc123",
        state: "open",
      }),
    getRepositoryCloneUrls: () => Effect.die("unused"),
    createRepository: () => Effect.die("unused"),
    createPullRequest: () => Effect.void,
    getDefaultBranch: () => Effect.succeed("main"),
    checkoutPullRequest: () => Effect.void,
    getPullRequestReviewStatus: () => Effect.die("unused"),
    getPullRequestReview: () => Effect.die("unused"),
    mergePullRequest: () => Effect.void,
    markPullRequestReady: () => Effect.void,
    ...overrides,
  });

const makeText = (overrides: Partial<TextGeneration.TextGeneration["Service"]> = {}) =>
  TextGeneration.TextGeneration.of({
    generateCommitMessage: () => Effect.die("unused"),
    generatePrContent: () => Effect.die("unused"),
    generateBranchName: () => Effect.die("unused"),
    generateThreadTitle: () => Effect.die("unused"),
    generateScenerySet: () => Effect.die("unused"),
    generateAutoReviewFindings: () =>
      Effect.succeed({
        summary: "Found issues",
        decision: "comment",
        comments: [
          {
            path: "a.ts",
            line: 2,
            side: "RIGHT",
            severity: "important",
            body: "bug",
          },
        ],
      }),
    ...overrides,
  });

describe("AutoReviewRunner", () => {
  it("posts a review and auto-fixes when an origin thread is linked", async () => {
    const submits: unknown[] = [];
    const fixes: Array<{ threadId: string; prompt: string }> = [];

    await Effect.gen(function* () {
      const store = yield* AutoReviewJobStore.AutoReviewJobStore;
      const runner = yield* AutoReviewRunner.AutoReviewRunner;
      const enqueued = yield* store.enqueue({
        projectId: "proj",
        prNumber: 1,
        headSha: "abc123def456",
        trigger: "open_or_push",
        modelSelection,
      });
      yield* store.update(enqueued.job.id, { status: "running" });

      yield* runner.runJob(enqueued.job.id, {
        cwd: "/repo",
        candidates: [
          {
            threadId: "thread-1",
            projectId: "proj",
            deletedAt: null,
            updatedAt: "2026-01-01T00:00:00.000Z",
            status: "idle",
            prNumber: 1,
            prState: "open",
            branch: "feat",
          },
        ],
        dispatchFixPrompt: (input) =>
          Effect.sync(() => {
            fixes.push(input);
          }),
      });

      const job = yield* store.get(enqueued.job.id);
      expect(job?.status).toBe("succeeded");
      expect(job?.autoFixEnqueued).toBe(true);
      expect(job?.originThreadId).toBe("thread-1");
      expect(submits.length).toBe(1);
      expect(fixes[0]?.threadId).toBe("thread-1");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          AutoReviewJobStore.layerInMemory,
          AutoReviewRunner.layer.pipe(
            Layer.provide(AutoReviewJobStore.layerInMemory),
            Layer.provide(
              Layer.succeed(
                GitHubCli.GitHubCli,
                makeGithub({
                  submitPullRequestReview: (input) =>
                    Effect.sync(() => {
                      submits.push(input);
                      return {
                        reviewId: "r1",
                        url: "https://example/review",
                      };
                    }),
                }),
              ),
            ),
            Layer.provide(Layer.succeed(TextGeneration.TextGeneration, makeText())),
          ),
        ),
      ),
      Effect.runPromise,
    );
  });

  it("fails without posting when the model fails", async () => {
    const submits: unknown[] = [];

    await Effect.gen(function* () {
      const store = yield* AutoReviewJobStore.AutoReviewJobStore;
      const runner = yield* AutoReviewRunner.AutoReviewRunner;
      const enqueued = yield* store.enqueue({
        projectId: "proj",
        prNumber: 1,
        headSha: "abc",
        trigger: "open_or_push",
        modelSelection,
      });
      yield* store.update(enqueued.job.id, { status: "running" });

      yield* runner.runJob(enqueued.job.id, {
        cwd: "/repo",
        candidates: [],
      });

      const job = yield* store.get(enqueued.job.id);
      expect(job?.status).toBe("failed");
      expect(submits).toHaveLength(0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          AutoReviewJobStore.layerInMemory,
          AutoReviewRunner.layer.pipe(
            Layer.provide(AutoReviewJobStore.layerInMemory),
            Layer.provide(
              Layer.succeed(
                GitHubCli.GitHubCli,
                makeGithub({
                  submitPullRequestReview: (input) =>
                    Effect.sync(() => {
                      submits.push(input);
                      return { reviewId: "r1", url: "u" };
                    }),
                }),
              ),
            ),
            Layer.provide(
              Layer.succeed(
                TextGeneration.TextGeneration,
                makeText({
                  generateAutoReviewFindings: () =>
                    Effect.fail(
                      new (class extends Error {
                        readonly _tag = "TextGenerationError";
                      })("model down") as never,
                    ),
                }),
              ),
            ),
          ),
        ),
      ),
      Effect.runPromise,
    );
  });

  it("skips empty diffs without posting", async () => {
    const submits: unknown[] = [];
    await Effect.gen(function* () {
      const store = yield* AutoReviewJobStore.AutoReviewJobStore;
      const runner = yield* AutoReviewRunner.AutoReviewRunner;
      const enqueued = yield* store.enqueue({
        projectId: "proj",
        prNumber: 1,
        headSha: "abc",
        trigger: "open_or_push",
        modelSelection,
      });
      yield* store.update(enqueued.job.id, { status: "running" });
      yield* runner.runJob(enqueued.job.id, { cwd: "/repo", candidates: [] });
      const job = yield* store.get(enqueued.job.id);
      expect(job?.status).toBe("skipped");
      expect(job?.skipReason).toBe("empty_diff");
      expect(submits).toHaveLength(0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          AutoReviewJobStore.layerInMemory,
          AutoReviewRunner.layer.pipe(
            Layer.provide(AutoReviewJobStore.layerInMemory),
            Layer.provide(
              Layer.succeed(
                GitHubCli.GitHubCli,
                makeGithub({
                  getPullRequestDiff: () => Effect.succeed("   "),
                  submitPullRequestReview: (input) =>
                    Effect.sync(() => {
                      submits.push(input);
                      return { reviewId: "r1", url: "u" };
                    }),
                }),
              ),
            ),
            Layer.provide(Layer.succeed(TextGeneration.TextGeneration, makeText())),
          ),
        ),
      ),
      Effect.runPromise,
    );
  });
});
