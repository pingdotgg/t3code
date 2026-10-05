import * as datalabeling from "@distilled.cloud/gcp/datalabeling_v1beta1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  findOwned,
  hasOwnershipMarker,
  ignoreGone,
  listEvaluationJobs,
  MAX_EVALUATION_DESCRIPTION_LENGTH,
  noRetryLayer,
  ownedByAlchemy,
  parseOwnership,
  parseResourceName,
  projectParent,
  replaceOnIdentity,
  retryDelete,
  retryTransient,
  sameJson,
  sameText,
  updateMaskOf,
  waitUntilGone,
} from "./internal.ts";

export type EvaluationJobConfig =
  datalabeling.GoogleCloudDatalabelingV1beta1EvaluationJobConfig;

export type EvaluationJobProps = {
  /**
   * Evaluation job id (the last segment of
   * `projects/{project}/evaluationJobs/{evaluation_job}`).
   * Server-assigned on create. Immutable — changing it replaces the
   * job.
   */
  evaluationJobId?: string;
  /**
   * Description of the job. Maximum 25,000 characters. Evaluation jobs
   * have no labels field, so Alchemy stamps ownership into this field.
   * Immutable — changing it replaces the job.
   */
  description?: string;
  /**
   * Annotation spec set resource name describing the labels the model
   * outputs. Immutable — changing it replaces the job.
   */
  annotationSpecSet: string;
  /**
   * AI Platform Prediction model version sampled for evaluation, as
   * `projects/{project}/models/{model}/versions/{version}`. Immutable —
   * changing it replaces the job.
   */
  modelVersion: string;
  /**
   * Run interval, in crontab or English-like format. Must be at least
   * one day. Immutable — changing it replaces the job.
   */
  schedule: string;
  /**
   * When true, Data Labeling assigns human labelers for missing ground
   * truth. When false, ground truth is read from the job's BigQuery
   * table.
   * @default false
   */
  labelMissingGroundTruth?: boolean;
  /**
   * Configuration for sampling, import keys, human annotation, and
   * metrics. Only `humanAnnotationConfig.instruction`, `exampleCount`,
   * and `exampleSamplePercentage` update in place; any other change
   * replaces the job.
   */
  evaluationJobConfig: EvaluationJobConfig;
  /**
   * When true, pause the job after ensure. Pausing a paused job is a
   * no-op; resuming a running or scheduled job is a no-op.
   * @default false
   */
  paused?: boolean;
};

