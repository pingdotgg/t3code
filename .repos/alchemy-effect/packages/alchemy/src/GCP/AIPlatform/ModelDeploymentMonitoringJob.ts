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
import { hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  alchemyIdFilter,
  createInternalLabels,
  hasAlchemyPrefix,
  labelsDiffer,
  listLocations,
  locationOf,
  lastSegment,
  normalizeLocation,
  projectOf,
  stableJson,
  toDisplayName,
  toLabels,
  userLabels,
} from "./names.ts";
import { waitForOperation } from "./operations.ts";

export type ModelDeploymentMonitoringJobProps = {
  /**
   * Vertex AI location. Immutable — changing it replaces the job.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name (max 128 Unicode characters). Generated from the stack,
   * stage, and logical id when omitted.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Endpoint resource name
   * `projects/{project}/locations/{location}/endpoints/{endpoint}`.
   * Immutable.
   */
  endpoint: string;
  /**
   * Sample strategy for logging prediction requests.
   */
  loggingSamplingStrategy: aiplatform.GoogleCloudAiplatformV1SamplingStrategy;
  /**
   * Schedule config for running the monitoring job.
   */
  modelDeploymentMonitoringScheduleConfig: aiplatform.GoogleCloudAiplatformV1ModelDeploymentMonitoringScheduleConfig;
  /**
   * Per-DeployedModel monitoring objectives.
   */
  modelDeploymentMonitoringObjectiveConfigs: aiplatform.GoogleCloudAiplatformV1ModelDeploymentMonitoringObjectiveConfigList;
  /**
   * Alert config for model monitoring.
   */
  modelMonitoringAlertConfig?: aiplatform.GoogleCloudAiplatformV1ModelMonitoringAlertConfig;
  /**
   * YAML schema URI describing a single predict instance.
   */
  predictInstanceSchemaUri?: string;
  /**
   * YAML schema URI describing a TFDV analysis instance.
   */
  analysisInstanceSchemaUri?: string;
  /**
   * Sample predict instance used instead of `predictInstanceSchemaUri`.
   */
  samplePredictInstance?: unknown;
  /**
   * GCS folder for stats anomalies.
   */
  statsAnomaliesBaseDirectory?: aiplatform.GoogleCloudAiplatformV1GcsDestination;
  /**
   * TTL of BigQuery log tables (duration string).
   */
  logTtl?: string;
  /**
   * Send monitoring pipeline logs to Cloud Logging.
   * @default false
   */
  enableMonitoringPipelineLogs?: boolean;
  /**
   * Customer-managed encryption key. Immutable.
   */
  encryptionSpec?: aiplatform.GoogleCloudAiplatformV1EncryptionSpec;
};

