import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { listLocations } from "./names.ts";
import {
  hasAlchemyLabelKeys,
  isJobTerminal,
  normalizeLocation,
  parentOf,
  parseResourceName,
  rfc1035,
  userLabels,
} from "./internal.ts";

export type TuningJobProps = {
  /**
   * Vertex AI location. Immutable — changing it replaces the job.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Description of the tuning job.
   */
  description?: string;
  /**
   * Display name of the tuned model (max 128 Unicode characters).
   */
  tunedModelDisplayName?: string;
  /**
   * Base model being tuned (for example `gemini-2.0-flash-001`).
   */
  baseModel?: string;
  /**
   * Supervised fine-tuning spec. Required unless `preferenceOptimizationSpec`
   * or `preTunedModel` is set.
   */
  supervisedTuningSpec?: aiplatform.GoogleCloudAiplatformV1SupervisedTuningSpec;
  /**
   * Preference-optimization spec.
   */
  preferenceOptimizationSpec?: aiplatform.GoogleCloudAiplatformV1PreferenceOptimizationSpec;
  /**
   * Pre-tuned model for continuous tuning.
   */
  preTunedModel?: aiplatform.GoogleCloudAiplatformV1PreTunedModel;
  /**
   * Runtime service account email.
   */
  serviceAccount?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Customer-managed encryption key. Immutable.
   */
  encryptionSpec?: aiplatform.GoogleCloudAiplatformV1EncryptionSpec;
};

export type TuningJob = Resource<
  "GCP.AIPlatform.TuningJob",
  TuningJobProps,
  {
    /** Full resource name. */
    name: string;
    /** Job id (last path segment). */
    tuningJobId: string;
    /** Project id. */
    project: string;
    /** Location. */
    location: string;
    /** Description. */
    description: string | undefined;
    /** Tuned-model display name. */
    tunedModelDisplayName: string | undefined;
    /** Base model. */
    baseModel: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Job state. */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 start timestamp. */
    startTime: string | undefined;
    /** RFC3339 end timestamp. */
    endTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Failure/cancel status, if any. */
    error: { code?: number; message?: string } | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI TuningJob (supervised fine-tune / preference optimization).
 *
 * Creating a TuningJob starts it immediately. There is no update API, so
 * reconcile is observe-ensure (create if missing). There is no delete RPC —
 * destroy cancels the job. Alchemy ownership labels are merged into `labels`
 * so `list` / nuke can find it.
 *
 * ### Creating a Tuning Job
 * **Example:** Supervised fine-tune
 * ```typescript
 * const job = yield* GCP.AIPlatform.TuningJob("Tune", {
 *   baseModel: "gemini-2.0-flash-001",
 *   supervisedTuningSpec: {
 *     trainingDatasetUri: "gs://bucket/train.jsonl",
 *   },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const TuningJob = Resource<TuningJob>("GCP.AIPlatform.TuningJob");

export class TuningJobNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.TuningJobNotResolved",
)<{
  name: string;
}> {}

const toDisplayName = (id: string, existing?: string) =>
  Effect.gen(function* () {
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: 63,
        lowercase: true,
      }),
    );
  });

const toAttrs = (
  job: aiplatform.GoogleCloudAiplatformV1TuningJob,
  project: string,
) => {
  const name = job.name ?? "";
  const parsed = parseResourceName(name, "tuningJobs");
  return {
    name,
    tuningJobId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    description: job.description,
    tunedModelDisplayName: job.tunedModelDisplayName,
    baseModel: job.baseModel,
    labels: userLabels(job.labels),
    state: typeof job.state === "string" ? job.state : undefined,
    createTime: job.createTime,
    startTime: job.startTime,
    endTime: job.endTime,
    updateTime: job.updateTime,
    error: job.error
      ? { code: job.error.code, message: job.error.message }
      : undefined,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsTuningJobs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listJobs = (project: string, region: string) => {
  const collect = (parent: string) =>
    aiplatform.listProjectsLocationsTuningJobs
      .pages({ parent, pageSize: 100 })
      .pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.tuningJobs ?? [])),
        Stream.filter((job) => hasAlchemyLabelKeys(job.labels)),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      );
  const fallback = Effect.forEach(listLocations(region), (location) =>
    collect(`projects/${project}/locations/${location}`),
  ).pipe(Effect.map((pages) => pages.flat()));
  // Vertex AI has no `locations/-` wildcard; scan known locations.
  return fallback.pipe(Effect.catchTag("NotFound", () => Effect.succeed([])));
};

const findOwned = (
  id: string,
  project: string,
  region: string,
  hinted?: string,
) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const jobs = yield* listJobs(project, region);
    for (const job of jobs) {
      if (yield* hasAlchemyLabels(id, tagRecord(job.labels))) return job;
    }
    return undefined as aiplatform.GoogleCloudAiplatformV1TuningJob | undefined;
  });

const cancelJob = (name: string) =>
  Effect.gen(function* () {
    const existing = yield* getByName(name);
    if (existing === undefined) return;
    if (
      !isJobTerminal(
        typeof existing.state === "string" ? existing.state : undefined,
      )
    ) {
      yield* aiplatform
        .cancelProjectsLocationsTuningJobs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* getByName(name).pipe(
        Effect.filterOrFail(
          (job) =>
            job === undefined ||
            isJobTerminal(
              typeof job.state === "string" ? job.state : undefined,
            ),
          () => new TuningJobNotResolved({ name }),
        ),
        Effect.retry({
          while: (error) =>
            error._tag === "GCP.AIPlatform.TuningJobNotResolved",
          times: 8,
          schedule: Schedule.spaced("4 seconds"),
        }),
        Effect.catchTag(
          "GCP.AIPlatform.TuningJobNotResolved",
          () => Effect.void,
        ),
      );
    }
  });

export const TuningJobProvider = () =>
  Provider.succeed(TuningJob, {
    stables: ["name", "tuningJobId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      if (previousLocation !== nextLocation) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* findOwned(
        id,
        env.project,
        env.region,
        output?.name,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const jobs = yield* listJobs(env.project, env.region);
        return jobs.map((job) => toAttrs(job, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const tunedModelDisplayName =
        news.tunedModelDisplayName ??
        (yield* toDisplayName(id, output?.tuningJobId));
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* findOwned(id, env.project, env.region, output?.name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsTuningJobs({
            parent: parentOf(env.project, location),
            body: {
              description: news.description,
              tunedModelDisplayName,
              baseModel: news.baseModel,
              supervisedTuningSpec: news.supervisedTuningSpec,
              preferenceOptimizationSpec: news.preferenceOptimizationSpec,
              preTunedModel: news.preTunedModel,
              serviceAccount: news.serviceAccount,
              labels: desiredLabels,
              encryptionSpec: news.encryptionSpec,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(id, env.project, env.region),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new TuningJobNotResolved({
          name: output?.name ?? parentOf(env.project, location),
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cancelJob(output.name);
    }),
  });
