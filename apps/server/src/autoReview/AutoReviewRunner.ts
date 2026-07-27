import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type {
  AutoReviewFindings,
  AutoReviewJob,
  ModelSelection,
  ThreadId,
} from "@t3tools/contracts";
import {
  buildOriginFixPrompt,
  clampAutoReviewConcurrency,
  linkOriginThread,
  parseAutoReviewFooter,
  shouldAutoFixOriginThread,
  type ThreadLinkCandidate,
} from "@t3tools/shared/autoReview";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as AutoReviewJobStore from "./AutoReviewJobStore.ts";
import { parseDiffAnchors } from "./diffAnchors.ts";
import { describeAutoReviewFailure } from "./failureMessage.ts";
import {
  buildReviewBody,
  normalizeFindings,
  partitionReviewComments,
  resolveReviewEvent,
} from "./reviewPayload.ts";

export interface AutoReviewOriginContext {
  readonly cwd: string;
  readonly prTitle?: string;
  readonly prBody?: string;
  readonly candidates: ReadonlyArray<ThreadLinkCandidate>;
  /**
   * Absent when the project's policy disables auto-fix — the review is still
   * posted, nothing is dispatched to the origin thread.
   */
  readonly queueOrDispatchFix?: (input: {
    readonly jobId: string;
    readonly threadId: string;
    readonly prompt: string;
    /** null keeps the origin thread on its own model. */
    readonly modelSelection: ModelSelection | null;
  }) => Effect.Effect<"dispatched" | "queued">;
  readonly existingReviewBodies?: ReadonlyArray<string>;
}

export class AutoReviewRunner extends Context.Service<
  AutoReviewRunner,
  {
    readonly runJob: (jobId: string, context: AutoReviewOriginContext) => Effect.Effect<void>;
    readonly drain: (
      contextForJob: (job: {
        readonly projectId: string;
        readonly prNumber: number;
        readonly headSha: string;
      }) => Effect.Effect<AutoReviewOriginContext>,
      concurrency?: number,
    ) => Effect.Effect<number>;
  }
>()("t3/autoReview/AutoReviewRunner") {}

function toGithubEvent(
  decision: ReturnType<typeof resolveReviewEvent>,
): GitHubCli.GitHubPullRequestReviewEvent {
  if (decision === "request_changes") {
    return "REQUEST_CHANGES";
  }
  if (decision === "approve") {
    return "APPROVE";
  }
  return "COMMENT";
}

/**
 * GitHub rejects APPROVE and REQUEST_CHANGES when the review author is the PR
 * author (HTTP 422 — COMMENT is the only event accepted on your own PR). The
 * auto-review posts as the local `gh` user, which is usually also the PR
 * author, so a blocking verdict would fail the whole submission with an
 * opaque CLI error. Keep the honest verdict in the review body and downgrade
 * the GitHub-side event to COMMENT instead.
 */
function resolveSubmittableEvent(input: {
  readonly decision: ReturnType<typeof resolveReviewEvent>;
  readonly prAuthorLogin: string | null | undefined;
  readonly viewerLogin: string | null;
}): GitHubCli.GitHubPullRequestReviewEvent {
  const event = toGithubEvent(input.decision);
  if (
    event !== "COMMENT" &&
    input.viewerLogin !== null &&
    input.prAuthorLogin != null &&
    input.viewerLogin.trim().toLowerCase() === input.prAuthorLogin.trim().toLowerCase()
  ) {
    return "COMMENT";
  }
  return event;
}

