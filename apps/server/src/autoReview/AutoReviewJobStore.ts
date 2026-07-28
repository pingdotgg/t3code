import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type {
  AutoReviewJob,
  AutoReviewJobId,
  AutoReviewJobStatus,
  AutoReviewTrigger,
  ModelSelection,
  ProjectId,
} from "@t3tools/contracts";
import {
  clampAutoReviewMaxAttempts,
  nextAutoReviewAttempt,
  occupiedAutoReviewFixThreads,
  selectClaimableAutoReviewJobs,
  shouldEnqueueAutoReviewJob,
} from "@t3tools/shared/autoReview";

export interface EnqueueAutoReviewJobInput {
  readonly projectId: ProjectId | string;
  readonly prNumber: number;
  readonly headSha: string;
  /** PR head branch, used to attribute an in-flight job to its origin thread. */
  readonly headBranch?: string | null;
  readonly trigger: AutoReviewTrigger;
  readonly commentId?: string | null;
  readonly modelSelection: ModelSelection;
  /**
   * Model the auto-fix turn must run under, or null/omitted to leave the
   * origin thread on its own model.
   */
  readonly fixModelSelection?: ModelSelection | null | undefined;
  /**
   * Total attempts allowed for this (project, PR, headSha) chain before the
   * store stops handing out retries. Defaults to
   * DEFAULT_AUTO_REVIEW_MAX_ATTEMPTS when omitted.
   */
  readonly maxAttempts?: number | undefined;
}

export interface AutoReviewCommentWatermark {
  readonly projectId: string;
  readonly prNumber: number;
  readonly lastCommentId: string | null;
  readonly lastSeenAt: string | null;
}

