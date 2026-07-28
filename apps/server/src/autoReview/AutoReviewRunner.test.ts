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

const DIFF = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,1 +1,2 @@",
  " const y = 0",
  "+const x = 1",
  "",
].join("\n");

const makeGithub = (overrides: Partial<GitHubCli.GitHubCli["Service"]> = {}) =>
  GitHubCli.GitHubCli.of({
    execute: () => Effect.die("unused"),
    listOpenPullRequests: () => Effect.succeed([]),
    listRepositoryOpenPullRequests: () => Effect.succeed([]),
    listPullRequestIssueComments: () => Effect.succeed([]),
    getPullRequestDiff: () => Effect.succeed(DIFF),
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
    getViewerLogin: () => Effect.succeed("octocat"),
    checkoutPullRequest: () => Effect.void,
    getPullRequestReviewStatus: () => Effect.die("unused"),
    getPullRequestMergeState: () => Effect.die("unused"),
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
  it("tracks a dedicated fixer separately from the linked origin thread", async () => {
    const submits: unknown[] = [];
    const fixes: Array<{ jobId: string; threadId: string; prompt: string }> = [];

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
        queueOrDispatchFix: (input) =>
          Effect.sync(() => {
            fixes.push(input);
            return { outcome: "dispatched" as const, threadId: "fixer-1" };
          }),
      });

      const job = yield* store.get(enqueued.job.id);
      expect(job?.status).toBe("succeeded");
      expect(job?.autoFixEnqueued).toBe(true);
      expect(job?.actionableFindings).toBe(true);
      expect(job?.decision).toBe("comment");
      expect(job?.originThreadId).toBe("thread-1");
      expect(job?.fixThreadId).toBe("fixer-1");
      expect(submits.length).toBe(1);
      expect(fixes[0]?.threadId).toBe("thread-1");
      expect(fixes[0]?.jobId).toBe(enqueued.job.id);
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

  it("does not mark autoFixEnqueued when the fix was queued for a busy thread", async () => {
    const fixes: Array<{ jobId: string; threadId: string; prompt: string }> = [];

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
            status: "running",
            prNumber: 1,
            prState: "open",
            branch: "feat",
          },
        ],
        queueOrDispatchFix: (input) =>
          Effect.sync(() => {
            fixes.push(input);
            return { outcome: "queued" as const, threadId: input.threadId };
          }),
      });

      const job = yield* store.get(enqueued.job.id);
      expect(job?.status).toBe("succeeded");
      expect(job?.autoFixEnqueued).toBe(false);
      expect(job?.actionableFindings).toBe(true);
      expect(job?.decision).toBe("comment");
      expect(fixes[0]?.threadId).toBe("thread-1");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          AutoReviewJobStore.layerInMemory,
          AutoReviewRunner.layer.pipe(
            Layer.provide(AutoReviewJobStore.layerInMemory),
            Layer.provide(Layer.succeed(GitHubCli.GitHubCli, makeGithub())),
            Layer.provide(Layer.succeed(TextGeneration.TextGeneration, makeText())),
          ),
        ),
      ),
      Effect.runPromise,
    );
  });

  it("does not queue a fix when findings have no blocking or important comments", async () => {
    const fixes: Array<{ jobId: string; threadId: string; prompt: string }> = [];
    const settled: Array<{ projectId: string; prNumber: number }> = [];

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
        queueOrDispatchFix: (input) =>
          Effect.sync(() => {
            fixes.push(input);
            return { outcome: "dispatched" as const, threadId: input.threadId };
          }),
        settleFixThread: (input) =>
          Effect.sync(() => {
            settled.push(input);
          }),
      });

      const job = yield* store.get(enqueued.job.id);
      expect(job?.status).toBe("succeeded");
      expect(job?.autoFixEnqueued).toBe(false);
      expect(job?.actionableFindings).toBe(false);
      expect(fixes).toHaveLength(0);
      expect(settled).toEqual([{ projectId: "proj", prNumber: 1 }]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          AutoReviewJobStore.layerInMemory,
          AutoReviewRunner.layer.pipe(
            Layer.provide(AutoReviewJobStore.layerInMemory),
            Layer.provide(Layer.succeed(GitHubCli.GitHubCli, makeGithub())),
            Layer.provide(
              Layer.succeed(
                TextGeneration.TextGeneration,
                makeText({
                  generateAutoReviewFindings: () =>
                    Effect.succeed({
                      summary: "Clean",
                      decision: "comment",
                      comments: [
                        {
                          path: "a.ts",
                          line: 2,
                          side: "RIGHT",
                          severity: "nit",
                          body: "style",
                        },
                      ],
                    }),
                }),
              ),
            ),
          ),
        ),
      ),
      Effect.runPromise,
    );
  });

  it("downgrades request_changes to comment when reviewing your own PR", async () => {
    const events: string[] = [];

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

      yield* runner.runJob(enqueued.job.id, { cwd: "/repo", candidates: [] });

      const job = yield* store.get(enqueued.job.id);
      expect(job?.status).toBe("succeeded");
      expect(events).toEqual(["COMMENT"]);
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
                  getViewerLogin: () => Effect.succeed("OctoCat"),
                  getPullRequest: () =>
                    Effect.succeed({
                      number: 1,
                      title: "Test",
                      url: "https://github.com/o/r/pull/1",
                      baseRefName: "main",
                      headRefName: "feat",
                      headRefOid: "abc123",
                      state: "open",
                      authorLogin: "octocat",
                    }),
                  submitPullRequestReview: (input) =>
                    Effect.sync(() => {
                      events.push(input.event);
                      return { reviewId: "r1", url: "https://example/review" };
                    }),
                }),
              ),
            ),
            Layer.provide(
              Layer.succeed(
                TextGeneration.TextGeneration,
                makeText({
                  generateAutoReviewFindings: () =>
                    Effect.succeed({
                      summary: "Blocking issue found",
                      decision: "request_changes",
                      comments: [
                        {
                          path: "a.ts",
                          line: 2,
                          side: "RIGHT",
                          severity: "blocking",
                          body: "breaks correctness",
                        },
                      ],
                    }),
                }),
              ),
            ),
          ),
        ),
      ),
      Effect.runPromise,
    );
  });

  it("keeps request_changes when the PR author is someone else", async () => {
    const events: string[] = [];

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

      yield* runner.runJob(enqueued.job.id, { cwd: "/repo", candidates: [] });

      const job = yield* store.get(enqueued.job.id);
      expect(job?.status).toBe("succeeded");
      expect(events).toEqual(["REQUEST_CHANGES"]);
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
                  getViewerLogin: () => Effect.succeed("octocat"),
                  getPullRequest: () =>
                    Effect.succeed({
                      number: 1,
                      title: "Test",
                      url: "https://github.com/o/r/pull/1",
                      baseRefName: "main",
                      headRefName: "feat",
                      headRefOid: "abc123",
                      state: "open",
                      authorLogin: "someone-else",
                    }),
                  submitPullRequestReview: (input) =>
                    Effect.sync(() => {
                      events.push(input.event);
                      return { reviewId: "r1", url: "https://example/review" };
                    }),
                }),
              ),
            ),
            Layer.provide(
              Layer.succeed(
                TextGeneration.TextGeneration,
                makeText({
                  generateAutoReviewFindings: () =>
                    Effect.succeed({
                      summary: "Blocking issue found",
                      decision: "request_changes",
                      comments: [
                        {
                          path: "a.ts",
                          line: 2,
                          side: "RIGHT",
                          severity: "blocking",
                          body: "breaks correctness",
                        },
                      ],
                    }),
                }),
              ),
            ),
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

  it("moves findings that are not on the diff into the review body", async () => {
    const submits: Array<{
      body: string;
      comments?: ReadonlyArray<GitHubCli.GitHubPullRequestReviewCommentInput>;
    }> = [];
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
      yield* runner.runJob(enqueued.job.id, { cwd: "/repo", candidates: [] });

      const job = yield* store.get(enqueued.job.id);
      expect(job?.status).toBe("succeeded");
      expect(submits).toHaveLength(1);
      // Line 2 is in the diff, line 900 is not.
      expect(submits[0]?.comments?.map((comment) => comment.line)).toEqual([2]);
      expect(submits[0]?.body).toContain("Could not anchor");
      expect(submits[0]?.body).toContain("off diff");
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
                    Effect.succeed({
                      summary: "Found issues",
                      decision: "comment",
                      comments: [
                        {
                          path: "a.ts",
                          line: 2,
                          side: "RIGHT",
                          severity: "important",
                          body: "on diff",
                        },
                        {
                          path: "a.ts",
                          line: 900,
                          side: "RIGHT",
                          severity: "important",
                          body: "off diff",
                        },
                      ],
                    }),
                }),
              ),
            ),
          ),
        ),
      ),
      Effect.runPromise,
    );
  });

  it("retries body-only when GitHub rejects the inline comments", async () => {
    const submits: Array<{
      body: string;
      comments?: ReadonlyArray<GitHubCli.GitHubPullRequestReviewCommentInput>;
    }> = [];
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
      yield* runner.runJob(enqueued.job.id, { cwd: "/repo", candidates: [] });

      const job = yield* store.get(enqueued.job.id);
      expect(job?.status).toBe("succeeded");
      expect(submits).toHaveLength(2);
      expect(submits[1]?.comments ?? []).toHaveLength(0);
      expect(submits[1]?.body).toContain("bug");
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
                    Effect.suspend(() => {
                      submits.push(input);
                      if ((input.comments ?? []).length > 0) {
                        return Effect.fail(
                          new GitHubCli.GitHubPullRequestReviewRejectedError({
                            command: "gh",
                            cwd: "/repo",
                            exitCode: 1,
                            apiMessage: "line must be part of the diff",
                            inlineCommentRejected: true,
                            cause: new Error("422"),
                          }),
                        );
                      }
                      return Effect.succeed({ reviewId: "r1", url: "u" });
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

  it("records a readable failure message instead of a cause dump", async () => {
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
      yield* runner.runJob(enqueued.job.id, { cwd: "/repo", candidates: [] });

      const job = yield* store.get(enqueued.job.id);
      expect(job?.status).toBe("failed");
      expect(job?.error).toContain("gh auth login");
      expect(job?.error).not.toContain("\n");
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
                  getPullRequestDiff: () =>
                    Effect.fail(
                      new GitHubCli.GitHubCliAuthenticationError({
                        command: "gh",
                        cwd: "/repo",
                        cause: new Error("exit 1"),
                      }),
                    ),
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
