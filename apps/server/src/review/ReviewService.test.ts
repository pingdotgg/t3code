import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import {
  ThreadId,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ReviewService from "./ReviewService.ts";

function makeShellFromThread(
  thread: OrchestrationThread,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestTurn: thread.latestTurn,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    settledOverride: thread.settledOverride,
    settledAt: thread.settledAt,
    session: thread.session,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeLayer(input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly detectCalls?: Array<{ readonly cwd: string }>;
  readonly thread?: OrchestrationThread;
  readonly shellOverrides?: Partial<OrchestrationThreadShell>;
  readonly generateThreadReview?: TextGeneration.TextGeneration["Service"]["generateThreadReview"];
  readonly reviewCalls?: Array<TextGeneration.ThreadReviewGenerationInput>;
}) {
  return ReviewService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        get: () => Effect.die("unexpected VCS registry get"),
        resolve: () => Effect.die("unexpected VCS registry resolve"),
        detect: (request) =>
          Effect.sync(() => {
            input.detectCalls?.push({ cwd: request.cwd });
            return null;
          }),
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getThreadDetailById: (threadId) =>
          Effect.succeed(
            input.thread && input.thread.id === threadId
              ? Option.some(input.thread)
              : Option.none(),
          ),
        getThreadShellById: (threadId) =>
          Effect.succeed(
            input.thread && input.thread.id === threadId
              ? Option.some(makeShellFromThread(input.thread, input.shellOverrides))
              : Option.none(),
          ),
        getProjectShellById: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provide(
      Layer.mock(TextGeneration.TextGeneration)({
        generateThreadReview: (reviewInput) => {
          input.reviewCalls?.push(reviewInput);
          return (
            input.generateThreadReview?.(reviewInput) ??
            Effect.succeed({
              summary: "Did the thing.",
              suggestedTitle: null,
              recommendSettle: true,
              settleReason: "Work concluded.",
            })
          );
        },
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(ServerConfig.layerTest(input.workspaceRoot, input.baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
}

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: ThreadId.make("thread_review_1"),
    projectId: "project_1" as OrchestrationThread["projectId"],
    title: "New thread",
    modelSelection: {
      instanceId: "codex" as OrchestrationThread["modelSelection"]["instanceId"],
      model: "gpt-5",
      options: [],
    },
    runtimeMode: "local",
    interactionMode: "chat",
    branch: null,
    // Tests mock getProjectShellById to None, so cwd resolution relies on
    // the worktree path; a thread with neither now fails loudly by design.
    worktreePath: "/tmp/t3-review-test-worktree",
    latestTurn: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  } as OrchestrationThread;
}

function makeMessage(input: {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly streaming?: boolean;
}): OrchestrationThread["messages"][number] {
  return {
    id: input.id as OrchestrationThread["messages"][number]["id"],
    role: input.role,
    text: input.text,
    turnId: null,
    streaming: input.streaming ?? false,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

describe("ReviewService", () => {
  it.effect("rejects diff preview cwd outside the configured workspace roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffPreview");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within the configured workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows diff preview cwd inside the configured workspace root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: workspaceRoot });
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(result.cwd, workspaceRoot);
      assert.deepStrictEqual(result.sources, []);
      assert.deepStrictEqual(detectCalls, [{ cwd: workspaceRoot }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves unexpected path-resolution failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const invalidCwd = `${workspaceRoot}\0invalid`;
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: invalidCwd }).pipe(Effect.flip);
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      if (error._tag !== "VcsRepositoryDetectionError") return;
      assert.strictEqual(error.operation, "ReviewService.assertWorkspaceBoundCwd.canonicalizePath");
      assert.strictEqual(error.cwd, invalidCwd);
      assert.match(error.detail, /Failed to resolve a path/);
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("summarizeThread fails with ReviewThreadNotFoundError for unknown threads", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review
          .summarizeThread({ threadId: ThreadId.make("thread_missing"), canSettleNow: true })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir })));

      assert.strictEqual(error._tag, "ReviewThreadNotFoundError");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("summarizeThread passes transcript context and returns the review", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const reviewCalls: Array<TextGeneration.ThreadReviewGenerationInput> = [];
      const thread = makeThread({
        messages: [
          makeMessage({ id: "msg_1", role: "user", text: "Fix the settle default" }),
          makeMessage({ id: "msg_2", role: "assistant", text: "Done, merged in PR #1" }),
          makeMessage({ id: "msg_3", role: "assistant", text: "streaming...", streaming: true }),
        ],
      });

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.summarizeThread({ threadId: thread.id, canSettleNow: true });
      }).pipe(
        Effect.provide(
          makeLayer({
            workspaceRoot,
            baseDir,
            thread,
            reviewCalls,
            generateThreadReview: () =>
              Effect.succeed({
                summary: "Bumped the settle default; PR merged.",
                suggestedTitle: "Bump settle default",
                recommendSettle: true,
                settleReason: "PR merged, nothing pending.",
              }),
          }),
        ),
      );

      assert.strictEqual(result.threadId, thread.id);
      assert.strictEqual(result.summary, "Bumped the settle default; PR merged.");
      assert.strictEqual(result.suggestedTitle, "Bump settle default");
      assert.strictEqual(result.recommendSettle, true);
      assert.strictEqual(result.settleReason, "PR merged, nothing pending.");

      assert.strictEqual(reviewCalls.length, 1);
      const call = reviewCalls[0]!;
      assert.strictEqual(call.title, "New thread");
      assert.strictEqual(call.isActive, false);
      assert.strictEqual(call.firstUserMessage, "Fix the settle default");
      // Streaming messages are excluded from the transcript.
      assert.deepStrictEqual(
        call.recentMessages.map((message) => message.text),
        ["Fix the settle default", "Done, merged in PR #1"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("summarizeThread never recommends settling when canSettleNow is false", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const reviewCalls: Array<TextGeneration.ThreadReviewGenerationInput> = [];
      const thread = makeThread({});

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.summarizeThread({ threadId: thread.id, canSettleNow: false });
      }).pipe(
        Effect.provide(
          makeLayer({
            workspaceRoot,
            baseDir,
            thread,
            reviewCalls,
            // Model misbehaves and recommends settle anyway.
            generateThreadReview: () =>
              Effect.succeed({
                summary: "Still working.",
                suggestedTitle: null,
                recommendSettle: true,
                settleReason: "Looks done to me.",
              }),
          }),
        ),
      );

      assert.strictEqual(reviewCalls[0]?.isActive, true);
      assert.strictEqual(result.recommendSettle, false);
      assert.strictEqual(result.settleReason, null);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "summarizeThread overrides a stale client canSettleNow when the projection shows activity",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const workspaceRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-review-workspace-",
        });
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
        const reviewCalls: Array<TextGeneration.ThreadReviewGenerationInput> = [];
        const thread = makeThread({});

        const result = yield* Effect.gen(function* () {
          const review = yield* ReviewService.ReviewService;
          // Client believed the thread was settleable, but the server-side
          // shell says approvals are pending.
          return yield* review.summarizeThread({ threadId: thread.id, canSettleNow: true });
        }).pipe(
          Effect.provide(
            makeLayer({
              workspaceRoot,
              baseDir,
              thread,
              reviewCalls,
              shellOverrides: { hasPendingApprovals: true },
              generateThreadReview: () =>
                Effect.succeed({
                  summary: "Looks finished.",
                  suggestedTitle: null,
                  recommendSettle: true,
                  settleReason: "Done.",
                }),
            }),
          ),
        );

        assert.strictEqual(reviewCalls[0]?.isActive, true);
        assert.strictEqual(result.recommendSettle, false);
        assert.strictEqual(result.settleReason, null);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("summarizeThread fails loudly when no workspace cwd can be resolved", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      // No worktree and (per the mock) no project shell: cwd is unresolvable.
      const thread = makeThread({ worktreePath: null });

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review
          .summarizeThread({ threadId: thread.id, canSettleNow: true })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, thread })));

      assert.strictEqual(error._tag, "TextGenerationError");
      if (error._tag === "TextGenerationError") {
        assert.match(error.detail, /Unable to resolve a workspace directory/);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("summarizeThread treats a queued turn start as active", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const reviewCalls: Array<TextGeneration.ThreadReviewGenerationInput> = [];
      const thread = makeThread({});

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.summarizeThread({ threadId: thread.id, canSettleNow: true });
      }).pipe(
        Effect.provide(
          makeLayer({
            workspaceRoot,
            baseDir,
            thread,
            reviewCalls,
            // A just-sent user message with no adopting turn: session still
            // null, but the thread has in-flight work. it.effect runs on the
            // TestClock (epoch 0), so "just sent" is the epoch.
            shellOverrides: {
              latestUserMessageAt: "1970-01-01T00:00:00.000Z",
              latestTurn: null,
              session: null,
            },
            generateThreadReview: () =>
              Effect.succeed({
                summary: "Looks finished.",
                suggestedTitle: null,
                recommendSettle: true,
                settleReason: "Done.",
              }),
          }),
        ),
      );

      assert.strictEqual(reviewCalls[0]?.isActive, true);
      assert.strictEqual(result.recommendSettle, false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
