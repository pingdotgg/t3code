import * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
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
import {
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_JOB_ID_LENGTH = 1024;

export type JobQuery = bigquery.JobConfigurationQuery;
export type JobLoad = bigquery.JobConfigurationLoad;
export type JobCopy = bigquery.JobConfigurationTableCopy;
export type JobExtract = bigquery.JobConfigurationExtract;
export type JobError = bigquery.ErrorProto;

export type JobProps = {
  /**
   * Job id (the `{jobId}` segment of `projects/{project}/jobs/{jobId}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Letters, numbers, underscores, and dashes; max 1,024
   * characters. Immutable — changing it replaces the job.
   */
  jobId?: string;
  /**
   * Geographic location (`US`, `EU`, `US-CENTRAL1`, `us-central1`, …).
   * Immutable — changing it replaces the job.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * Immutable after create — changing labels replaces the job.
   */
  labels?: Record<string, string>;
  /**
   * Query job configuration. Mutually exclusive with `load`, `copy`, and
   * `extract`. GoogleSQL is the default (`useLegacySql: false`).
   */
  query?: JobQuery;
  /**
   * Load job configuration. Mutually exclusive with `query`, `copy`, and
   * `extract`.
   */
  load?: JobLoad;
  /**
   * Copy job configuration. Mutually exclusive with `query`, `load`, and
   * `extract`.
   */
  copy?: JobCopy;
  /**
   * Extract job configuration. Mutually exclusive with `query`, `load`,
   * and `copy`.
   */
  extract?: JobExtract;
  /**
   * Job timeout in milliseconds relative to creation time.
   */
  jobTimeoutMs?: string;
  /**
   * Reservation the job should run on, as
   * `projects/{project}/locations/{location}/reservations/{reservation}`.
   */
  reservation?: string;
};

export type Job = Resource<
  "GCP.BigQuery.Job",
  JobProps,
  {
    /** Resource path `projects/{project}/jobs/{jobId}`. */
    name: string;
    /** Opaque id `project:jobId`. */
    id: string;
    /** Job id. */
    jobId: string;
    /** Project id. */
    project: string;
    /** Geographic location. */
    location: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Job kind (`QUERY`, `LOAD`, `EXTRACT`, `COPY`, …). */
    jobType: string | undefined;
    /** Running state (`PENDING`, `RUNNING`, `DONE`). */
    state: string | undefined;
    /** Final error when the job completed unsuccessfully. */
    errorResult: JobError | undefined;
    /** Query text when this is a query job. */
    query: string | undefined;
    /** Self-link URL. */
    selfLink: string | undefined;
    /** Creator email. */
    userEmail: string | undefined;
    /** Creation time in milliseconds since epoch. */
    creationTime: string | undefined;
    /** Start time in milliseconds since epoch. */
    startTime: string | undefined;
    /** End time in milliseconds since epoch. */
    endTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google BigQuery job — a one-shot query, load, copy, or extract.
 *
 * Jobs are immutable after insert. Changing `jobId`, `location`, labels,
 * or the job configuration replaces the job. BigQuery job ids cannot be
 * reused even after metadata delete, so replacement always creates a new
 * id then deletes the previous generation. Destroy cancels a running job,
 * then deletes its metadata.
 *
 * ### Creating a Job
 * **Example:** GoogleSQL query
 * ```typescript
 * const job = yield* GCP.BigQuery.Job("Count", {
 *   query: { query: "SELECT 1 AS n", useLegacySql: false },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * **Example:** Query into a destination table
 * ```typescript
 * const dataset = yield* GCP.BigQuery.Dataset("Analytics", {
 *   forceDestroy: true,
 * });
 * const table = yield* GCP.BigQuery.Table("Results", {
 *   datasetId: dataset.datasetId,
 *   schema: [{ name: "n", type: "INTEGER" }],
 * });
 * const load = yield* GCP.BigQuery.Job("Seed", {
 *   query: {
 *     query: "SELECT 1 AS n",
 *     useLegacySql: false,
 *     destinationTable: {
 *       projectId: table.project,
 *       datasetId: table.datasetId,
 *       tableId: table.tableId,
 *     },
 *     writeDisposition: "WRITE_TRUNCATE",
 *   },
 * });
 * ```
 *
 * @resource
 * @category BigQuery
 */
export const Job = Resource<Job>("GCP.BigQuery.Job");

export class JobNotResolved extends Data.TaggedError(
  "GCP.BigQuery.JobNotResolved",
)<{
  name: string;
}> {}

export class JobNotDone extends Data.TaggedError("GCP.BigQuery.JobNotDone")<{
  jobId: string;
  state: string | undefined;
}> {}

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const resourceName = (project: string, jobId: string) =>
  `projects/${project}/jobs/${jobId}`;

const normalizeLocation = (location: string | undefined, fallback: string) =>
  (location ?? fallback).toUpperCase();

const toId = (id: string, jobId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (jobId !== undefined) return jobId;
    if (existing !== undefined) return existing;
    return yield* createPhysicalName({
      id,
      maxLength: MAX_JOB_ID_LENGTH,
      lowercase: true,
    });
  });

const jobIdOf = (
  job: bigquery.Job | bigquery.JobListJobsItem,
  fallback: string,
) => job.jobReference?.jobId ?? fallback;

const projectOf = (
  job: bigquery.Job | bigquery.JobListJobsItem,
  fallback: string,
) => job.jobReference?.projectId ?? fallback;

const locationOf = (
  job: bigquery.Job | bigquery.JobListJobsItem,
  fallback: string,
) => job.jobReference?.location ?? fallback;

const stateOf = (job: bigquery.Job | bigquery.JobListJobsItem) => {
  const full = job as bigquery.Job;
  return full.status?.state ?? (job as bigquery.JobListJobsItem).state;
};

const toAttrs = (
  job: bigquery.Job | bigquery.JobListJobsItem,
  fallbackProject: string,
  region: string,
) => {
  const jobId = jobIdOf(job, "");
  const project = projectOf(job, fallbackProject);
  const full = job as bigquery.Job;
  return {
    name: resourceName(project, jobId),
    id: full.id ?? `${project}:${jobId}`,
    jobId,
    project,
    location: locationOf(job, region),
    labels: userLabels(job.configuration?.labels),
    jobType: job.configuration?.jobType,
    state: stateOf(job),
    errorResult:
      full.status?.errorResult ?? (job as bigquery.JobListJobsItem).errorResult,
    query: job.configuration?.query?.query,
    selfLink: full.selfLink,
    userEmail: full.user_email ?? (job as bigquery.JobListJobsItem).user_email,
    creationTime: full.statistics?.creationTime ?? job.statistics?.creationTime,
    startTime: full.statistics?.startTime ?? job.statistics?.startTime,
    endTime: full.statistics?.endTime ?? job.statistics?.endTime,
  };
};

const getByRef = (projectId: string, jobId: string, location: string) =>
  bigquery
    .getJobs({ projectId, jobId, location })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilDone = (projectId: string, jobId: string, location: string) =>
  getByRef(projectId, jobId, location).pipe(
    Effect.flatMap((job) => {
      if (job === undefined) return Effect.succeed(undefined);
      const state = job.status?.state ?? "";
      if (state === "DONE") return Effect.succeed(job);
      return Effect.fail(new JobNotDone({ jobId, state }));
    }),
    Effect.retry({
      while: (error) => error._tag === "GCP.BigQuery.JobNotDone",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const queryBody = (query: JobQuery): JobQuery => ({
  ...query,
  useLegacySql: query.useLegacySql ?? false,
});

const toJobBody = (
  projectId: string,
  jobId: string,
  location: string,
  news: JobProps,
  labels: Record<string, string>,
): bigquery.Job => ({
  jobReference: { projectId, jobId, location },
  configuration: {
    labels,
    query: news.query !== undefined ? queryBody(news.query) : undefined,
    load: news.load,
    copy: news.copy,
    extract: news.extract,
    jobTimeoutMs: news.jobTimeoutMs,
    reservation: news.reservation,
  },
});

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stable(nested)]),
    );
  }
  return value;
};

const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(stable(left ?? null)) ===
  JSON.stringify(stable(right ?? null));

const pickDefined = (
  news: Record<string, unknown>,
  observed: Record<string, unknown>,
) => {
  const next: Record<string, unknown> = {};
  const previous: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(news)) {
    if (value !== undefined) {
      next[key] = value;
      previous[key] = observed[key];
    }
  }
  return { news: next, observed: previous };
};

const nestedChanged = (
  news: Record<string, unknown> | undefined,
  olds: Record<string, unknown> | undefined,
  hadOlds: boolean,
) => {
  if (news === undefined) return false;
  if (olds === undefined) return hadOlds;
  const picked = pickDefined(news, olds);
  return !jsonEqual(picked.news, picked.observed);
};

export const JobProvider = () =>
  Provider.succeed(Job, {
    stables: ["name", "id", "jobId", "project", "location", "creationTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.jobId ?? output?.jobId;
      const jobIdChanged =
        news.jobId !== undefined &&
        previousId !== undefined &&
        news.jobId !== previousId;

      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const locationChanged =
        output !== undefined && previousLocation !== nextLocation;

      const labelsChanged =
        news.labels !== undefined &&
        output !== undefined &&
        !jsonEqual(toLabels(news.labels), output.labels);

      const timeoutChanged =
        news.jobTimeoutMs !== undefined &&
        (olds?.jobTimeoutMs ?? "") !== news.jobTimeoutMs;
      const reservationChanged =
        news.reservation !== undefined &&
        (olds?.reservation ?? "") !== news.reservation;

      const replaced =
        jobIdChanged ||
        locationChanged ||
        labelsChanged ||
        timeoutChanged ||
        reservationChanged ||
        nestedChanged(
          news.query as Record<string, unknown> | undefined,
          olds?.query as Record<string, unknown> | undefined,
          olds !== undefined,
        ) ||
        nestedChanged(
          news.load as Record<string, unknown> | undefined,
          olds?.load as Record<string, unknown> | undefined,
          olds !== undefined,
        ) ||
        nestedChanged(
          news.copy as Record<string, unknown> | undefined,
          olds?.copy as Record<string, unknown> | undefined,
          olds !== undefined,
        ) ||
        nestedChanged(
          news.extract as Record<string, unknown> | undefined,
          olds?.extract as Record<string, unknown> | undefined,
          olds !== undefined,
        );

      if (!replaced) return undefined;
      // Job ids cannot be reused after delete (the API returns NotFound on
      // insert of a retired id), so never delete-first.
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const jobId = yield* toId(id, olds?.jobId, output?.jobId);
      const location = olds?.location ?? output?.location ?? env.region;
      const project = output?.project ?? env.project;
      const existing = yield* getByRef(project, jobId, location);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, project, env.region);
      return (yield* hasAlchemyLabels(
        id,
        tagRecord(existing.configuration?.labels),
      ))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* bigquery.listJobs
          .pages({
            projectId: env.project,
            maxResults: 1000,
            projection: "full",
            allUsers: true,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.jobs ?? [])),
            Stream.filter((job) =>
              Object.keys(job.configuration?.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            ),
            Stream.map((job) => toAttrs(job, env.project, env.region)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("Forbidden", () =>
              bigquery.listJobs
                .pages({
                  projectId: env.project,
                  maxResults: 1000,
                  projection: "full",
                })
                .pipe(
                  Stream.flatMap((page) =>
                    Stream.fromIterable(page.jobs ?? []),
                  ),
                  Stream.filter((job) =>
                    Object.keys(job.configuration?.labels ?? {}).some((key) =>
                      key.startsWith("alchemy-"),
                    ),
                  ),
                  Stream.map((job) => toAttrs(job, env.project, env.region)),
                  Stream.runCollect,
                  Effect.map((chunk) => Array.from(chunk)),
                ),
            ),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as ReturnType<typeof toAttrs>[]),
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const jobId = yield* toId(id, news.jobId, output?.jobId);
      const location = news.location ?? output?.location ?? env.region;
      const project = output?.project ?? env.project;
      const name = resourceName(project, jobId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByRef(project, jobId, location);

      if (current === undefined) {
        const created = yield* bigquery
          .insertJobs({
            projectId: project,
            body: toJobBody(project, jobId, location, news, desiredLabels),
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getByRef(project, jobId, location),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new JobNotResolved({ name });
      }

      const state = current.status?.state ?? "";
      if (state !== "DONE") {
        current = (yield* waitUntilDone(project, jobId, location)) ?? current;
      }

      return toAttrs(current, project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const state = output.state ?? "";
      if (state === "PENDING" || state === "RUNNING") {
        yield* bigquery
          .cancelJobs({
            projectId: output.project,
            jobId: output.jobId,
            location: output.location,
          })
          .pipe(
            Effect.catchTag("NotFound", () => Effect.void),
            Effect.catchTag("BadRequest", () => Effect.void),
          );
        yield* waitUntilDone(
          output.project,
          output.jobId,
          output.location,
        ).pipe(Effect.catchTag("GCP.BigQuery.JobNotDone", () => Effect.void));
      }
      yield* bigquery
        .deleteJobs({
          projectId: output.project,
          jobId: output.jobId,
          location: output.location,
        })
        .pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "Conflict" || error._tag === "BadRequest",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.void),
        );
    }),
  });
