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

type IssueComment = GitHubCli.GitHubPullRequestIssueComment;

function makeGithub(listCount: { value: number }, comments: ReadonlyArray<IssueComment> = []) {
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
    listPullRequestIssueComments: () => Effect.succeed(comments),
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
    getViewerLogin: () => Effect.succeed("octocat"),
    checkoutPullRequest: () => Effect.void,
    getPullRequestReviewStatus: () => Effect.die("unused"),
    getPullRequestMergeState: () => Effect.die("unused"),
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
  mode?: "auto" | "mention";
  fixModelMode?: "thread" | "review" | "custom";
  fixModelSelection?: typeof modelSelection | null;
  comments?: ReadonlyArray<IssueComment>;
  listCount: { value: number };
  maintenanceCount?: { drain: number; sync: number };
  order?: string[];
}) {
  return Layer.mergeAll(
    AutoReviewJobStore.layerInMemory,
    AutoReviewPoller.layer({
      getSettings: Effect.succeed({
        autoReview: {
          ...DEFAULT_AUTO_REVIEW_SETTINGS,
          enabled: input.enabled,
          mode: input.mode ?? "auto",
          modelSelection,
          fixModelMode: input.fixModelMode ?? "thread",
          fixModelSelection: input.fixModelSelection ?? null,
          pollInterval: Duration.seconds(60),
        },
      }),
      listProjects: Effect.succeed([{ id: "proj", workspaceRoot: "/repo", deletedAt: null }]),
      isGitHubProject: () => Effect.succeed(true),
      contextForJob: () =>
        Effect.sync(() => {
          input.order?.push("review");
          return { cwd: "/repo", candidates: [] };
        }),
      drainPendingFixes: Effect.sync(() => {
        if (input.maintenanceCount) {
          input.maintenanceCount.drain += 1;
        }
      }),
      syncThreadPhases: Effect.sync(() => {
        if (input.maintenanceCount) {
          input.maintenanceCount.sync += 1;
        }
        input.order?.push("sync");
      }),
    }).pipe(
      Layer.provide(
        AutoReviewRunner.layer.pipe(
          Layer.provide(AutoReviewJobStore.layerInMemory),
          Layer.provide(
            Layer.succeed(GitHubCli.GitHubCli, makeGithub(input.listCount, input.comments)),
          ),
          Layer.provide(Layer.succeed(TextGeneration.TextGeneration, makeText())),
        ),
      ),
      Layer.provide(AutoReviewJobStore.layerInMemory),
      Layer.provide(
        Layer.succeed(GitHubCli.GitHubCli, makeGithub(input.listCount, input.comments)),
      ),
      Layer.provide(Layer.succeed(TextGeneration.TextGeneration, makeText())),
    ),
  );
}

describe("AutoReviewPoller", () => {
  it("enqueues a job for a new open PR head sha in auto mode", async () => {
    const listCount = { value: 0 };
    const maintenanceCount = { drain: 0, sync: 0 };
    await Effect.gen(function* () {
      const store = yield* AutoReviewJobStore.AutoReviewJobStore;
      const poller = yield* AutoReviewPoller.AutoReviewPoller;

      yield* poller.tick;
      const jobs = yield* store.list({ projectId: "proj" });
      expect(jobs.length).toBeGreaterThanOrEqual(1);
      expect(jobs[0]?.headSha).toBe("deadbeef01");
      expect(jobs[0]?.trigger).toBe("open_or_push");
      expect(jobs[0]?.headBranch).toBe("feat");
      // Phases sync twice per tick: once before the drain so in-flight reviews
      // are visible, once after to settle the outcome.
      expect(maintenanceCount).toEqual({ drain: 1, sync: 2 });

      yield* poller.tick;
      const again = yield* store.list({ projectId: "proj" });
      expect(again.filter((j) => j.headSha === "deadbeef01")).toHaveLength(1);
      expect(maintenanceCount).toEqual({ drain: 2, sync: 4 });
    }).pipe(
      Effect.provide(makeLayer({ enabled: true, listCount, maintenanceCount })),
      Effect.runPromise,
    );
  });

  it("syncs thread phases before running the review, not only after", async () => {
    const listCount = { value: 0 };
    const order: string[] = [];
    await Effect.gen(function* () {
      const poller = yield* AutoReviewPoller.AutoReviewPoller;
      yield* poller.tick;
      // Without a pre-drain sync the origin thread stays "done" for the whole
      // review, since drain awaits the reviewer before the trailing sync.
      expect(order).toEqual(["sync", "review", "sync"]);
    }).pipe(Effect.provide(makeLayer({ enabled: true, listCount, order })), Effect.runPromise);
  });

  // The two enqueue call sites are far apart in the tick and easy to let
  // drift, so both triggers assert the same fix-model behaviour. They did
  // drift once: only the auto path was threaded, and a mention-triggered
  // review silently fell back to the origin thread's model.
  describe("fix model reaches the job from every trigger", () => {
    const fixModel = { instanceId: ProviderInstanceId.make("claude"), model: "opus-5" };

    it("threads the resolved fix model through an auto-triggered review", async () => {
      const listCount = { value: 0 };
      await Effect.gen(function* () {
        const store = yield* AutoReviewJobStore.AutoReviewJobStore;
        const poller = yield* AutoReviewPoller.AutoReviewPoller;
        yield* poller.tick;

        const jobs = yield* store.list({ projectId: "proj" });
        expect(jobs[0]?.trigger).toBe("open_or_push");
        expect(jobs[0]?.fixModelSelection).toEqual(fixModel);
      }).pipe(
        Effect.provide(
          makeLayer({
            enabled: true,
            mode: "auto",
            fixModelMode: "custom",
            fixModelSelection: fixModel,
            listCount,
          }),
        ),
        Effect.runPromise,
      );
    });

    it("threads the resolved fix model through a mention-triggered review", async () => {
      const listCount = { value: 0 };
      await Effect.gen(function* () {
        const store = yield* AutoReviewJobStore.AutoReviewJobStore;
        const poller = yield* AutoReviewPoller.AutoReviewPoller;
        yield* poller.tick;

        const jobs = yield* store.list({ projectId: "proj" });
        expect(jobs[0]?.trigger).toBe("mention");
        expect(jobs[0]?.fixModelSelection).toEqual(fixModel);
      }).pipe(
        Effect.provide(
          makeLayer({
            enabled: true,
            mode: "mention",
            fixModelMode: "custom",
            fixModelSelection: fixModel,
            comments: [
              {
                id: "c1",
                body: "@surgecode please take a look",
                createdAt: "2026-05-25T12:00:00.000Z",
                authorLogin: "octocat",
              },
            ],
            listCount,
          }),
        ),
        Effect.runPromise,
      );
    });
  });

  it("does nothing when disabled", async () => {
    const listCount = { value: 0 };
    const maintenanceCount = { drain: 0, sync: 0 };
    await Effect.gen(function* () {
      const store = yield* AutoReviewJobStore.AutoReviewJobStore;
      const poller = yield* AutoReviewPoller.AutoReviewPoller;
      yield* poller.tick;
      const jobs = yield* store.list();
      expect(jobs).toHaveLength(0);
      expect(listCount.value).toBe(0);
      expect(maintenanceCount).toEqual({ drain: 0, sync: 0 });
    }).pipe(
      Effect.provide(makeLayer({ enabled: false, listCount, maintenanceCount })),
      Effect.runPromise,
    );
  });
});
