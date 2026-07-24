import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  ReviewThreadNotFoundError,
  TextGenerationError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  type ReviewThreadSummaryError,
  type ReviewThreadSummaryInput,
  type ReviewThreadSummaryResult,
} from "@t3tools/contracts";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export class ReviewService extends Context.Service<
  ReviewService,
  {
    readonly getDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, ReviewDiffPreviewError>;
    readonly summarizeThread: (
      input: ReviewThreadSummaryInput,
    ) => Effect.Effect<ReviewThreadSummaryResult, ReviewThreadSummaryError>;
  }
>()("t3/review/ReviewService") {}

// Mirrors QUEUED_TURN_START_GRACE_MS in client-runtime threadSettled.ts and
// the decider's thread.settle guard.
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

/** A user message no turn has adopted yet is in-flight work even though the
    session is still null. Mirrors the decider's settle guard and the
    client's hasQueuedTurnStart: newest user message strictly newer than
    every latestTurn timestamp, within the adoption grace window, and not
    already surfaced as a failed session start. */
function hasQueuedTurnStart(
  shell: {
    readonly latestUserMessageAt: string | null;
    readonly latestTurn: {
      readonly requestedAt: string | null;
      readonly startedAt: string | null;
      readonly completedAt: string | null;
    } | null;
    readonly session: { readonly status: string } | null;
  },
  nowMs: number,
): boolean {
  if (shell.latestUserMessageAt === null) return false;
  if (shell.session?.status === "error") return false;
  const messageAt = Date.parse(shell.latestUserMessageAt);
  if (Number.isNaN(messageAt)) return false;
  // Bounded on both sides: message timestamps originate on client devices,
  // so a clock ahead of the server must not hold the queued state open.
  if (Math.abs(nowMs - messageAt) > QUEUED_TURN_START_GRACE_MS) return false;
  const turn = shell.latestTurn;
  if (turn === null) return true;
  return [turn.requestedAt, turn.startedAt, turn.completedAt].every(
    (candidate) => candidate === null || Date.parse(candidate) < messageAt,
  );
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const canonicalizePath = (value: string) => {
    const resolvedPath = path.resolve(value);
    return fileSystem.realPath(resolvedPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(resolvedPath)
            : Effect.fail(
                new VcsRepositoryDetectionError({
                  operation: "ReviewService.assertWorkspaceBoundCwd.canonicalizePath",
                  cwd: resolvedPath,
                  detail: "Failed to resolve a path while validating the review workspace.",
                  cause,
                }),
              ),
      }),
    );
  };

  const isWithinRoot = (candidate: string, root: string) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const assertWorkspaceBoundCwd = Effect.fn("ReviewService.assertWorkspaceBoundCwd")(function* (
    cwd: string,
  ) {
    const [candidate, workspaceRoot, worktreesRoot] = yield* Effect.all([
      canonicalizePath(cwd),
      canonicalizePath(config.cwd),
      canonicalizePath(config.worktreesDir),
    ]);

    if (isWithinRoot(candidate, workspaceRoot) || isWithinRoot(candidate, worktreesRoot)) {
      return;
    }

    return yield* new VcsRepositoryDetectionError({
      operation: "ReviewService.getDiffPreview",
      cwd,
      detail: "Review diff preview cwd must stay within the configured workspace root.",
    });
  });

  const getDiffPreview: ReviewService["Service"]["getDiffPreview"] = Effect.fn(
    "ReviewService.getDiffPreview",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd(input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle) {
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [],
      };
    }

    const getDriverDiffPreview = handle.driver.getDiffPreview;
    if (!getDriverDiffPreview) {
      if (handle.kind === "git") {
        return yield* git.getReviewDiffPreview(input);
      }
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffPreview",
        kind: handle.kind,
        detail: `The ${handle.kind} VCS driver does not support review diff previews.`,
      });
    }

    return yield* getDriverDiffPreview(input);
  });

  const summarizeThread: ReviewService["Service"]["summarizeThread"] = Effect.fn(
    "ReviewService.summarizeThread",
  )(function* (input) {
    const mapProjectionError = (cause: unknown) =>
      new TextGenerationError({
        operation: "generateThreadReview",
        detail: "Failed to read the thread projection for review.",
        cause,
      });

    const threadOption = yield* projectionSnapshotQuery
      .getThreadDetailById(input.threadId)
      .pipe(Effect.mapError(mapProjectionError));
    if (Option.isNone(threadOption)) {
      return yield* new ReviewThreadNotFoundError({ threadId: input.threadId });
    }
    const thread = threadOption.value;

    const projectOption = yield* projectionSnapshotQuery
      .getProjectShellById(thread.projectId)
      .pipe(Effect.mapError(mapProjectionError));
    // No silent process.cwd() fallback: the cwd is handed to the provider
    // CLI spawn, which reads local context files (AGENTS.md, CLAUDE.md) from
    // it — reviewing "the server's own directory" would leak unrelated
    // content into an external LLM prompt. Fail the item instead; the client
    // shows it as a retry-able error card.
    const cwd = resolveThreadWorkspaceCwd({
      thread,
      projects: Option.isSome(projectOption) ? [projectOption.value] : [],
    });
    if (cwd === undefined) {
      return yield* new TextGenerationError({
        operation: "generateThreadReview",
        detail: `Unable to resolve a workspace directory for thread '${input.threadId}'.`,
      });
    }

    const settled = thread.messages.filter((message) => !message.streaming);
    const firstUserMessage = settled.find((message) => message.role === "user")?.text ?? null;
    const recentMessages = settled.map((message) => ({
      role: message.role,
      text: message.text,
    }));
    // Never trust the client's canSettleNow alone: re-derive activity from the
    // server's own projection so a session that started (or approval/input
    // that appeared) after the client read its shell still blocks settling.
    // The shell is deliberately read AFTER the transcript: the two reads are
    // separate transactions, and reading the activity view last means a
    // session starting in between is still caught. The reverse skew (activity
    // ending in between) only staleness-affects the summary text — an actual
    // settle is re-validated by the client at apply time and by the decider's
    // thread.settle guards, so a recommendation can never settle live work.
    const shellOption = yield* projectionSnapshotQuery
      .getThreadShellById(input.threadId)
      .pipe(Effect.mapError(mapProjectionError));
    const shell = Option.isSome(shellOption) ? shellOption.value : null;
    const now = yield* DateTime.now;
    const serverSideActive =
      shell === null ||
      shell.hasPendingApprovals ||
      shell.hasPendingUserInput ||
      shell.session?.status === "starting" ||
      shell.session?.status === "running" ||
      hasQueuedTurnStart(shell, DateTime.toEpochMillis(now));
    const canSettleNow = input.canSettleNow && !serverSideActive;
    const isActive = !canSettleNow;

    const { textGenerationModelSelection: modelSelection } = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: "generateThreadReview",
            detail: "Failed to load server settings for review generation.",
            cause,
          }),
      ),
    );

    const generated = yield* textGeneration.generateThreadReview({
      cwd,
      title: thread.title,
      isActive,
      firstUserMessage,
      recentMessages,
      modelSelection,
    });

    // Belt and braces on top of prompt rules + normalizeThreadReview: an
    // active thread must never carry a settle recommendation.
    const recommendSettle = generated.recommendSettle && canSettleNow;
    return {
      threadId: input.threadId,
      summary: generated.summary,
      suggestedTitle: generated.suggestedTitle,
      recommendSettle,
      settleReason: recommendSettle ? generated.settleReason : null,
    };
  });

  return ReviewService.of({
    getDiffPreview,
    summarizeThread,
  });
});

export const layer = Layer.effect(ReviewService, make);
