import { describe, expect, it } from "vite-plus/test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DEFAULT_AUTO_REVIEW_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as AutoReviewJobStore from "./AutoReviewJobStore.ts";
import * as AutoReviewRunner from "./AutoReviewRunner.ts";
import * as AutoReviewPoller from "./AutoReviewPoller.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};

function makeGithub(listCount: { value: number }) {
  return GitHubCli.GitHubCli.of({
    execute: () => Effect.die("unused"),
    listOpenPullRequests: () => Effect.succeed([]),
    listRepositoryOpenPullRequests: () =>
      Effect.sync(() => {
        listCount.value += 1;
        return [
          {
            number: 9,
            title: "PR",
            url: "https://example/pr/9",
            baseRefName: "main",
            headRefName: "feat",
            headRefOid: "deadbeef01",
            state: "open" as const,
          },
        ];
      }),
    listPullRequestIssueComments: () => Effect.succeed([]),
    getPullRequestDiff: () => Effect.succeed(""),
    submitPullRequestReview: () => Effect.succeed({ reviewId: "1", url: "u" }),
    getPullRequest: () =>
      Effect.succeed({
        number: 9,
        title: "PR",
        url: "https://example/pr/9",
        baseRefName: "main",
        headRefName: "feat",
        headRefOid: "deadbeef01",
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
  });
}

function makeText() {
  return TextGeneration.TextGeneration.of({
    generateCommitMessage: () => Effect.die("unused"),
    generatePrContent: () => Effect.die("unused"),
    generateBranchName: () => Effect.die("unused"),
    generateThreadTitle: () => Effect.die("unused"),
    generateScenerySet: () => Effect.die("unused"),
    generateAutoReviewFindings: () =>
      Effect.succeed({
        summary: "ok",
        decision: "comment",
        comments: [],
      }),
  });
}

function makeLayer(input: {
  enabled: boolean;
  listCount: { value: number };
}) {
  return Layer.mergeAll(
    AutoReviewJobStore.layerInMemory,
    AutoReviewPoller.layer({
      getSettings: Effect.succeed({
        autoReview: {
          ...DEFAULT_AUTO_REVIEW_SETTINGS,
          enabled: input.enabled,
          mode: "auto",
          modelSelection,
          pollInterval: Duration.seconds(60),
        },
      }),
      listProjects: Effect.succeed([{ id: "proj", workspaceRoot: "/repo", deletedAt: null }]),
      isGitHubProject: () => Effect.succeed(true),
      contextForJob: () => Effect.succeed({ cwd: "/repo", candidates: [] }),
    }).pipe(
      Layer.provide(
        AutoReviewRunner.layer.pipe(
          Layer.provide(AutoReviewJobStore.layerInMemory),
          Layer.provide(Layer.succeed(GitHubCli.GitHubCli, makeGithub(input.listCount))),
          Layer.provide(Layer.succeed(TextGeneration.TextGeneration, makeText())),
        ),
      ),
      Layer.provide(AutoReviewJobStore.layerInMemory),
      Layer.provide(Layer.succeed(GitHubCli.GitHubCli, makeGithub(input.listCount))),
      Layer.provide(Layer.succeed(TextGeneration.TextGeneration, makeText())),
    ),
  );
}

describe("AutoReviewPoller", () => {
  it("enqueues a job for a new open PR head sha in auto mode", async () => {
    const listCount = { value: 0 };
    await Effect.gen(function* () {
      const store = yield* AutoReviewJobStore.AutoReviewJobStore;
      const poller = yield* AutoReviewPoller.AutoReviewPoller;

      yield* poller.tick;
      const jobs = yield* store.list({ projectId: "proj" });
      expect(jobs.length).toBeGreaterThanOrEqual(1);
      expect(jobs[0]?.headSha).toBe("deadbeef01");
      expect(jobs[0]?.trigger).toBe("open_or_push");

      yield* poller.tick;
      const again = yield* store.list({ projectId: "proj" });
      expect(again.filter((j) => j.headSha === "deadbeef01")).toHaveLength(1);
    }).pipe(Effect.provide(makeLayer({ enabled: true, listCount })), Effect.runPromise);
  });

  it("does nothing when disabled", async () => {
    const listCount = { value: 0 };
    await Effect.gen(function* () {
      const store = yield* AutoReviewJobStore.AutoReviewJobStore;
      const poller = yield* AutoReviewPoller.AutoReviewPoller;
      yield* poller.tick;
      const jobs = yield* store.list();
      expect(jobs).toHaveLength(0);
      expect(listCount.value).toBe(0);
    }).pipe(Effect.provide(makeLayer({ enabled: false, listCount })), Effect.runPromise);
  });
});
