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
  waitForOperation,
} from "./internal.ts";
import type { EncryptionSpec } from "./shared.ts";

export type ActiveLearningConfig =
  aiplatform.GoogleCloudAiplatformV1ActiveLearningConfig;

export type DataLabelingJobProps = {
  /**
   * Region. Immutable — changing it replaces the job.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-facing display name. Defaults to a generated id. Immutable after
   * create — DataLabelingJob has no update API.
   */
  displayName?: string;
  /**
   * Dataset resource names to label. Currently a single dataset.
   * Format `projects/{project}/locations/{location}/datasets/{dataset}`.
   */
  datasets: string[];
  /**
   * Number of labelers per DataItem.
   */
  labelerCount: number;
  /**
   * GCS URI of the instruction PDF shared with labelers.
   */
  instructionUri: string;
  /**
   * GCS URI of the YAML schema describing the job config. Schema files
   * live under
   * `https://storage.googleapis.com/google-cloud-aiplatform/schema/datalabelingjob/inputs/`.
   */
  inputsSchemaUri: string;
  /**
   * Input config parameters for the job (schema-specific).
   */
  inputs: unknown;
  /**
   * Specialist pool resource names associated with this job.
   */
  specialistPools?: string[];
  /**
   * Labels applied to annotations created by this job.
   */
  annotationLabels?: Record<string, string>;
  /**
   * Active learning pipeline configuration.
   */
  activeLearningConfig?: ActiveLearningConfig;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Customer-managed encryption.
   */
  encryptionSpec?: EncryptionSpec;
};

export type DataLabelingJob = Resource<
  "GCP.AIPlatform.DataLabelingJob",
  DataLabelingJobProps,
  {
    /** Full resource name `.../dataLabelingJobs/{job}`. */
    name: string;
    /** Job id (last path segment). */
    dataLabelingJobId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Dataset resource names. */
    datasets: string[];
    /** Labelers per DataItem. */
    labelerCount: number | undefined;
    /** Instruction PDF URI. */
    instructionUri: string | undefined;
    /** Inputs schema URI. */
    inputsSchemaUri: string | undefined;
    /** Detailed job state. */
    state: string | undefined;
    /** Labeling progress in `[0, 100]`. */
    labelingProgress: number | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Customer-managed KMS key, if any. */
    kmsKeyName: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Failure/cancel status, if any. */
    error: { code?: number; message?: string } | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI DataLabelingJob — human labeling of Dataset DataItems.
 *
 * Creating a job starts labeling immediately. There is no update API, so
 * reconcile is observe-ensure. Delete cancels a running job, then deletes
 * it. Alchemy ownership labels are merged into `labels` so `list` / nuke
 * can find the job.
 *
 * ### Creating a Data Labeling Job
 * **Example:** Single-label image classification
 * ```typescript
 * const job = yield* GCP.AIPlatform.DataLabelingJob("Label", {
 *   datasets: [dataset.name],
 *   displayName: "label-images",
 *   labelerCount: 1,
 *   instructionUri: "gs://bucket/instructions.pdf",
 *   inputsSchemaUri:
 *     "gs://google-cloud-aiplatform/schema/datalabelingjob/inputs/image_classification_1.0.0.yaml",
 *   inputs: { annotationSpecs: ["cat", "dog"] },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const DataLabelingJob = Resource<DataLabelingJob>(
  "GCP.AIPlatform.DataLabelingJob",
);

export class DataLabelingJobNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.DataLabelingJobNotResolved",
)<{
  name: string;
}> {}

const toId = (id: string, existing?: string) =>
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
  job: aiplatform.GoogleCloudAiplatformV1DataLabelingJob,
  project: string,
) => {
  const name = job.name ?? "";
  const parsed = parseResourceName(name, "dataLabelingJobs");
  return {
    name,
    dataLabelingJobId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: job.displayName,
    datasets: job.datasets ?? [],
    labelerCount: job.labelerCount,
    instructionUri: job.instructionUri,
    inputsSchemaUri: job.inputsSchemaUri,
    state: job.state,
    labelingProgress: job.labelingProgress,
    labels: userLabels(job.labels),
    kmsKeyName: job.encryptionSpec?.kmsKeyName,
    createTime: job.createTime,
    updateTime: job.updateTime,
    error: job.error
      ? { code: job.error.code, message: job.error.message }
      : undefined,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsDataLabelingJobs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listJobs = (project: string, region: string) => {
  const collect = (parent: string) =>
    aiplatform.listProjectsLocationsDataLabelingJobs
      .pages({ parent, pageSize: 100 })
      .pipe(
        Stream.flatMap((page) =>
          Stream.fromIterable(page.dataLabelingJobs ?? []),
        ),
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
    return undefined as
      | aiplatform.GoogleCloudAiplatformV1DataLabelingJob
      | undefined;
  });

const cancelAndDelete = (name: string) =>
  Effect.gen(function* () {
    const existing = yield* getByName(name);
    if (existing === undefined) return;
    if (!isJobTerminal(existing.state)) {
      yield* aiplatform
        .cancelProjectsLocationsDataLabelingJobs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* getByName(name).pipe(
        Effect.filterOrFail(
          (job) => job === undefined || isJobTerminal(job.state),
          () => new DataLabelingJobNotResolved({ name }),
        ),
        Effect.retry({
          while: (error) =>
            error._tag === "GCP.AIPlatform.DataLabelingJobNotResolved",
          times: 8,
          schedule: Schedule.spaced("4 seconds"),
        }),
        Effect.catchTag(
          "GCP.AIPlatform.DataLabelingJobNotResolved",
          () => Effect.void,
        ),
      );
    }
    const operation = yield* aiplatform
      .deleteProjectsLocationsDataLabelingJobs({ name })
      .pipe(
        Effect.retry({
          while: (error) => error._tag === "Conflict",
          times: 8,
          schedule: Schedule.spaced("3 seconds"),
        }),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
      );
    if (operation !== undefined) {
      yield* waitForOperation(operation, { notFoundOk: true });
    }
  });

export const DataLabelingJobProvider = () =>
  Provider.succeed(DataLabelingJob, {
    stables: ["name", "dataLabelingJobId", "project", "location", "createTime"],

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
      const displayName =
        news.displayName ?? (yield* toId(id, output?.dataLabelingJobId));
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* findOwned(id, env.project, env.region, output?.name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsDataLabelingJobs({
            parent: parentOf(env.project, location),
            body: {
              displayName,
              datasets: news.datasets,
              labelerCount: news.labelerCount,
              instructionUri: news.instructionUri,
              inputsSchemaUri: news.inputsSchemaUri,
              inputs: news.inputs,
              specialistPools: news.specialistPools,
              annotationLabels: news.annotationLabels,
              activeLearningConfig: news.activeLearningConfig,
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
        return yield* new DataLabelingJobNotResolved({
          name: output?.name ?? parentOf(env.project, location),
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cancelAndDelete(output.name);
    }),
  });
