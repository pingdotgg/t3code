import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as Schema from "effect/Schema";

import {
  ReviewMergeError,
  ReviewThreadNotFoundError,
  TextGenerationError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  type ReviewMergePullRequestError,
  type ReviewMergePullRequestInput,
  type ReviewMergePullRequestResult,
  type ReviewThreadPrStatus,
  type ReviewThreadSummaryError,
  type ReviewThreadSummaryInput,
  type ReviewThreadSummaryResult,
} from "@t3tools/contracts";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
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
    readonly mergePullRequest: (
      input: ReviewMergePullRequestInput,
    ) => Effect.Effect<ReviewMergePullRequestResult, ReviewMergePullRequestError>;
  }
>()("t3/review/ReviewService") {}

// ---------------------------------------------------------------------------
// PR investigation
// ---------------------------------------------------------------------------

/** Shape of `gh pr view --json <fields>` we rely on. Decoded leniently:
    a schema miss degrades to "no PR context", never a failed review. */
const GhPrView = Schema.Struct({
  number: Schema.Int,
  url: Schema.String,
  state: Schema.String,
  reviewDecision: Schema.optionalKey(Schema.NullOr(Schema.String)),
  mergeable: Schema.optionalKey(Schema.NullOr(Schema.String)),
  statusCheckRollup: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(Schema.Struct({ conclusion: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
    ),
  ),
  comments: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          author: Schema.optionalKey(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
          body: Schema.String,
          createdAt: Schema.String,
        }),
      ),
    ),
  ),
});
const decodeGhPrView = Schema.decodeUnknownEffect(Schema.fromJsonString(GhPrView));

const GH_PR_VIEW_FIELDS = "number,url,state,reviewDecision,mergeable,statusCheckRollup,comments";
const PR_COMMENT_CONTEXT_COUNT = 5;
const PR_COMMENT_CHAR_LIMIT = 500;

export interface ThreadPrContext {
  readonly status: ReviewThreadPrStatus;
  /** Pre-rendered recent-comments block for the review prompt. */
  readonly recentComments: ReadonlyArray<{
    readonly author: string;
    readonly createdAt: string;
    readonly body: string;
  }>;
}

function ghStateToPrState(state: string): "open" | "closed" | "merged" | null {
  const normalized = state.trim().toUpperCase();
  if (normalized === "OPEN") return "open";
  if (normalized === "CLOSED") return "closed";
  if (normalized === "MERGED") return "merged";
  return null;
}

function rollupToChecksPassing(
  rollup: ReadonlyArray<{ conclusion?: string | null }> | null | undefined,
): boolean | null {
  if (!rollup || rollup.length === 0) return null;
  // Neutral/skipped conclusions don't block; pending (null conclusion on some
  // check types) and failures do.
  const blocking = rollup.some((check) => {
    const conclusion = check.conclusion?.trim().toUpperCase() ?? "";
    return !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion);
  });
  return !blocking;
}