export const make = Effect.gen(function* () {
  const store = yield* AutoReviewJobStore.AutoReviewJobStore;
  const github = yield* GitHubCli.GitHubCli;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const runJob: AutoReviewRunner["Service"]["runJob"] = (jobId, context) =>
    Effect.gen(function* () {
      const job = yield* store.get(jobId);
      if (!job) {
        return;
      }
      if (job.status !== "running" && job.status !== "queued") {
        return;
      }
      if (job.status === "queued") {
        yield* store.update(job.id, { status: "running" });
      }

      const prReference = String(job.prNumber);

      const diff = yield* github
        .getPullRequestDiff({
          cwd: context.cwd,
          reference: prReference,
        })
        .pipe(Effect.mapError((error) => error));

      if (!diff.trim()) {
        yield* store.update(job.id, {
          status: "skipped",
          skipReason: "empty_diff",
        });
        return;
      }

      const maxDiffBytes = 400_000;
      const truncated = Buffer.byteLength(diff, "utf8") > maxDiffBytes;
      const diffPatch = truncated
        ? Buffer.from(diff, "utf8").subarray(0, maxDiffBytes).toString("utf8")
        : diff;

      const prMeta = yield* github.getPullRequest({
        cwd: context.cwd,
        reference: prReference,
      });

      const rawFindings = yield* textGeneration.generateAutoReviewFindings({
        cwd: context.cwd,
        prNumber: job.prNumber,
        prTitle: context.prTitle ?? prMeta.title,
        prBody: context.prBody ?? "",
        baseBranch: prMeta.baseRefName,
        headBranch: prMeta.headRefName,
        headSha: job.headSha,
        diffPatch,
        truncated,
        modelSelection: job.modelSelection,
      });

      const findings = normalizeFindings(rawFindings as AutoReviewFindings);
      const decision = resolveReviewEvent(findings);
      // Anchor against the full diff, not the byte-truncated prompt copy: a
      // comment on a hunk past the truncation point is still valid on GitHub.
      const anchors = parseDiffAnchors(diff);
      const { anchorable, unanchored } = partitionReviewComments(findings.comments, anchors);
      const body = buildReviewBody({
        findings: { ...findings, decision },
        unanchored,
        modelSelection: job.modelSelection as ModelSelection,
        headSha: job.headSha,
      });

      const shortSha = job.headSha.slice(0, 12).toLowerCase();
      const alreadyPosted = (context.existingReviewBodies ?? []).some((reviewBody) => {
        const parsed = parseAutoReviewFooter(reviewBody);
        return parsed !== null && shortSha.startsWith(parsed.headSha.slice(0, 7));
      });

      let reviewUrl: string | null = null;
      let githubReviewId: string | null = null;

      if (!alreadyPosted || job.trigger === "mention") {
        const viewerLogin = yield* github
          .getViewerLogin({ cwd: context.cwd })
          .pipe(Effect.orElseSucceed(() => null));
        const event = resolveSubmittableEvent({
          decision,
          prAuthorLogin: prMeta.authorLogin,
          viewerLogin,
        });
        const submitted = yield* github
          .submitPullRequestReview({
            cwd: context.cwd,
            reference: prReference,
            commitId: job.headSha,
            body,
            event,
            comments: anchorable,
          })
          .pipe(
            // GitHub rejects the whole review when one inline comment fails to
            // anchor, so retry body-only rather than lose the findings. The
            // rejected comments are re-rendered into the body.
            Effect.catchIf(
              (error) =>
                error._tag === "GitHubPullRequestReviewRejectedError" &&
                error.inlineCommentRejected,
              () =>
                github.submitPullRequestReview({
                  cwd: context.cwd,
                  reference: prReference,
                  commitId: job.headSha,
                  body: buildReviewBody({
                    findings: { ...findings, decision },
                    unanchored: findings.comments,
                    modelSelection: job.modelSelection as ModelSelection,
                    headSha: job.headSha,
                    // Anchorable findings are in here too, so do not claim
                    // they missed the diff — GitHub refused the whole batch.
                    unanchoredReason: "inline-rejected",
                  }),
                  event,
                }),
            ),
          );
        reviewUrl = submitted.url || null;
        githubReviewId = submitted.reviewId || null;
      }

      const originThreadId = linkOriginThread({
        projectId: String(job.projectId),
        prNumber: job.prNumber,
        headBranch: prMeta.headRefName,
        candidates: context.candidates,
      });

      const actionable = shouldAutoFixOriginThread(findings);
      let autoFixEnqueued = false;
      if (originThreadId && actionable && context.queueOrDispatchFix) {
        const prompt = buildOriginFixPrompt({
          prNumber: job.prNumber,
          prUrl: prMeta.url,
          headSha: job.headSha,
          findings,
        });
        const outcome = yield* context
          .queueOrDispatchFix({
            jobId: job.id,
            threadId: originThreadId,
            prompt,
            modelSelection: job.fixModelSelection,
          })
          .pipe(Effect.orElseSucceed(() => "queued" as const));
        autoFixEnqueued = outcome === "dispatched";
      }

      yield* store.update(job.id, {
        status: "succeeded",
        decision,
        actionableFindings: actionable,
        findingsCount: findings.comments.length,
        reviewUrl,
        githubReviewId,
        originThreadId: originThreadId as ThreadId | null,
        autoFixEnqueued,
        error: null,
        skipReason: null,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        store
          .update(jobId, {
            status: "failed",
            error: describeAutoReviewFailure(cause),
          })
          .pipe(Effect.asVoid),
      ),
    );

  /** Resolve context and run one already-claimed job. Never fails. */
  const runClaimed = (
    job: AutoReviewJob,
    contextForJob: Parameters<AutoReviewRunner["Service"]["drain"]>[0],
  ) =>
    Effect.gen(function* () {
      const context = yield* contextForJob({
        projectId: String(job.projectId),
        prNumber: job.prNumber,
        headSha: job.headSha,
      }).pipe(
        Effect.orElseSucceed(
          () =>
            ({
              cwd: "",
              candidates: [],
            }) satisfies AutoReviewOriginContext,
        ),
      );
      if (!context.cwd) {
        yield* store.update(job.id, {
          status: "failed",
          error: "Missing project workspace for auto-review job.",
        });
        return false;
      }
      yield* runJob(job.id, context);
      return true;
    });

  const drain: AutoReviewRunner["Service"]["drain"] = (contextForJob, concurrency = 1) =>
    Effect.gen(function* () {
      const limit = clampAutoReviewConcurrency(concurrency);
      // One batched claim rather than a claim-per-slot loop: the batch is what
      // enforces "never two jobs on the same PR at once", and claiming the
      // whole set up front is what lets the reviews actually overlap.
      const claimed = yield* store.claimNextBatch(limit);
      if (claimed.length === 0) {
        return 0;
      }
      const outcomes = yield* Effect.forEach(claimed, (job) => runClaimed(job, contextForJob), {
        concurrency: limit,
      });
      return outcomes.filter(Boolean).length;
    });

  return AutoReviewRunner.of({ runJob, drain });
});

export const layer = Layer.effect(AutoReviewRunner, make);