export class AutoReviewJobStore extends Context.Service<
  AutoReviewJobStore,
  {
    readonly enqueue: (
      input: EnqueueAutoReviewJobInput,
    ) => Effect.Effect<{ readonly job: AutoReviewJob; readonly created: boolean }>;
    readonly claimNext: () => Effect.Effect<AutoReviewJob | null>;
    /**
     * Claim up to `limit` queued jobs to run in parallel, never two for the
     * same pull request. Returned in FIFO order.
     */
    readonly claimNextBatch: (limit: number) => Effect.Effect<ReadonlyArray<AutoReviewJob>>;
    readonly update: (
      id: AutoReviewJobId | string,
      patch: Partial<
        Pick<
          AutoReviewJob,
          | "status"
          | "findingsCount"
          | "reviewUrl"
          | "githubReviewId"
          | "originThreadId"
          | "fixThreadId"
          | "autoFixEnqueued"
          | "autoFixDispatchedAt"
          | "pendingFix"
          | "decision"
          | "actionableFindings"
          | "error"
          | "skipReason"
        >
      >,
    ) => Effect.Effect<AutoReviewJob | null>;
    /**
     * Atomically take a fix-concurrency slot for `jobId`'s origin thread.
     *
     * Check-then-act across separate `list`/`update` calls is not safe here:
     * reviews run in parallel, so several finishing at once would each read a
     * budget that none of them had spent yet and all dispatch. This decides
     * and records the reservation in one `Ref` transition, so exactly `limit`
     * threads can hold a slot however many callers race.
     *
     * Returns false when the budget is full, when the thread already holds a
     * slot, or when the job has no origin thread — the caller parks the fix.
     */
    readonly reserveFixSlot: (input: {
      readonly jobId: AutoReviewJobId | string;
      readonly threadId: string;
      readonly limit: number;
      readonly busyThreadIds: ReadonlySet<string>;
      readonly now: string;
    }) => Effect.Effect<boolean>;
    /** Give back a slot whose dispatch failed. */
    readonly releaseFixSlot: (id: AutoReviewJobId | string) => Effect.Effect<void>;
    readonly get: (id: AutoReviewJobId | string) => Effect.Effect<AutoReviewJob | null>;
    readonly list: (input?: {
      readonly projectId?: string;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<AutoReviewJob>>;
    readonly findActiveByKey: (input: {
      readonly projectId: string;
      readonly prNumber: number;
      readonly headSha: string;
    }) => Effect.Effect<AutoReviewJob | null>;
    readonly requeueRunning: () => Effect.Effect<number>;
    readonly getWatermark: (
      projectId: string,
      prNumber: number,
    ) => Effect.Effect<AutoReviewCommentWatermark | null>;
    readonly setWatermark: (input: AutoReviewCommentWatermark) => Effect.Effect<void>;
  }
>()("t3/autoReview/AutoReviewJobStore") {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const ACTIVE: ReadonlySet<AutoReviewJobStatus> = new Set([
  "queued",
  "running",
  "succeeded",
  "skipped",
]);

export const makeInMemory = Effect.gen(function* () {
  const jobsRef = yield* Ref.make<AutoReviewJob[]>([]);
  const watermarksRef = yield* Ref.make<Map<string, AutoReviewCommentWatermark>>(new Map());
  const sequenceRef = yield* Ref.make(0);

  const watermarkKey = (projectId: string, prNumber: number) => `${projectId}:${prNumber}`;

  const findActiveByKey: AutoReviewJobStore["Service"]["findActiveByKey"] = (input) =>
    Ref.get(jobsRef).pipe(
      Effect.map(
        (jobs) =>
          jobs.find(
            (job) =>
              job.projectId === input.projectId &&
              job.prNumber === input.prNumber &&
              job.headSha === input.headSha &&
              ACTIVE.has(job.status),
          ) ?? null,
      ),
    );

  /**
   * Latest job for a (project, PR, headSha) key regardless of status. Used to
   * continue or cap the retry chain after a failure. `createdAt` carries a
   * zero-padded sequence suffix, so lexicographic order is insertion order.
   */
  const findLatestByKey = (input: {
    readonly projectId: string;
    readonly prNumber: number;
    readonly headSha: string;
  }) =>
    Ref.get(jobsRef).pipe(
      Effect.map(
        (jobs) =>
          jobs
            .filter(
              (job) =>
                job.projectId === input.projectId &&
                job.prNumber === input.prNumber &&
                job.headSha === input.headSha,
            )
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null,
      ),
    );

  const enqueue: AutoReviewJobStore["Service"]["enqueue"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* findActiveByKey({
        projectId: String(input.projectId),
        prNumber: input.prNumber,
        headSha: input.headSha,
      });

      const allow = shouldEnqueueAutoReviewJob({
        mode: input.trigger === "mention" ? "mention" : "auto",
        existingStatus: existing?.status,
        trigger: input.trigger,
        isNewMentionComment:
          input.trigger === "mention" &&
          Boolean(input.commentId) &&
          existing?.commentId !== input.commentId,
      });

      // For open_or_push, shouldEnqueue already blocks succeeded. For mention
      // re-request with a new comment id, allow a new job even if succeeded.
      if (!allow && existing && input.trigger !== "mention") {
        return { job: existing, created: false };
      }
      if (!allow && existing && input.trigger === "mention" && !input.commentId) {
        return { job: existing, created: false };
      }
      if (
        existing &&
        (existing.status === "queued" || existing.status === "running") &&
        input.trigger !== "mention"
      ) {
        return { job: existing, created: false };
      }
      if (existing?.status === "succeeded" && input.trigger === "open_or_push") {
        return { job: existing, created: false };
      }
      if (
        existing?.status === "succeeded" &&
        input.trigger === "mention" &&
        !(input.commentId && existing.commentId !== input.commentId)
      ) {
        return { job: existing, created: false };
      }

      // Retry cap: a failed chain may be retried up to `maxAttempts` total
      // attempts, then the poller stops re-enqueueing it so a model that keeps
      // failing (e.g. invalid structured output) does not burn tokens every
      // tick. A new mention comment starts a fresh chain.
      const latest = yield* findLatestByKey({
        projectId: String(input.projectId),
        prNumber: input.prNumber,
        headSha: input.headSha,
      });
      const maxAttempts = clampAutoReviewMaxAttempts(input.maxAttempts);
      let attempt = 1;
      if (latest && latest.status === "failed") {
        const isSameMentionChain =
          input.trigger === "mention" &&
          input.commentId != null &&
          latest.commentId === input.commentId;
        const isRetryChain =
          (input.trigger === "open_or_push" && latest.trigger === "open_or_push") ||
          isSameMentionChain;
        if (isRetryChain) {
          const nextAttempt = nextAutoReviewAttempt({ latestJob: latest, maxAttempts });
          if (nextAttempt === null) {
            return { job: latest, created: false };
          }
          attempt = nextAttempt;
        }
      }

      const seq = yield* Ref.updateAndGet(sequenceRef, (n) => n + 1);
      const stamp = yield* nowIso;
      const createdAt = `${stamp}#${String(seq).padStart(8, "0")}`;
      const job: AutoReviewJob = {
        id: `arj_${String(seq).padStart(8, "0")}`,
        projectId: input.projectId as ProjectId,
        prNumber: input.prNumber,
        headSha: input.headSha,
        headBranch: input.headBranch?.trim() ? input.headBranch.trim() : null,
        trigger: input.trigger,
        commentId: input.commentId ?? null,
        status: "queued",
        attempt,
        modelSelection: input.modelSelection,
        fixModelSelection: input.fixModelSelection ?? null,
        findingsCount: null,
        reviewUrl: null,
        githubReviewId: null,
        originThreadId: null,
        fixThreadId: null,
        autoFixEnqueued: false,
        autoFixDispatchedAt: null,
        pendingFix: null,
        decision: null,
        actionableFindings: false,
        error: null,
        skipReason: null,
        createdAt,
        updatedAt: createdAt,
      };

      yield* Ref.update(jobsRef, (jobs) => [...jobs, job]);
      return { job, created: true };
    });

  const claimNextBatch: AutoReviewJobStore["Service"]["claimNextBatch"] = (limit) =>
    Effect.gen(function* () {
      // Stamped before the transition: a timestamp is not part of the
      // invariant, and reading it inside would put an effect in the middle of
      // the read-modify-write.
      const stamp = yield* nowIso;
      return yield* Ref.modify(jobsRef, (jobs) => {
        // Selection and transition share one snapshot, so the "one in-flight
        // review per PR" guarantee cannot be split by a concurrent claimer
        // selecting from state this call is about to overwrite.
        const selected = selectClaimableAutoReviewJobs({ jobs, limit });
        if (selected.length === 0) {
          return [[] as ReadonlyArray<AutoReviewJob>, jobs] as const;
        }
        const claimed = selected.map(
          (job): AutoReviewJob => ({ ...job, status: "running", updatedAt: stamp }),
        );
        const byId = new Map(claimed.map((job) => [job.id, job]));
        return [
          claimed as ReadonlyArray<AutoReviewJob>,
          jobs.map((job) => byId.get(job.id) ?? job),
        ] as const;
      });
    });

  const claimNext: AutoReviewJobStore["Service"]["claimNext"] = () =>
    claimNextBatch(1).pipe(Effect.map((jobs) => jobs[0] ?? null));

  const reserveFixSlot: AutoReviewJobStore["Service"]["reserveFixSlot"] = (input) =>
    // One Ref transition: the decision and the record of it cannot be
    // interleaved by another fiber's reservation.
    Ref.modify(jobsRef, (jobs) => {
      const job = jobs.find((candidate) => candidate.id === input.jobId);
      if (!job) {
        return [false, jobs] as const;
      }
      const threadId = input.threadId;
      const occupied = occupiedAutoReviewFixThreads({
        jobs,
        busyThreadIds: input.busyThreadIds,
        now: input.now,
      });
      // A thread already running a fix cannot take a second one, whatever the
      // budget: it runs one turn at a time.
      if (occupied.has(threadId)) {
        return [false, jobs] as const;
      }
      if (occupied.size >= Math.max(1, Math.trunc(input.limit))) {
        return [false, jobs] as const;
      }
      const reserved: AutoReviewJob = {
        ...job,
        autoFixEnqueued: true,
        autoFixDispatchedAt: input.now,
        fixThreadId:
          job.originThreadId != null && String(job.originThreadId) !== threadId
            ? (threadId as AutoReviewJob["fixThreadId"])
            : job.fixThreadId,
        originThreadId: (job.originThreadId ?? threadId) as AutoReviewJob["originThreadId"],
        pendingFix: null,
        updatedAt: input.now,
      };
      return [
        true,
        jobs.map((candidate) => (candidate.id === job.id ? reserved : candidate)),
      ] as const;
    });

  const releaseFixSlot: AutoReviewJobStore["Service"]["releaseFixSlot"] = (id) =>
    Ref.update(jobsRef, (jobs) =>
      jobs.map((job) =>
        job.id === id ? { ...job, autoFixEnqueued: false, autoFixDispatchedAt: null } : job,
      ),
    ).pipe(Effect.asVoid);

  const update: AutoReviewJobStore["Service"]["update"] = (id, patch) =>
    Effect.gen(function* () {
      const jobs = yield* Ref.get(jobsRef);
      const existing = jobs.find((job) => job.id === id);
      if (!existing) {
        return null;
      }
      const updated: AutoReviewJob = {
        ...existing,
        ...patch,
        updatedAt: yield* nowIso,
      };
      yield* Ref.update(jobsRef, (current) =>
        current.map((job) => (job.id === id ? updated : job)),
      );
      return updated;
    });

  const get: AutoReviewJobStore["Service"]["get"] = (id) =>
    Ref.get(jobsRef).pipe(Effect.map((jobs) => jobs.find((job) => job.id === id) ?? null));

  const list: AutoReviewJobStore["Service"]["list"] = (input = {}) =>
    Ref.get(jobsRef).pipe(
      Effect.map((jobs) => {
        const filtered = input.projectId
          ? jobs.filter((job) => job.projectId === input.projectId)
          : jobs;
        const limit = input.limit ?? 50;
        return filtered
          .slice()
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, limit);
      }),
    );

  const requeueRunning: AutoReviewJobStore["Service"]["requeueRunning"] = () =>
    Effect.gen(function* () {
      const jobs = yield* Ref.get(jobsRef);
      const stamp = yield* nowIso;
      let count = 0;
      const requeued = jobs.map((job) => {
        if (job.status !== "running") {
          return job;
        }
        count += 1;
        return { ...job, status: "queued" as const, updatedAt: stamp };
      });
      yield* Ref.set(jobsRef, requeued);
      return count;
    });

  const getWatermark: AutoReviewJobStore["Service"]["getWatermark"] = (projectId, prNumber) =>
    Ref.get(watermarksRef).pipe(
      Effect.map((map) => map.get(watermarkKey(projectId, prNumber)) ?? null),
    );

  const setWatermark: AutoReviewJobStore["Service"]["setWatermark"] = (input) =>
    Ref.update(watermarksRef, (map) => {
      const next = new Map(map);
      next.set(watermarkKey(input.projectId, input.prNumber), input);
      return next;
    }).pipe(Effect.asVoid);

  return AutoReviewJobStore.of({
    enqueue,
    claimNext,
    claimNextBatch,
    reserveFixSlot,
    releaseFixSlot,
    update,
    get,
    list,
    findActiveByKey,
    requeueRunning,
    getWatermark,
    setWatermark,
  });
});

export const layerInMemory = Layer.effect(AutoReviewJobStore, makeInMemory);