function toPrStatus(view: typeof GhPrView.Type): ReviewThreadPrStatus | null {
  const state = ghStateToPrState(view.state);
  if (state === null) return null;
  const reviewDecision = view.reviewDecision?.trim() || null;
  const checksPassing = rollupToChecksPassing(view.statusCheckRollup ?? null);
  const mergeable =
    view.mergeable == null
      ? null
      : view.mergeable.trim().toUpperCase() === "MERGEABLE"
        ? true
        : view.mergeable.trim().toUpperCase() === "CONFLICTING"
          ? false
          : null;
  const mergeReady =
    state === "open" &&
    mergeable === true &&
    checksPassing !== false &&
    reviewDecision !== "CHANGES_REQUESTED" &&
    reviewDecision !== "REVIEW_REQUIRED";
  return {
    number: view.number,
    url: view.url,
    state,
    reviewDecision,
    checksPassing,
    mergeable,
    mergeReady,
    recentCommentCount: view.comments?.length ?? 0,
  };
}

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
  const gitHubCli = yield* GitHubCli.GitHubCli;

  /** Look up the thread branch's PR with one `gh pr view`. Every failure —
      no PR, gh unauthenticated, schema drift — degrades to null: PR context
      enriches a review but must never fail it. */
  const investigateThreadPr = Effect.fn("ReviewService.investigateThreadPr")(function* (
    cwd: string,
    branch: string,
  ): Effect.fn.Return<ThreadPrContext | null, never> {
    const context = yield* gitHubCli
      .execute({
        cwd,
        args: ["pr", "view", branch, "--json", GH_PR_VIEW_FIELDS],
        timeoutMs: 20_000,
      })
      .pipe(
        Effect.flatMap((output) => decodeGhPrView(output.stdout)),
        Effect.map((view): ThreadPrContext | null => {
          const status = toPrStatus(view);
          if (status === null) return null;
          const recentComments = (view.comments ?? [])
            .slice(-PR_COMMENT_CONTEXT_COUNT)
            .map((comment) => ({
              author: comment.author?.login ?? "unknown",
              createdAt: comment.createdAt,
              body:
                comment.body.length > PR_COMMENT_CHAR_LIMIT
                  ? `${comment.body.slice(0, PR_COMMENT_CHAR_LIMIT)}…`
                  : comment.body,
            }));
          return { status, recentComments };
        }),
        Effect.catch(() => Effect.succeed(null)),
      );
    return context;
  });

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

    // Deeper investigation: live PR state + recent comments, when the
    // thread has a branch. Failures degrade to "no PR context".
    const prContext =
      thread.branch !== null ? yield* investigateThreadPr(cwd, thread.branch) : null;

    const generated = yield* textGeneration.generateThreadReview({
      cwd,
      title: thread.title,
      isActive,
      firstUserMessage,
      recentMessages,
      modelSelection,
      ...(prContext !== null
        ? {
            pullRequest: {
              number: prContext.status.number,
              state: prContext.status.state,
              reviewDecision: prContext.status.reviewDecision,
              checksPassing: prContext.status.checksPassing,
              mergeable: prContext.status.mergeable,
              recentComments: prContext.recentComments,
            },
          }
        : {}),
    });

    // Belt and braces on top of prompt rules + normalizeThreadReview: an
    // active thread must never carry a settle recommendation.
    const recommendSettle = generated.recommendSettle && canSettleNow;

    // Latest ready checkpoint approximates the thread's cumulative diff —
    // checkpoints stack per turn, so the newest one reflects total change.
    const latestCheckpoint = thread.checkpoints
      .toReversed()
      .find((checkpoint) => checkpoint.status === "ready");
    const diffStats = latestCheckpoint
      ? {
          files: latestCheckpoint.files.length,
          additions: latestCheckpoint.files.reduce((sum, file) => sum + file.additions, 0),
          deletions: latestCheckpoint.files.reduce((sum, file) => sum + file.deletions, 0),
        }
      : undefined;

    return {
      threadId: input.threadId,
      summary: generated.summary,
      nextStep: generated.nextStep,
      suggestedTitle: generated.suggestedTitle,
      recommendSettle,
      settleReason: recommendSettle ? generated.settleReason : null,
      ...(diffStats !== undefined ? { diffStats } : {}),
      ...(prContext !== null ? { prStatus: prContext.status } : {}),
    };
  });

  const mergePullRequest: ReviewService["Service"]["mergePullRequest"] = Effect.fn(
    "ReviewService.mergePullRequest",
  )(function* (input) {
    const mapProjectionError = (cause: unknown) =>
      new ReviewMergeError({
        threadId: input.threadId,
        detail: `Failed to read the thread projection: ${String(cause)}`,
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
    const cwd = resolveThreadWorkspaceCwd({
      thread,
      projects: Option.isSome(projectOption) ? [projectOption.value] : [],
    });
    if (cwd === undefined || thread.branch === null) {
      return yield* new ReviewMergeError({
        threadId: input.threadId,
        detail: "Thread has no resolvable workspace or branch to merge from.",
      });
    }

    // Re-validate against LIVE GitHub state: in a merge queue, an earlier
    // merge may have landed since the review ran and made this branch
    // conflict (or someone merged/closed the PR out of band).
    const prContext = yield* investigateThreadPr(cwd, thread.branch);
    if (prContext === null || prContext.status.number !== input.pullRequestNumber) {
      return {
        threadId: input.threadId,
        outcome: "not-ready" as const,
        detail: "The pull request could not be re-validated against GitHub.",
      };
    }
    const status = prContext.status;
    if (status.state !== "open") {
      return {
        threadId: input.threadId,
        outcome: "already-closed" as const,
        detail: `PR #${status.number} is already ${status.state}.`,
      };
    }
    if (status.mergeable === false) {
      return {
        threadId: input.threadId,
        outcome: "conflict" as const,
        detail: `PR #${status.number} no longer merges cleanly onto its base branch.`,
      };
    }
    if (!status.mergeReady) {
      return {
        threadId: input.threadId,
        outcome: "not-ready" as const,
        detail: `PR #${status.number} is not merge-ready (checks: ${String(status.checksPassing)}, review: ${status.reviewDecision ?? "none"}).`,
      };
    }

    const mergeResult = yield* gitHubCli
      .execute({
        cwd,
        args: ["pr", "merge", String(status.number), "--squash"],
        timeoutMs: 60_000,
      })
      .pipe(
        Effect.map(() => ({ merged: true as const, detail: null as string | null })),
        Effect.catch((error) =>
          Effect.succeed({
            merged: false as const,
            detail: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    if (!mergeResult.merged) {
      // gh merge failures at this point are usually races (base advanced,
      // check flipped). Surface as conflict so the queue hands it to the
      // thread's agent rather than aborting the whole run.
      return {
        threadId: input.threadId,
        outcome: "conflict" as const,
        detail: mergeResult.detail ?? "gh pr merge failed.",
      };
    }
    return { threadId: input.threadId, outcome: "merged" as const, detail: null };
  });

  return ReviewService.of({
    getDiffPreview,
    summarizeThread,
    mergePullRequest,
  });
});

export const layer = Layer.effect(ReviewService, make);
