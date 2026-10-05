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

export type GcsSource = {
  /** GCS URIs of input files. Wildcards allowed. */
  uris?: string[];
};

export type GcsDestination = {
  /** GCS URI prefix of the output directory. */
  outputUriPrefix?: string;
};

export type BigQuerySource = {
  /** BigQuery table URI, for example `bq://project.dataset.table`. */
  inputUri?: string;
};

export type BigQueryDestination = {
  /** BigQuery project, dataset, or table URI (`bq://...`). */
  outputUri?: string;
};

export type BatchPredictionInputConfig = {
  /** Instance format; must be one of the Model's supported input formats. */
  instancesFormat?: string;
  /** GCS input. */
  gcsSource?: GcsSource;
  /** BigQuery input. */
  bigquerySource?: BigQuerySource;
  /** Vertex multimodal dataset input. */
  vertexMultimodalDatasetSource?: { datasetName?: string };
};

export type BatchPredictionOutputConfig = {
  /** Predictions format; must be one of the Model's supported output formats. */
  predictionsFormat?: string;
  /** GCS output directory. */
  gcsDestination?: GcsDestination;
  /** BigQuery output. */
  bigqueryDestination?: BigQueryDestination;
};

export type BatchDedicatedResources = {
  /** Max machine replicas. Defaults to 10. */
  maxReplicaCount?: number;
  /** Starting replica count. */
  startingReplicaCount?: number;
  /** Single-machine spec. */
  machineSpec?: {
    machineType?: string;
    acceleratorType?: string;
    acceleratorCount?: number;
  };
};

export type BatchPredictionJobProps = {
  /**
   * Region. Immutable — changing it replaces the job.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-facing display name. Defaults to a generated id. Immutable after
   * create — BatchPredictionJob has no update API.
   */
  displayName?: string;
  /**
   * Model resource that produces predictions
   * (`projects/{project}/locations/{location}/models/{model}` or a
   * publisher model). Exactly one of `model` or `endpoint` should be set.
   */
  model?: string;
  /**
   * Input instances. Required.
   */
  inputConfig: BatchPredictionInputConfig;
  /**
   * Output predictions location. Required.
   */
  outputConfig: BatchPredictionOutputConfig;
  /**
   * Dedicated machine resources for the prediction workers.
   */
  dedicatedResources?: BatchDedicatedResources;
  /**
   * Model parameters forwarded to the predictor.
   */
  modelParameters?: unknown;
  /**
   * Generate explanations with the predictions.
   */
  generateExplanation?: boolean;
  /**
   * Disable container logging.
   */
  disableContainerLogging?: boolean;
  /**
   * Runtime service account email.
   */
  serviceAccount?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Customer-managed encryption.
   */
  encryptionSpec?: EncryptionSpec;
};

