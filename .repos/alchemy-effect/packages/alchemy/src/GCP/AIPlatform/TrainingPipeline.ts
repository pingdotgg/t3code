import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  compact,
  normalizeLocation,
  parentOf,
  parseName,
  toPhysicalId,
  listLocations,
} from "./names.ts";
import { waitForOperation } from "./operations.ts";

export type TrainingPipelineEncryptionSpec =
  aiplatform.GoogleCloudAiplatformV1EncryptionSpec;
export type TrainingPipelineInputDataConfig =
  aiplatform.GoogleCloudAiplatformV1InputDataConfig;
export type TrainingPipelineModel = aiplatform.GoogleCloudAiplatformV1Model;

export type TrainingPipelineProps = {
  /**
   * Training pipeline id (the `{training_pipeline}` segment of
   * `projects/{project}/locations/{location}/trainingPipelines/{training_pipeline}`).
   * Vertex assigns this on create. Pass the value from a previous deploy
   * to target the same pipeline. Immutable — changing it replaces the
   * pipeline.
   */
  trainingPipelineId?: string;
  /**
   * Vertex AI location (`us-central1`, `us-east1`, …). Immutable —
   * changing it replaces the pipeline. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-defined display name. Required by Vertex. If omitted, a unique
   * name is generated from the stack, stage, and logical id.
   */
  displayName?: string;
  /**
   * Cloud Storage URI of the training-task YAML
   * (`gs://google-cloud-aiplatform/schema/trainingjob/definition/…`).
   * Immutable — changing it replaces the pipeline.
   */
  trainingTaskDefinition: string;
  /**
   * Training-task inputs as specified by `trainingTaskDefinition`.
   * Immutable — changing it replaces the pipeline.
   */
  trainingTaskInputs?: unknown;
  /**
   * Vertex Dataset split and export configuration used by the training
   * task.
   */
  inputDataConfig?: TrainingPipelineInputDataConfig;
  /**
   * Model uploaded when the pipeline succeeds.
   */
  modelToUpload?: TrainingPipelineModel;
  /**
   * Existing model to version instead of uploading a new model.
   */
  parentModel?: string;
  /**
   * Id of the uploaded model (last path segment). Letters, digits,
   * underscores, and hyphens; cannot start with a digit or hyphen.
   */
  modelId?: string;
  /**
   * Customer-managed encryption key for the pipeline (and the uploaded
   * model when `modelToUpload` is omitted).
   */
  encryptionSpec?: TrainingPipelineEncryptionSpec;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type TrainingPipeline = Resource<
  "GCP.AIPlatform.TrainingPipeline",
  TrainingPipelineProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/trainingPipelines/{training_pipeline}`. */
    name: string;
    /** Training pipeline id (last path segment). */
    trainingPipelineId: string;
    /** Location id (`us-central1`, …). */
    location: string;
    /** Project id. */
    project: string;
    /** User-defined display name. */
    displayName: string | undefined;
    /** Training-task YAML URI. */
    trainingTaskDefinition: string | undefined;
    /** Training-task inputs. */
    trainingTaskInputs: unknown;
    /** Training-task metadata populated while the pipeline runs. */
    trainingTaskMetadata: unknown;
    /** Dataset split and export configuration. */
    inputDataConfig: TrainingPipelineInputDataConfig | undefined;
    /** Model uploaded by the pipeline, if any. */
    modelToUpload: TrainingPipelineModel | undefined;
    /** Parent model versioned by this pipeline. */
    parentModel: string | undefined;
    /** Uploaded model id. */
    modelId: string | undefined;
    /** CMEK spec. */
    encryptionSpec: TrainingPipelineEncryptionSpec | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Pipeline state (`PIPELINE_STATE_RUNNING`, …). */
    state: string | undefined;
    /** Error when the pipeline failed or was cancelled. */
    error: aiplatform.GoogleRpcStatus | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 start timestamp. */
    startTime: string | undefined;
    /** RFC3339 end timestamp. */
    endTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI TrainingPipeline that runs a training task and optionally
 * uploads a Model.
 *
 * Creating a TrainingPipeline starts it immediately. Vertex assigns the
 * resource id; there is no update RPC — changing `location` or
 * `trainingTaskDefinition` replaces the pipeline. Labels brand the
 * resource for `list` / nuke.
 *
 * ### Creating a TrainingPipeline
 * **Example:** Custom training task
 * ```typescript
 * const pipeline = yield* GCP.AIPlatform.TrainingPipeline("Train", {
 *   location: "us-central1",
 *   displayName: "custom-train",
 *   trainingTaskDefinition:
 *     "gs://google-cloud-aiplatform/schema/trainingjob/definition/custom_task_1.0.0.yaml",
 *   trainingTaskInputs: {
 *     workerPoolSpecs: [
 *       {
 *         machineSpec: { machineType: "n1-standard-4" },
 *         replicaCount: "1",
 *         containerSpec: { imageUri: "gcr.io/my-project/trainer:latest" },
 *       },
 *     ],
 *   },
 *   labels: { env: "dev" },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const TrainingPipeline = Resource<TrainingPipeline>(
  "GCP.AIPlatform.TrainingPipeline",
);

export class TrainingPipelineNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.TrainingPipelineNotResolved",
)<{
  name: string;
}> {}

export class TrainingPipelineStillExists extends Data.TaggedError(
  "GCP.AIPlatform.TrainingPipelineStillExists",
)<{
  name: string;
}> {}

const resourceName = (
  project: string,
  location: string,
  trainingPipelineId: string,
) =>
  `projects/${project}/locations/${location}/trainingPipelines/${trainingPipelineId}`;

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toAttrs = (
  pipeline: aiplatform.GoogleCloudAiplatformV1TrainingPipeline,
  project: string,
) => {
  const name = pipeline.name ?? "";
  const parsed = parseName(name, "trainingPipelines");
  return {
    name,
    trainingPipelineId: parsed.resourceId,
    location: parsed.location,
    project: parsed.project || project,
    displayName: pipeline.displayName,
    trainingTaskDefinition: pipeline.trainingTaskDefinition,
    trainingTaskInputs: pipeline.trainingTaskInputs,
    trainingTaskMetadata: pipeline.trainingTaskMetadata,
    inputDataConfig: pipeline.inputDataConfig,
    modelToUpload: pipeline.modelToUpload,
    parentModel: pipeline.parentModel,
    modelId: pipeline.modelId,
    encryptionSpec: pipeline.encryptionSpec,
    labels: userLabels(pipeline.labels),
    state: pipeline.state,
    error: pipeline.error,
    createTime: pipeline.createTime,
    startTime: pipeline.startTime,
    endTime: pipeline.endTime,
    updateTime: pipeline.updateTime,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsTrainingPipelines({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string) =>
  aiplatform.listProjectsLocationsTrainingPipelines
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.trainingPipelines ?? []),
      ),
      Stream.take(500),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findOwned = (id: string, parent: string) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const pipelines = yield* listAt(parent);
    return pipelines.find((pipeline) =>
      Object.entries(expected).every(
        ([key, value]) => (pipeline.labels ?? {})[key] === value,
      ),
    );
  });

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((pipeline) =>
      pipeline === undefined
        ? Effect.void
        : Effect.fail(new TrainingPipelineStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.TrainingPipelineStillExists",
      times: 30,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const toBody = (
  news: TrainingPipelineProps,
  displayName: string,
  labels: Record<string, string>,
): aiplatform.GoogleCloudAiplatformV1TrainingPipeline =>
  compact({
    displayName,
    trainingTaskDefinition: news.trainingTaskDefinition,
    trainingTaskInputs: news.trainingTaskInputs,
    inputDataConfig: news.inputDataConfig,
    modelToUpload: news.modelToUpload,
    parentModel: news.parentModel,
    modelId: news.modelId,
    encryptionSpec: news.encryptionSpec,
    labels,
  });

export const TrainingPipelineProvider = () =>
  Provider.succeed(TrainingPipeline, {
    stables: [
      "name",
      "trainingPipelineId",
      "location",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousId = olds?.trainingPipelineId ?? output?.trainingPipelineId;
      const nextId = news.trainingPipelineId ?? previousId;
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const definitionChanged =
        (olds?.trainingTaskDefinition ?? output?.trainingTaskDefinition) !==
          undefined &&
        news.trainingTaskDefinition !==
          (olds?.trainingTaskDefinition ?? output?.trainingTaskDefinition);
      if (idChanged || previousLocation !== nextLocation || definitionChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      // Pipeline ids are server-assigned numbers, so only a recorded name
      // or a caller-supplied id can be fetched directly.
      const trainingPipelineId =
        olds?.trainingPipelineId ?? output?.trainingPipelineId;
      const name =
        output?.name ??
        (trainingPipelineId !== undefined
          ? resourceName(env.project, location, trainingPipelineId)
          : undefined);
      const existing =
        (name !== undefined ? yield* getByName(name) : undefined) ??
        (yield* findOwned(id, parentOf(env.project, location)));
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pipelines = (yield* Effect.forEach(
          listLocations(env.region),
          (location) => listAt(parentOf(env.project, location)),
        )).flat();
        return pipelines
          .filter((pipeline) =>
            Object.keys(pipeline.labels ?? {}).some((key) =>
              key.startsWith("alchemy-"),
            ),
          )
          .map((pipeline) => toAttrs(pipeline, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const parent = parentOf(env.project, location);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const displayName =
        news.displayName ??
        (yield* toPhysicalId(
          id,
          news.trainingPipelineId,
          output?.trainingPipelineId,
        ));

      let current =
        (output?.name !== undefined
          ? yield* getByName(output.name)
          : undefined) ?? (yield* findOwned(id, parent));

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsTrainingPipelines({
            parent,
            body: toBody(news, displayName, desiredLabels),
          })
          .pipe(Effect.catchTag("Conflict", () => findOwned(id, parent)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new TrainingPipelineNotResolved({
          name: output?.name ?? parent,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name;
      // Custom training runs in a backing CustomJob that outlives the
      // pipeline; remember it so it can be deleted too.
      const metadata = (yield* getByName(name))?.trainingTaskMetadata;
      const backingJob =
        metadata !== null &&
        typeof metadata === "object" &&
        "backingCustomJob" in metadata
          ? (metadata as { backingCustomJob?: unknown }).backingCustomJob
          : undefined;
      yield* aiplatform
        .cancelProjectsLocationsTrainingPipelines({ name, body: {} })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.catchTag("BadRequest", () => Effect.void),
          Effect.catchTag("Conflict", () => Effect.void),
        );
      // Delete is rejected until the cancellation reaches a terminal state,
      // which can take a couple of minutes.
      const operation = yield* aiplatform
        .deleteProjectsLocationsTrainingPipelines({ name })
        .pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "Conflict" || error._tag === "BadRequest",
            times: 24,
            schedule: Schedule.spaced("10 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(name);
      if (typeof backingJob === "string" && backingJob.length > 0) {
        const jobDelete = yield* aiplatform
          .deleteProjectsLocationsCustomJobs({ name: backingJob })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "BadRequest",
              times: 8,
              schedule: Schedule.spaced("3 seconds"),
            }),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
        if (jobDelete !== undefined) {
          yield* waitForOperation(jobDelete, { notFoundOk: true });
        }
      }
    }),
  });
