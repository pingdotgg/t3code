import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AutoReviewFindings, ModelSelection, ThreadId } from "@t3tools/contracts";
import {
  buildOriginFixPrompt,
  linkOriginThread,
  parseAutoReviewFooter,
  shouldAutoFixOriginThread,
  type ThreadLinkCandidate,
} from "@t3tools/shared/autoReview";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as AutoReviewJobStore from "./AutoReviewJobStore.ts";
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
  readonly dispatchFixPrompt?: (input: {
    readonly threadId: string;
    readonly prompt: string;
  }) => Effect.Effect<void>;
  readonly existingReviewBodies?: ReadonlyArray<string>;
}

export class AutoReviewRunner extends Context.Service<
  AutoReviewRunner,
  {
    readonly runJob: (
      jobId: string,
      context: AutoReviewOriginContext,
    ) => Effect.Effect<void>;
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

      const diff = yield* github.getPullRequestDiff({
        cwd: context.cwd,
        reference: prReference,
      }).pipe(
        Effect.mapError((error) => error),
      );

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
      const { anchorable, unanchored } = partitionReviewComments(findings.comments);
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
        const submitted = yield* github.submitPullRequestReview({
          cwd: context.cwd,
          reference: prReference,
          commitId: job.headSha,
          body,
          event: toGithubEvent(decision),
          comments: anchorable,
        });
        reviewUrl = submitted.url || null;
        githubReviewId = submitted.reviewId || null;
      }

      const originThreadId = linkOriginThread({
        projectId: String(job.projectId),
        prNumber: job.prNumber,
        headBranch: prMeta.headRefName,
        candidates: context.candidates,
      });

      let autoFixEnqueued = false;
      if (
        originThreadId &&
        shouldAutoFixOriginThread(findings) &&
        context.dispatchFixPrompt
      ) {
        const prompt = buildOriginFixPrompt({
          prNumber: job.prNumber,
          prUrl: prMeta.url,
          headSha: job.headSha,
          findings,
        });
        yield* context
          .dispatchFixPrompt({ threadId: originThreadId, prompt })
          .pipe(Effect.asVoid, Effect.orElseSucceed(() => undefined));
        autoFixEnqueued = true;
      }

      yield* store.update(job.id, {
        status: "succeeded",
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
            error: String(cause),
          })
          .pipe(Effect.asVoid),
      ),
    );

  const drain: AutoReviewRunner["Service"]["drain"] = (contextForJob, concurrency = 1) =>
    Effect.gen(function* () {
      let completed = 0;
      const limit = Math.max(1, concurrency);
      for (let i = 0; i < limit; i += 1) {
        const job = yield* store.claimNext();
        if (!job) {
          break;
        }
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
          continue;
        }
        yield* runJob(job.id, context);
        completed += 1;
      }
      return completed;
    });

  return AutoReviewRunner.of({ runJob, drain });
});

export const layer = Layer.effect(AutoReviewRunner, make);

