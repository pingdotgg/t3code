import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { listLocations } from "./names.ts";
import { waitForOperation } from "./operations.ts";
import {
  encodeOwnershipLine,
  hasOwnershipMarker,
  lastSegment,
  locationOf,
  locationParent,
  ownedByAlchemy,
  parseOwnership,
} from "./ownership.ts";

export type PipelineJobRequest = {
  /**
   * Location parent for created pipeline jobs
   * (`projects/{project}/locations/{location}`). Defaults to the
   * Schedule's location.
   */
  parent?: string;
  /** Optional pipeline job id. */
  pipelineJobId?: string;
  /** Pipeline job to create on each run. */
  pipelineJob?: {
    displayName?: string;
    templateUri?: string;
    pipelineSpec?: Record<string, unknown>;
    serviceAccount?: string;
    network?: string;
    labels?: Record<string, string>;
    runtimeConfig?: {
      gcsOutputDirectory?: string;
      parameterValues?: Record<string, unknown>;
    };
  };
};

export type NotebookExecutionJobRequest = {
  parent?: string;
  notebookExecutionJobId?: string;
  notebookExecutionJob?: Record<string, unknown>;
};

export type ScheduleProps = {
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * Schedule.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-facing display name. Vertex AI Schedules have no labels field,
   * so Alchemy ownership is stored in a `[alchemy …]` prefix.
   */
  displayName?: string;
  /**
   * Cron schedule. Prefix with `CRON_TZ=${IANA_TIME_ZONE}` to set a
   * timezone (for example `CRON_TZ=UTC 0 0 * * *`).
   */
  cron: string;
  /**
   * Maximum number of runs that can be started concurrently.
   * @default "1"
   */
  maxConcurrentRunCount?: string;
  /**
   * Maximum number of active (non-terminal) pipeline runs. Only applies
   * to `createPipelineJobRequest`.
   */
  maxConcurrentActiveRunCount?: string;
  /**
   * Maximum number of runs before the schedule completes.
   */
  maxRunCount?: string;
  /**
   * RFC3339 timestamp after which the first run may be scheduled.
   */
  startTime?: string;
  /**
   * RFC3339 timestamp after which no new runs are scheduled.
   */
  endTime?: string;
  /**
   * Queue new runs when `maxConcurrentRunCount` is reached instead of
   * skipping them.
   * @default false
   */
  allowQueueing?: boolean;
  /**
   * Pipeline job created on each tick. Exactly one of
   * `createPipelineJobRequest` or `createNotebookExecutionJobRequest`
   * must be set.
   */
  createPipelineJobRequest?: PipelineJobRequest;
  /**
   * Notebook execution job created on each tick.
   */
  createNotebookExecutionJobRequest?: NotebookExecutionJobRequest;
  /**
   * When true, the schedule exists but does not start new runs (`PAUSED`).
   * Synced via `schedules.pause` / `schedules.resume`.
   * @default false
   */
  paused?: boolean;
};