export type EvaluationJob = Resource<
  "GCP.DataLabeling.EvaluationJob",
  EvaluationJobProps,
  {
    /** Full resource name `projects/{project}/evaluationJobs/{job}`. */
    name: string;
    /** Evaluation job id (last path segment). */
    evaluationJobId: string;
    /** Project id. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Annotation spec set resource name. */
    annotationSpecSet: string | undefined;
    /** Model version sampled for evaluation. */
    modelVersion: string | undefined;
    /** Run interval. */
    schedule: string | undefined;
    /** Whether the service provides ground-truth labels. */
    labelMissingGroundTruth: boolean;
    /** Job configuration. */
    evaluationJobConfig: EvaluationJobConfig | undefined;
    /** Server-reported job state. */
    state: string | undefined;
    /** Whether the job is paused. */
    paused: boolean;
    /** Failed attempts, if any. */
    attempts:
      | datalabeling.GoogleCloudDatalabelingV1beta1AttemptList
      | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Data Labeling evaluation job that periodically samples predictions
 * from an AI Platform model version and scores them.
 *
 * Patch can only update `evaluationJobConfig.humanAnnotationConfig.instruction`,
 * `evaluationJobConfig.exampleCount`, and
 * `evaluationJobConfig.exampleSamplePercentage`. Pause and resume are
 * separate RPCs. Every other field is identity — changing it replaces
 * the job. There is no labels API, so Alchemy stamps ownership into
 * `description`.
 *
 * ### Creating an Evaluation Job
 * **Example:** Daily image classification eval
 * ```typescript
 * const evaluationJobConfig = {
 *   exampleCount: 100,
 *   exampleSamplePercentage: 0.1,
 *   evaluationConfig: {},
 *   inputConfig: {
 *     dataType: "IMAGE",
 *     annotationType: "IMAGE_CLASSIFICATION_ANNOTATION",
 *     classificationMetadata: { isMultiLabel: false },
 *     bigquerySource: {
 *       inputUri: "bq://my-project.eval.predictions",
 *     },
 *   },
 *   bigqueryImportKeys: {
 *     data_json_key: "data",
 *     label_json_key: "label",
 *     label_score_json_key: "score",
 *   },
 *   imageClassificationConfig: {
 *     annotationSpecSet: specs.name,
 *   },
 * };
 * const job = yield* GCP.DataLabeling.EvaluationJob("DailyEval", {
 *   annotationSpecSet: specs.name,
 *   modelVersion:
 *     "projects/my-project/models/classifier/versions/v1",
 *   schedule: "every 24 hours",
 *   evaluationJobConfig,
 * });
 * ```
 *
 * ### Pausing an Evaluation Job
 * **Example:** Pause sampling
 * ```typescript
 * // Same logical id, changed props: the engine updates it in place.
 * const job = yield* GCP.DataLabeling.EvaluationJob("DailyEval", {
 *   annotationSpecSet: specs.name,
 *   modelVersion:
 *     "projects/my-project/models/classifier/versions/v1",
 *   schedule: "every 24 hours",
 *   evaluationJobConfig,
 *   paused: true,
 * });
 * ```
 *
 * @resource
 * @category DataLabeling
 */
export const EvaluationJob = Resource<EvaluationJob>(
  "GCP.DataLabeling.EvaluationJob",
);

export class EvaluationJobNotResolved extends Data.TaggedError(
  "GCP.DataLabeling.EvaluationJobNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, evaluationJobId: string) =>
  `${projectParent(project)}/evaluationJobs/${evaluationJobId}`;

const isPaused = (state: string | undefined) => state === "PAUSED";

const configIdentity = (config: EvaluationJobConfig | undefined) => {
  if (config === undefined) return undefined;
  const {
    exampleCount: _exampleCount,
    exampleSamplePercentage: _exampleSamplePercentage,
    humanAnnotationConfig,
    ...rest
  } = config;
  const { instruction: _instruction, ...humanRest } =
    humanAnnotationConfig ?? {};
  return {
    ...rest,
    humanAnnotationConfig:
      Object.keys(humanRest).length > 0 ? humanRest : undefined,
  };
};

const toAttrs = (
  job: datalabeling.GoogleCloudDatalabelingV1beta1EvaluationJob,
  project: string,
) => {
  const name = job.name ?? "";
  const parsed = parseResourceName(name, "evaluationJobs");
  return {
    name,
    evaluationJobId: parsed.id,
    project: parsed.project || project,
    description: parseOwnership(job.description).text,
    annotationSpecSet: job.annotationSpecSet,
    modelVersion: job.modelVersion,
    schedule: job.schedule,
    labelMissingGroundTruth: job.labelMissingGroundTruth === true,
    evaluationJobConfig: job.evaluationJobConfig,
    state: job.state,
    paused: isPaused(job.state),
    attempts: job.attempts,
    createTime: job.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : datalabeling.getProjectsEvaluationJobs({ name }).pipe(
        Effect.provide(noRetryLayer),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("BadGateway", () => Effect.succeed(undefined)),
      );

const findByOwnership = (id: string, project: string) =>
  Effect.gen(function* () {
    const rows = yield* listEvaluationJobs(projectParent(project));
    return yield* findOwned(id, rows, (row) => row.description);
  });

export const EvaluationJobProvider = () =>
  Provider.succeed(EvaluationJob, {
    stables: ["name", "evaluationJobId", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const extra =
        (output?.annotationSpecSet !== undefined &&
          !sameText(news.annotationSpecSet, output.annotationSpecSet)) ||
        (output?.modelVersion !== undefined &&
          !sameText(news.modelVersion, output.modelVersion)) ||
        (output?.schedule !== undefined &&
          !sameText(news.schedule, output.schedule)) ||
        (output !== undefined &&
          (news.labelMissingGroundTruth === true) !==
            output.labelMissingGroundTruth) ||
        (olds !== undefined &&
          !sameText(news.description, output?.description)) ||
        (output !== undefined &&
          !sameJson(
            configIdentity(news.evaluationJobConfig),
            configIdentity(output.evaluationJobConfig),
          ));
      return replaceOnIdentity({
        previousId: olds?.evaluationJobId ?? output?.evaluationJobId,
        nextId: news.evaluationJobId,
        extra,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const evaluationJobId =
        olds?.evaluationJobId ??
        output?.evaluationJobId ??
        (output?.name
          ? parseResourceName(output.name, "evaluationJobs").id
          : "");
      const name =
        output?.name ??
        (evaluationJobId.length > 0
          ? resourceName(env.project, evaluationJobId)
          : "");
      const existing =
        (yield* getByName(name)) ?? (yield* findByOwnership(id, env.project));
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const rows = yield* listEvaluationJobs(projectParent(env.project));
        return rows
          .filter((row) => hasOwnershipMarker(row.description))
          .map((row) => toAttrs(row, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const evaluationJobId = news.evaluationJobId ?? output?.evaluationJobId;
      const name =
        output?.name ??
        (evaluationJobId !== undefined
          ? resourceName(env.project, evaluationJobId)
          : "");
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(
        ownership,
        news.description,
        MAX_EVALUATION_DESCRIPTION_LENGTH,
      );
      const labelMissingGroundTruth = news.labelMissingGroundTruth === true;
      const desiredPaused = news.paused === true;

      let current =
        (yield* getByName(name)) ?? (yield* findByOwnership(id, env.project));

      if (current === undefined) {
        const created = yield* retryTransient(
          datalabeling.createProjectsEvaluationJobs({
            parent: projectParent(env.project),
            body: {
              job: {
                description,
                annotationSpecSet: news.annotationSpecSet,
                modelVersion: news.modelVersion,
                schedule: news.schedule,
                labelMissingGroundTruth,
                evaluationJobConfig: news.evaluationJobConfig,
              },
            },
          }),
        ).pipe(
          Effect.catchTag("Conflict", () => findByOwnership(id, env.project)),
        );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new EvaluationJobNotResolved({
          name: name || projectParent(env.project),
        });
      }

      const currentName = current.name ?? name;
      const observedConfig = current.evaluationJobConfig;
      const desiredConfig = news.evaluationJobConfig;
      const instructionChanged = !sameText(
        observedConfig?.humanAnnotationConfig?.instruction,
        desiredConfig.humanAnnotationConfig?.instruction,
      );
      const exampleCountChanged =
        (observedConfig?.exampleCount ?? undefined) !==
        (desiredConfig.exampleCount ?? undefined);
      const sampleChanged =
        (observedConfig?.exampleSamplePercentage ?? undefined) !==
        (desiredConfig.exampleSamplePercentage ?? undefined);

      if (instructionChanged || exampleCountChanged || sampleChanged) {
        current = yield* retryTransient(
          datalabeling.patchProjectsEvaluationJobs({
            name: currentName,
            updateMask: updateMaskOf(
              instructionChanged
                ? "evaluationJobConfig.humanAnnotationConfig.instruction"
                : undefined,
              exampleCountChanged
                ? "evaluationJobConfig.exampleCount"
                : undefined,
              sampleChanged
                ? "evaluationJobConfig.exampleSamplePercentage"
                : undefined,
            ),
            body: {
              evaluationJobConfig: {
                humanAnnotationConfig: desiredConfig.humanAnnotationConfig,
                exampleCount: desiredConfig.exampleCount,
                exampleSamplePercentage: desiredConfig.exampleSamplePercentage,
              },
            },
          }),
        );
      }

      if (desiredPaused && !isPaused(current.state)) {
        yield* retryTransient(
          datalabeling.pauseProjectsEvaluationJobs({
            name: currentName,
            body: {},
          }),
        );
        current = (yield* getByName(currentName)) ?? current;
      } else if (!desiredPaused && isPaused(current.state)) {
        yield* retryTransient(
          datalabeling.resumeProjectsEvaluationJobs({
            name: currentName,
            body: {},
          }),
        );
        current = (yield* getByName(currentName)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* ignoreGone(
        retryDelete(
          datalabeling.deleteProjectsEvaluationJobs({ name: output.name }),
        ),
      );
      yield* waitUntilGone(getByName(output.name));
    }),
  });