export type BatchPredictionJob = Resource<
  "GCP.AIPlatform.BatchPredictionJob",
  BatchPredictionJobProps,
  {
    /** Full resource name `.../batchPredictionJobs/{job}`. */
    name: string;
    /** Job id (last path segment). */
    batchPredictionJobId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Model resource name. */
    model: string | undefined;
    /** Model version id. */
    modelVersionId: string | undefined;
    /** Detailed job state. */
    state: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** GCS output directory, if any. */
    gcsOutputDirectory: string | undefined;
    /** BigQuery output dataset, if any. */
    bigqueryOutputDataset: string | undefined;
    /** Customer-managed KMS key, if any. */
    kmsKeyName: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 start timestamp. */
    startTime: string | undefined;
    /** RFC3339 end timestamp. */
    endTime: string | undefined;
    /** Failure/cancel status, if any. */
    error: { code?: number; message?: string } | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI BatchPredictionJob — offline predictions over many
 * instances.
 *
 * Creating a job starts it immediately. There is no update API, so
 * reconcile is observe-ensure. Delete can only run after the job
 * finishes; Alchemy cancels first. Alchemy ownership labels are merged
 * into `labels` so `list` / nuke can find the job.
 *
 * ### Creating a Batch Prediction Job
 * **Example:** JSONL in, JSONL out
 * ```typescript
 * const job = yield* GCP.AIPlatform.BatchPredictionJob("Nightly", {
 *   displayName: "nightly-scores",
 *   model: "projects/my-project/locations/us-central1/models/my-model",
 *   inputConfig: {
 *     instancesFormat: "jsonl",
 *     gcsSource: { uris: ["gs://bucket/input.jsonl"] },
 *   },
 *   outputConfig: {
 *     predictionsFormat: "jsonl",
 *     gcsDestination: { outputUriPrefix: "gs://bucket/out/" },
 *   },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const BatchPredictionJob = Resource<BatchPredictionJob>(
  "GCP.AIPlatform.BatchPredictionJob",
);

export class BatchPredictionJobNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.BatchPredictionJobNotResolved",
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
  job: aiplatform.GoogleCloudAiplatformV1BatchPredictionJob,
  project: string,
) => {
  const name = job.name ?? "";
  const parsed = parseResourceName(name, "batchPredictionJobs");
  return {
    name,
    batchPredictionJobId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: job.displayName,
    model: job.model,
    modelVersionId: job.modelVersionId,
    state: job.state,
    labels: userLabels(job.labels),
    gcsOutputDirectory: job.outputInfo?.gcsOutputDirectory,
    bigqueryOutputDataset: job.outputInfo?.bigqueryOutputDataset,
    kmsKeyName: job.encryptionSpec?.kmsKeyName,
    createTime: job.createTime,
    startTime: job.startTime,
    endTime: job.endTime,
    error: job.error
      ? { code: job.error.code, message: job.error.message }
      : undefined,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsBatchPredictionJobs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listJobs = (project: string, region: string) => {
  const collect = (parent: string) =>
    aiplatform.listProjectsLocationsBatchPredictionJobs
      .pages({ parent, pageSize: 100 })
      .pipe(
        Stream.flatMap((page) =>
          Stream.fromIterable(page.batchPredictionJobs ?? []),
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
      | aiplatform.GoogleCloudAiplatformV1BatchPredictionJob
      | undefined;
  });

const cancelAndDelete = (name: string) =>
  Effect.gen(function* () {
    const existing = yield* getByName(name);
    if (existing === undefined) return;
    if (!isJobTerminal(existing.state)) {
      yield* aiplatform
        .cancelProjectsLocationsBatchPredictionJobs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* getByName(name).pipe(
        Effect.filterOrFail(
          (job) => job === undefined || isJobTerminal(job.state),
          () => new BatchPredictionJobNotResolved({ name }),
        ),
        Effect.retry({
          while: (error) =>
            error._tag === "GCP.AIPlatform.BatchPredictionJobNotResolved",
          times: 8,
          schedule: Schedule.spaced("4 seconds"),
        }),
        Effect.catchTag(
          "GCP.AIPlatform.BatchPredictionJobNotResolved",
          () => Effect.void,
        ),
      );
    }
    const operation = yield* aiplatform
      .deleteProjectsLocationsBatchPredictionJobs({ name })
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

export const BatchPredictionJobProvider = () =>
  Provider.succeed(BatchPredictionJob, {
    stables: [
      "name",
      "batchPredictionJobId",
      "project",
      "location",
      "createTime",
    ],

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
        news.displayName ?? (yield* toId(id, output?.batchPredictionJobId));
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* findOwned(id, env.project, env.region, output?.name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsBatchPredictionJobs({
            parent: parentOf(env.project, location),
            body: {
              displayName,
              model: news.model,
              inputConfig: news.inputConfig,
              outputConfig: news.outputConfig,
              dedicatedResources: news.dedicatedResources,
              modelParameters: news.modelParameters,
              generateExplanation: news.generateExplanation,
              disableContainerLogging: news.disableContainerLogging,
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
        return yield* new BatchPredictionJobNotResolved({
          name: output?.name ?? parentOf(env.project, location),
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cancelAndDelete(output.name);
    }),
  });
