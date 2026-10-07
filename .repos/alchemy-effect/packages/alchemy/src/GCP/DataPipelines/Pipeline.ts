import * as datapipelines from "@distilled.cloud/gcp/datapipelines_v1";
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
  DEFAULT_STATE,
  DEFAULT_TYPE,
  findOwnedPipeline,
  getPipeline,
  ignoreMissing,
  jsonEqual,
  listOwnedPipelines,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  ownershipSources,
  parseName,
  replaceOnIdentity,
  resourceName,
  sameText,
  scheduleKey,
  toDisplayName,
  toPipelineId,
  updateMaskOf,
  userSources,
} from "./internal.ts";

export type PipelineType =
  | datapipelines.GoogleCloudDatapipelinesV1PipelineTypeEnum
  | (string & {});

export type PipelineState =
  | datapipelines.GoogleCloudDatapipelinesV1PipelineStateEnum
  | (string & {});

export type ScheduleSpec = {
  /**
   * Unix-cron schedule (for example `"0 0 * * *"`). When set, Data
   * Pipelines creates an internal Cloud Scheduler job.
   */
  schedule?: string;
  /**
   * tz-database time zone used to interpret `schedule`. Empty uses UTC.
   */
  timeZone?: string;
};

export type Workload = datapipelines.GoogleCloudDatapipelinesV1Workload;

export type PipelineProps = {
  /**
   * Pipeline id (the `{pipeline}` segment of
   * `projects/{project}/locations/{location}/pipelines/{pipeline}`). If
   * omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the pipeline.
   */
  pipelineId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * pipeline. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * Data Pipelines is only available in App Engine regions.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Display name. Letters, numbers, hyphens, and underscores only. If
   * omitted, Alchemy uses the generated pipeline id.
   */
  displayName?: string;
  /**
   * Pipeline type (`PIPELINE_TYPE_BATCH` or `PIPELINE_TYPE_STREAMING`).
   * Batch pipelines run on `scheduleInfo`; streaming pipelines launch a
   * job at create time. Immutable — changing it replaces the pipeline.
   * @default "PIPELINE_TYPE_BATCH"
   */
  type?: PipelineType;
  /**
   * Desired execution state (`STATE_ACTIVE`, `STATE_PAUSED`,
   * `STATE_ARCHIVED`, …). Applied on create. Later archive requests call
   * `pipelines.stop` (permanent). State cannot be patched.
   * @default "STATE_ACTIVE"
   */
  state?: PipelineState;
  /**
   * Cron used to launch batch jobs. Omit to manage jobs with
   * `pipelines.run` instead of Cloud Scheduler.
   */
  scheduleInfo?: ScheduleSpec;
  /**
   * Service account email for the internal Cloud Scheduler job. Defaults
   * to the Compute Engine default service account.
   */
  schedulerServiceAccountEmail?: string;
  /**
   * Dataflow classic or Flex template used to launch jobs. Exactly one of
   * `dataflowLaunchTemplateRequest` or `dataflowFlexTemplateRequest`.
   */
  workload?: Workload;
  /**
   * Source annotations (for example Dataplex). Immutable. Alchemy
   * ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`) is
   * merged in automatically because pipelines have no labels field.
   */
  pipelineSources?: Record<string, string>;
};