export type ModelDeploymentMonitoringJob = Resource<
  "GCP.AIPlatform.ModelDeploymentMonitoringJob",
  ModelDeploymentMonitoringJobProps,
  {
    /** Full resource name. */
    name: string;
    /** Job id (last path segment). */
    modelDeploymentMonitoringJobId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Monitored endpoint resource name. */
    endpoint: string | undefined;
    /** Job state. */
    state: string | undefined;
    /** Schedule state while running. */
    scheduleState: string | undefined;
    /** Whether pipeline logs are enabled. */
    enableMonitoringPipelineLogs: boolean;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** RFC3339 next schedule time. */
    nextScheduleTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI ModelDeploymentMonitoringJob that periodically scores a
 * deployed model for skew and drift.
 *
 * Changing `location` or `endpoint` replaces the job. Display name,
 * labels, schedule, sampling, alerts, and objective configs update in
 * place (long-running). Delete pauses the job first.
 *
 * ### Creating a ModelDeploymentMonitoringJob
 * **Example:** Hourly sampling
 * ```typescript
 * const job = yield* GCP.AIPlatform.ModelDeploymentMonitoringJob("Watch", {
 *   endpoint: endpoint.name,
 *   loggingSamplingStrategy: { randomSampleConfig: { sampleRate: 0.1 } },
 *   modelDeploymentMonitoringScheduleConfig: { monitorInterval: "3600s" },
 *   modelDeploymentMonitoringObjectiveConfigs: [{
 *     deployedModelId: deployed.id,
 *     objectiveConfig: {
 *       predictionDriftDetectionConfig: {},
 *     },
 *   }],
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const ModelDeploymentMonitoringJob =
  Resource<ModelDeploymentMonitoringJob>(
    "GCP.AIPlatform.ModelDeploymentMonitoringJob",
  );

export class ModelDeploymentMonitoringJobNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.ModelDeploymentMonitoringJobNotResolved",
)<{
  name: string;
}> {}

export class ModelDeploymentMonitoringJobStillExists extends Data.TaggedError(
  "GCP.AIPlatform.ModelDeploymentMonitoringJobStillExists",
)<{
  name: string;
}> {}

const toAttrs = (
  job: aiplatform.GoogleCloudAiplatformV1ModelDeploymentMonitoringJob,
  project: string,
) => {
  const name = job.name ?? "";
  return {
    name,
    modelDeploymentMonitoringJobId: lastSegment(name),
    project: projectOf(name, project),
    location: locationOf(name),
    displayName: job.displayName,
    labels: userLabels(job.labels),
    endpoint: job.endpoint,
    state: job.state,
    scheduleState: job.scheduleState,
    enableMonitoringPipelineLogs: job.enableMonitoringPipelineLogs === true,
    createTime: job.createTime,
    updateTime: job.updateTime,
    nextScheduleTime: job.nextScheduleTime,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsModelDeploymentMonitoringJobs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listPage = (parent: string, filter?: string) =>
  aiplatform.listProjectsLocationsModelDeploymentMonitoringJobs
    .pages({ parent, pageSize: 100, filter })
    .pipe(
      Stream.runCollect,
      Effect.map((pages) =>
        Array.from(pages).flatMap(
          (page) => page.modelDeploymentMonitoringJobs ?? [],
        ),
      ),
      Effect.catchTag("NotFound", () =>
        Effect.succeed(
          [] as aiplatform.GoogleCloudAiplatformV1ModelDeploymentMonitoringJob[],
        ),
      ),
    );

const findOwned = (
  project: string,
  location: string,
  labels: Record<string, string>,
) =>
  listPage(
    `projects/${project}/locations/${location}`,
    alchemyIdFilter(labels),
  ).pipe(
    Effect.map(
      (items) =>
        items.find((item) => hasAlchemyPrefix(item.labels)) ?? undefined,
    ),
  );

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (
        job,
      ): job is aiplatform.GoogleCloudAiplatformV1ModelDeploymentMonitoringJob =>
        job !== undefined,
      () => new ModelDeploymentMonitoringJobNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.ModelDeploymentMonitoringJobNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (job) => job === undefined,
      () => new ModelDeploymentMonitoringJobStillExists({ name }),
    ),
    Effect.asVoid,
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.ModelDeploymentMonitoringJobStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const ModelDeploymentMonitoringJobProvider = () =>
  Provider.succeed(ModelDeploymentMonitoringJob, {
    stables: [
      "name",
      "modelDeploymentMonitoringJobId",
      "project",
      "location",
      "endpoint",
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
      const previousEndpoint = olds?.endpoint ?? output?.endpoint;
      const nextEndpoint = news.endpoint ?? previousEndpoint;
      if (
        previousLocation !== nextLocation ||
        (previousEndpoint !== undefined &&
          nextEndpoint !== undefined &&
          nextEndpoint !== previousEndpoint)
      ) {
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
      const ownership = yield* createInternalLabels(id);
      const existing =
        (output?.name !== undefined
          ? yield* getByName(output.name)
          : undefined) ?? (yield* findOwned(env.project, location, ownership));
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* Effect.forEach(
          listLocations(env.region),
          (location) =>
            listPage(`projects/${env.project}/locations/${location}`),
          { concurrency: 4 },
        );
        return pages
          .flat()
          .filter((job) => hasAlchemyPrefix(job.labels))
          .map((job) => toAttrs(job, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const displayName = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const enableLogs = news.enableMonitoringPipelineLogs === true;

      let current =
        (output?.name !== undefined
          ? yield* getByName(output.name)
          : undefined) ??
        (yield* findOwned(env.project, location, desiredLabels));

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsModelDeploymentMonitoringJobs({
            parent: `projects/${env.project}/locations/${location}`,
            body: {
              displayName,
              labels: desiredLabels,
              endpoint: news.endpoint,
              loggingSamplingStrategy: news.loggingSamplingStrategy,
              modelDeploymentMonitoringScheduleConfig:
                news.modelDeploymentMonitoringScheduleConfig,
              modelDeploymentMonitoringObjectiveConfigs:
                news.modelDeploymentMonitoringObjectiveConfigs,
              modelMonitoringAlertConfig: news.modelMonitoringAlertConfig,
              predictInstanceSchemaUri: news.predictInstanceSchemaUri,
              analysisInstanceSchemaUri: news.analysisInstanceSchemaUri,
              samplePredictInstance: news.samplePredictInstance,
              statsAnomaliesBaseDirectory: news.statsAnomaliesBaseDirectory,
              logTtl: news.logTtl,
              enableMonitoringPipelineLogs: enableLogs,
              encryptionSpec: news.encryptionSpec,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current =
          created ?? (yield* findOwned(env.project, location, desiredLabels));
      }

      if (current === undefined || current.name === undefined) {
        return yield* new ModelDeploymentMonitoringJobNotResolved({
          name: output?.name ?? `${location}/modelDeploymentMonitoringJobs`,
        });
      }

      const name = current.name;
      const displayChanged = (current.displayName ?? "") !== displayName;
      const labelsChanged = labelsDiffer(current.labels, desiredLabels);
      const logsChanged =
        (current.enableMonitoringPipelineLogs === true) !== enableLogs;
      const samplingChanged =
        stableJson(current.loggingSamplingStrategy) !==
        stableJson(news.loggingSamplingStrategy);
      const scheduleChanged =
        stableJson(current.modelDeploymentMonitoringScheduleConfig) !==
        stableJson(news.modelDeploymentMonitoringScheduleConfig);
      const objectivesChanged =
        stableJson(current.modelDeploymentMonitoringObjectiveConfigs) !==
        stableJson(news.modelDeploymentMonitoringObjectiveConfigs);
      const alertChanged =
        news.modelMonitoringAlertConfig !== undefined &&
        stableJson(current.modelMonitoringAlertConfig) !==
          stableJson(news.modelMonitoringAlertConfig);
      const logTtlChanged = (current.logTtl ?? "") !== (news.logTtl ?? "");

      if (
        displayChanged ||
        labelsChanged ||
        logsChanged ||
        samplingChanged ||
        scheduleChanged ||
        objectivesChanged ||
        alertChanged ||
        logTtlChanged
      ) {
        const operation =
          yield* aiplatform.patchProjectsLocationsModelDeploymentMonitoringJobs(
            {
              name,
              updateMask: [
                displayChanged ? "display_name" : undefined,
                labelsChanged ? "labels" : undefined,
                logsChanged ? "enable_monitoring_pipeline_logs" : undefined,
                samplingChanged ? "logging_sampling_strategy" : undefined,
                scheduleChanged
                  ? "model_deployment_monitoring_schedule_config"
                  : undefined,
                objectivesChanged
                  ? "model_deployment_monitoring_objective_configs"
                  : undefined,
                alertChanged ? "model_monitoring_alert_config" : undefined,
                logTtlChanged ? "log_ttl" : undefined,
              ]
                .filter((field): field is string => field !== undefined)
                .join(","),
              body: {
                name,
                displayName,
                labels: desiredLabels,
                enableMonitoringPipelineLogs: enableLogs,
                loggingSamplingStrategy: news.loggingSamplingStrategy,
                modelDeploymentMonitoringScheduleConfig:
                  news.modelDeploymentMonitoringScheduleConfig,
                modelDeploymentMonitoringObjectiveConfigs:
                  news.modelDeploymentMonitoringObjectiveConfigs,
                modelMonitoringAlertConfig: news.modelMonitoringAlertConfig,
                logTtl: news.logTtl,
              },
            },
          );
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* aiplatform
        .pauseProjectsLocationsModelDeploymentMonitoringJobs({
          name: output.name,
          body: {},
        })
        .pipe(
          Effect.catchTag(
            ["NotFound", "BadRequest", "Conflict"],
            () => Effect.void,
          ),
        );
      const operation = yield* aiplatform
        .deleteProjectsLocationsModelDeploymentMonitoringJobs({
          name: output.name,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
