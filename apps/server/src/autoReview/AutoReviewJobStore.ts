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
import { shouldEnqueueAutoReviewJob } from "@t3tools/shared/autoReview";

export interface EnqueueAutoReviewJobInput {
  readonly projectId: ProjectId | string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly trigger: AutoReviewTrigger;
  readonly commentId?: string | null;
  readonly modelSelection: ModelSelection;
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
          | "autoFixEnqueued"
          | "error"
          | "skipReason"
        >
      >,
    ) => Effect.Effect<AutoReviewJob | null>;
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
      if (
        existing?.status === "succeeded" &&
        input.trigger === "open_or_push"
      ) {
        return { job: existing, created: false };
      }
      if (
        existing?.status === "succeeded" &&
        input.trigger === "mention" &&
        !(input.commentId && existing.commentId !== input.commentId)
      ) {
        return { job: existing, created: false };
      }

      const seq = yield* Ref.updateAndGet(sequenceRef, (n) => n + 1);
      const stamp = yield* nowIso;
      const createdAt = `${stamp}#${String(seq).padStart(8, "0")}`;
      const job: AutoReviewJob = {
        id: `arj_${String(seq).padStart(8, "0")}`,
        projectId: input.projectId as ProjectId,
        prNumber: input.prNumber,
        headSha: input.headSha,
        trigger: input.trigger,
        commentId: input.commentId ?? null,
        status: "queued",
        modelSelection: input.modelSelection,
        findingsCount: null,
        reviewUrl: null,
        githubReviewId: null,
        originThreadId: null,
        autoFixEnqueued: false,
        error: null,
        skipReason: null,
        createdAt,
        updatedAt: createdAt,
      };

      yield* Ref.update(jobsRef, (jobs) => [...jobs, job]);
      return { job, created: true };
    });

  const claimNext: AutoReviewJobStore["Service"]["claimNext"] = () =>
    Effect.gen(function* () {
      const jobs = yield* Ref.get(jobsRef);
      const next = jobs.find((job) => job.status === "queued");
      if (!next) {
        return null;
      }
      const updated: AutoReviewJob = {
        ...next,
        status: "running",
        updatedAt: yield* nowIso,
      };
      yield* Ref.update(jobsRef, (current) =>
        current.map((job) => (job.id === next.id ? updated : job)),
      );
      return updated;
    });

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