export type Pipeline = Resource<
  "GCP.DataPipelines.Pipeline",
  PipelineProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/pipelines/{pipeline}`. */
    name: string;
    /** Pipeline id (last path segment). */
    pipelineId: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** Parent `projects/{project}/locations/{location}`. */
    parent: string;
    /** Display name. */
    displayName: string | undefined;
    /** Pipeline type. */
    type: string | undefined;
    /** Execution state. */
    state: string | undefined;
    /** Cron schedule, if configured. */
    scheduleInfo: ScheduleSpec | undefined;
    /** Scheduler service account email, if set. */
    schedulerServiceAccountEmail: string | undefined;
    /** Dataflow template used to launch jobs. */
    workload: Workload | undefined;
    /** User source annotations (Alchemy ownership keys stripped). */
    pipelineSources: Record<string, string>;
    /** Number of launched jobs. */
    jobCount: number | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    lastUpdateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Data Pipelines pipeline that launches recurring Dataflow jobs.
 *
 * Pipelines have no labels field, so Alchemy stamps ownership into
 * `pipelineSources` for `list` / nuke. Pipeline id, location, and type
 * are identity — changing any of them replaces the pipeline. Display
 * name, workload, schedule, and scheduler service account update in
 * place. Archiving uses `pipelines.stop` and is permanent. Creating a
 * pipeline requires the Data Pipelines API
 * (`datapipelines.googleapis.com`).
 *
 * ### Creating a Pipeline
 * **Example:** Generated name
 * ```typescript
 * const pipeline = yield* GCP.DataPipelines.Pipeline("Batch", {
 *   type: "PIPELINE_TYPE_BATCH",
 * });
 * ```
 *
 * **Example:** Classic Word Count template on a yearly cron
 * ```typescript
 * const pipeline = yield* GCP.DataPipelines.Pipeline("WordCount", {
 *   pipelineId: "word-count",
 *   type: "PIPELINE_TYPE_BATCH",
 *   displayName: "word-count",
 *   scheduleInfo: { schedule: "0 0 1 1 *", timeZone: "UTC" },
 *   workload: {
 *     dataflowLaunchTemplateRequest: {
 *       projectId: "my-project",
 *       location: "us-central1",
 *       gcsPath: "gs://dataflow-templates/latest/Word_Count",
 *       launchParameters: {
 *         jobName: "word-count",
 *         parameters: {
 *           inputFile: "gs://dataflow-samples/shakespeare/kinglear.txt",
 *           output: "gs://my-bucket/out",
 *         },
 *         environment: { tempLocation: "gs://my-bucket/tmp" },
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * ### Updating a Pipeline
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Rename and change the schedule
 * ```typescript
 * const pipeline = yield* GCP.DataPipelines.Pipeline("WordCount", {
 *   type: "PIPELINE_TYPE_BATCH",
 *   displayName: "word-count-v2",
 *   scheduleInfo: { schedule: "0 0 1 2 *", timeZone: "UTC" },
 * });
 * ```
 *
 * @resource
 * @category DataPipelines
 */
export const Pipeline = Resource<Pipeline>("GCP.DataPipelines.Pipeline");

export class PipelineNotResolved extends Data.TaggedError(
  "GCP.DataPipelines.PipelineNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  pipeline: datapipelines.GoogleCloudDatapipelinesV1Pipeline,
  project: string,
  region: string,
) => {
  const name = pipeline.name ?? "";
  const parsed = parseName(name, region);
  return {
    name,
    pipelineId: parsed.pipelineId,
    location: parsed.location,
    project: parsed.project || project,
    parent: parsed.parent || locationParent(project, parsed.location),
    displayName: pipeline.displayName,
    type: pipeline.type,
    state: pipeline.state,
    scheduleInfo: pipeline.scheduleInfo
      ? {
          schedule: pipeline.scheduleInfo.schedule,
          timeZone: pipeline.scheduleInfo.timeZone,
        }
      : undefined,
    schedulerServiceAccountEmail: pipeline.schedulerServiceAccountEmail,
    workload: pipeline.workload,
    pipelineSources: userSources(pipeline.pipelineSources),
    jobCount: pipeline.jobCount,
    createTime: pipeline.createTime,
    lastUpdateTime: pipeline.lastUpdateTime,
  };
};

const fillWorkload = (
  workload: Workload | undefined,
  project: string,
  location: string,
): Workload | undefined => {
  if (workload === undefined) return undefined;
  const classic = workload.dataflowLaunchTemplateRequest;
  const flex = workload.dataflowFlexTemplateRequest;
  return {
    dataflowLaunchTemplateRequest: classic
      ? {
          ...classic,
          projectId: classic.projectId ?? project,
          location: classic.location ?? location,
        }
      : undefined,
    dataflowFlexTemplateRequest: flex
      ? {
          ...flex,
          projectId: flex.projectId ?? project,
          location: flex.location ?? location,
        }
      : undefined,
  };
};

const desiredSchedule = (
  info: ScheduleSpec | undefined,
): datapipelines.GoogleCloudDatapipelinesV1ScheduleSpec | undefined => {
  if (info === undefined) return undefined;
  if ((info.schedule ?? "") === "" && (info.timeZone ?? "") === "") {
    return undefined;
  }
  return {
    schedule: info.schedule,
    timeZone: info.timeZone,
  };
};

export const PipelineProvider = () =>
  Provider.succeed(Pipeline, {
    stables: [
      "name",
      "pipelineId",
      "location",
      "project",
      "parent",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousType = olds?.type ?? output?.type;
      const nextType = news.type ?? previousType;
      return replaceOnIdentity({
        previousId: olds?.pipelineId ?? output?.pipelineId,
        nextId: news.pipelineId,
        previousLocation,
        nextLocation,
        previousType,
        nextType,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const pipelineId = yield* toPipelineId(
        id,
        olds?.pipelineId,
        output?.pipelineId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, pipelineId);
      const existing = yield* findOwnedPipeline(
        id,
        env.project,
        env.region,
        name,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(id, existing.pipelineSources))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const rows = yield* listOwnedPipelines(env.project, env.region);
        return rows.map((row) => toAttrs(row, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const pipelineId = yield* toPipelineId(
        id,
        news.pipelineId,
        output?.pipelineId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const parent = locationParent(env.project, location);
      const name = resourceName(env.project, location, pipelineId);
      const displayName = toDisplayName(news.displayName, pipelineId);
      const type = news.type ?? output?.type ?? DEFAULT_TYPE;
      const state = news.state ?? output?.state ?? DEFAULT_STATE;
      const ownership = yield* createInternalLabels(id);
      const pipelineSources = ownershipSources(
        ownership,
        news.pipelineSources ?? output?.pipelineSources,
      );
      const scheduleInfo = desiredSchedule(news.scheduleInfo);
      const workload = fillWorkload(news.workload, env.project, location);
      const schedulerServiceAccountEmail = news.schedulerServiceAccountEmail;

      let current = yield* findOwnedPipeline(
        id,
        env.project,
        env.region,
        output?.name ?? name,
      );

      if (current === undefined) {
        const created = yield* datapipelines
          .createProjectsLocationsPipelines({
            parent,
            body: {
              name,
              displayName,
              type,
              state,
              scheduleInfo,
              schedulerServiceAccountEmail,
              workload,
              pipelineSources,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getPipeline(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new PipelineNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const scheduleChanged =
        news.scheduleInfo !== undefined &&
        !jsonEqual(
          scheduleKey(current.scheduleInfo),
          scheduleKey(scheduleInfo),
        );
      const schedulerChanged =
        news.schedulerServiceAccountEmail !== undefined &&
        !sameText(
          current.schedulerServiceAccountEmail,
          schedulerServiceAccountEmail,
        );
      const workloadChanged =
        news.workload !== undefined && !jsonEqual(current.workload, workload);
      const updateMask = updateMaskOf(
        displayChanged ? "displayName" : undefined,
        scheduleChanged ? "scheduleInfo" : undefined,
        schedulerChanged ? "schedulerServiceAccountEmail" : undefined,
        workloadChanged ? "workload" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* datapipelines.patchProjectsLocationsPipelines({
          name: currentName,
          updateMask,
          body: {
            displayName,
            scheduleInfo,
            schedulerServiceAccountEmail,
            workload,
          },
        });
      }

      const wantsArchived = state === "STATE_ARCHIVED";
      if (wantsArchived && current.state !== "STATE_ARCHIVED") {
        current = yield* datapipelines
          .stopProjectsLocationsPipelines({
            name: currentName,
            body: {},
          })
          .pipe(
            Effect.catchTag("NotFound", () => getPipeline(currentName)),
            Effect.flatMap((row) =>
              row !== undefined
                ? Effect.succeed(row)
                : new PipelineNotResolved({ name: currentName }),
            ),
          );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* ignoreMissing(
        datapipelines.deleteProjectsLocationsPipelines({ name: output.name }),
      );
    }),
  });