export type Schedule = Resource<
  "GCP.AIPlatform.Schedule",
  ScheduleProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/schedules/{schedule}`. */
    name: string;
    /** Schedule id (last path segment). */
    scheduleId: string;
    /** Region id. */
    location: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Cron expression. */
    cron: string | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** Whether the schedule is paused. */
    paused: boolean;
    /** Maximum concurrent starts. */
    maxConcurrentRunCount: string | undefined;
    /** Maximum concurrent active pipeline runs. */
    maxConcurrentActiveRunCount: string | undefined;
    /** Maximum run count. */
    maxRunCount: string | undefined;
    /** RFC3339 start bound. */
    startTime: string | undefined;
    /** RFC3339 end bound. */
    endTime: string | undefined;
    /** Whether new runs may queue. */
    allowQueueing: boolean;
    /** Number of runs started so far. */
    startedRunCount: string | undefined;
    /** Next scheduled run (RFC3339). */
    nextRunTime: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Schedule that periodically starts pipeline or notebook jobs.
 *
 * Schedules have no labels field — Alchemy stamps ownership into the
 * display name. Location is immutable. Cron, run limits, and pause state
 * update in place.
 *
 * ### Creating a Schedule
 * **Example:** Daily paused pipeline schedule
 * ```typescript
 * const schedule = yield* GCP.AIPlatform.Schedule("Nightly", {
 *   cron: "CRON_TZ=UTC 0 8 * * *",
 *   paused: true,
 *   maxRunCount: "1",
 *   createPipelineJobRequest: {
 *     pipelineJob: {
 *       displayName: "nightly",
 *       templateUri: "https://us-kfp.pkg.dev/ml-pipeline/google-cloud-registry/hello-world/latest",
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const Schedule = Resource<Schedule>("GCP.AIPlatform.Schedule");

export class ScheduleNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.ScheduleNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  schedule: aiplatform.GoogleCloudAiplatformV1Schedule,
  project: string,
) => {
  const name = schedule.name ?? "";
  const parsed = parseOwnership(schedule.displayName);
  return {
    name,
    scheduleId: lastSegment(name),
    location: locationOf(name),
    project,
    displayName: parsed.text,
    cron: schedule.cron,
    state: schedule.state,
    paused: schedule.state === "PAUSED",
    maxConcurrentRunCount: schedule.maxConcurrentRunCount,
    maxConcurrentActiveRunCount: schedule.maxConcurrentActiveRunCount,
    maxRunCount: schedule.maxRunCount,
    startTime: schedule.startTime,
    endTime: schedule.endTime,
    allowQueueing: schedule.allowQueueing === true,
    startedRunCount: schedule.startedRunCount,
    nextRunTime: schedule.nextRunTime,
    createTime: schedule.createTime,
    updateTime: schedule.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : aiplatform
        .getProjectsLocationsSchedules({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string) =>
  aiplatform.listProjectsLocationsSchedules
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.schedules ?? [])),
      Stream.filter((schedule) => hasOwnershipMarker(schedule.displayName)),
      Stream.map((schedule) => toAttrs(schedule, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const toPipelineRequest = (
  request: PipelineJobRequest | undefined,
  parent: string,
): aiplatform.GoogleCloudAiplatformV1CreatePipelineJobRequest | undefined => {
  if (request === undefined) return undefined;
  const job = request.pipelineJob;
  return {
    parent: request.parent ?? parent,
    pipelineJobId: request.pipelineJobId,
    pipelineJob: job
      ? {
          displayName: job.displayName,
          templateUri: job.templateUri,
          pipelineSpec: job.pipelineSpec,
          serviceAccount: job.serviceAccount,
          network: job.network,
          labels: job.labels,
          runtimeConfig: job.runtimeConfig,
        }
      : undefined,
  };
};

const toNotebookRequest = (
  request: NotebookExecutionJobRequest | undefined,
):
  | aiplatform.GoogleCloudAiplatformV1CreateNotebookExecutionJobRequest
  | undefined => {
  if (request === undefined) return undefined;
  return {
    parent: request.parent,
    notebookExecutionJobId: request.notebookExecutionJobId,
    notebookExecutionJob:
      request.notebookExecutionJob as aiplatform.GoogleCloudAiplatformV1NotebookExecutionJob,
  };
};

export const ScheduleProvider = () =>
  Provider.succeed(Schedule, {
    stables: ["name", "scheduleId", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousLocation = olds?.location ?? output?.location;
      const nextLocation = news.location ?? previousLocation;
      if (previousLocation !== undefined && previousLocation !== nextLocation) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* getByName(output?.name ?? "");
      if (existing !== undefined) {
        const attrs = toAttrs(existing, env.project);
        return (yield* ownedByAlchemy(id, existing.displayName))
          ? attrs
          : Unowned(attrs);
      }
      const location = olds?.location ?? output?.location ?? env.region;
      const parent = locationParent(env.project, location);
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeOwnershipLine(ownership, olds?.displayName);
      const found = yield* aiplatform.listProjectsLocationsSchedules
        .pages({ parent, pageSize: 100 })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.schedules ?? [])),
          Stream.filter((schedule) => schedule.displayName === displayName),
          Stream.runHead,
          Effect.map((option) =>
            option._tag === "Some" ? option.value : undefined,
          ),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (found === undefined) return undefined;
      const attrs = toAttrs(found, env.project);
      return (yield* ownedByAlchemy(id, found.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return (yield* Effect.forEach(listLocations(env.region), (location) =>
          listAt(locationParent(env.project, location), env.project),
        )).flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = news.location ?? output?.location ?? env.region;
      const parent = locationParent(env.project, location);
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeOwnershipLine(ownership, news.displayName);
      const maxConcurrentRunCount = news.maxConcurrentRunCount ?? "1";
      const desiredPaused = news.paused === true;
      const pipelineRequest = toPipelineRequest(
        news.createPipelineJobRequest,
        parent,
      );
      const notebookRequest = toNotebookRequest(
        news.createNotebookExecutionJobRequest,
      );

      let current = yield* getByName(output?.name ?? "");
      if (current === undefined) {
        current = yield* aiplatform.listProjectsLocationsSchedules
          .pages({ parent, pageSize: 100 })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.schedules ?? [])),
            Stream.filter((schedule) => schedule.displayName === displayName),
            Stream.runHead,
            Effect.map((option) =>
              option._tag === "Some" ? option.value : undefined,
            ),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
      }

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsSchedules({
            parent,
            body: {
              displayName,
              cron: news.cron,
              maxConcurrentRunCount,
              maxConcurrentActiveRunCount: news.maxConcurrentActiveRunCount,
              maxRunCount: news.maxRunCount,
              startTime: news.startTime,
              endTime: news.endTime,
              allowQueueing: news.allowQueueing === true ? true : undefined,
              createPipelineJobRequest: pipelineRequest,
              createNotebookExecutionJobRequest: notebookRequest,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current = created ?? undefined;
        if (current === undefined) {
          current = yield* aiplatform.listProjectsLocationsSchedules
            .pages({ parent, pageSize: 100 })
            .pipe(
              Stream.flatMap((page) =>
                Stream.fromIterable(page.schedules ?? []),
              ),
              Stream.filter((schedule) => schedule.displayName === displayName),
              Stream.runHead,
              Effect.map((option) =>
                option._tag === "Some" ? option.value : undefined,
              ),
              Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
            );
        }
      }

      if (current === undefined) {
        return yield* new ScheduleNotResolved({
          name: output?.name ?? `${parent}/schedules/-`,
        });
      }

      const name = current.name ?? "";
      const cronChanged = (current.cron ?? "") !== news.cron;
      const displayChanged = (current.displayName ?? "") !== displayName;
      const concurrentChanged =
        (current.maxConcurrentRunCount ?? "") !== maxConcurrentRunCount;
      const activeChanged =
        (current.maxConcurrentActiveRunCount ?? "") !==
        (news.maxConcurrentActiveRunCount ?? "");
      const maxRunChanged =
        (current.maxRunCount ?? "") !== (news.maxRunCount ?? "");
      const startChanged = (current.startTime ?? "") !== (news.startTime ?? "");
      const endChanged = (current.endTime ?? "") !== (news.endTime ?? "");
      const queueChanged =
        (current.allowQueueing === true) !== (news.allowQueueing === true);

      if (
        cronChanged ||
        displayChanged ||
        concurrentChanged ||
        activeChanged ||
        maxRunChanged ||
        startChanged ||
        endChanged ||
        queueChanged
      ) {
        current = yield* aiplatform.patchProjectsLocationsSchedules({
          name,
          updateMask: [
            cronChanged ? "cron" : undefined,
            displayChanged ? "display_name" : undefined,
            concurrentChanged ? "max_concurrent_run_count" : undefined,
            activeChanged ? "max_concurrent_active_run_count" : undefined,
            maxRunChanged ? "max_run_count" : undefined,
            startChanged ? "start_time" : undefined,
            endChanged ? "end_time" : undefined,
            queueChanged ? "allow_queueing" : undefined,
          ]
            .filter((field): field is string => field !== undefined)
            .join(","),
          body: {
            name,
            displayName,
            cron: news.cron,
            maxConcurrentRunCount,
            maxConcurrentActiveRunCount: news.maxConcurrentActiveRunCount,
            maxRunCount: news.maxRunCount,
            startTime: news.startTime,
            endTime: news.endTime,
            allowQueueing: news.allowQueueing === true,
          },
        });
      }

      const isPaused = current.state === "PAUSED";
      if (desiredPaused && !isPaused) {
        yield* aiplatform.pauseProjectsLocationsSchedules({ name });
        current = (yield* getByName(name)) ?? current;
      } else if (!desiredPaused && isPaused) {
        yield* aiplatform.resumeProjectsLocationsSchedules({
          name,
          body: { catchUp: false },
        });
        current = (yield* getByName(name)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* aiplatform
        .deleteProjectsLocationsSchedules({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
    }),
  });
