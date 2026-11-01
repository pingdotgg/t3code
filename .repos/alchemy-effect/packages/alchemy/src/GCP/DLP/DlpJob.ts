import * as dlp from "@distilled.cloud/gcp/dlp_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  encodeOwnership,
  hasHybridOwnership,
  hybridLabels,
  jsonEqual,
  lastSegment,
  projectOf,
  replaceOnIdentity,
  toResourceId,
} from "./internal.ts";

export type RiskAnalysisJobConfig = dlp.GooglePrivacyDlpV2RiskAnalysisJobConfig;

export type DlpJobProps = {
  /**
   * Job id (the `{dlpJob}` segment of `projects/{project}/dlpJobs/{dlpJob}`).
   * If omitted, a unique name is generated. Must match `[a-zA-Z0-9_-]+`
   * and is at most 100 characters. Immutable — changing it replaces the
   * job.
   */
  jobId?: string;
  /**
   * Inspect-job configuration. Mutually exclusive with `riskJob`.
   * Hybrid storage is the recommended test shape: Alchemy stamps
   * ownership into `hybridOptions.labels` for `list` / nuke.
   */
  inspectJob?: dlp.GooglePrivacyDlpV2InspectJobConfig;
  /**
   * Risk-analysis job configuration. Mutually exclusive with
   * `inspectJob`.
   */
  riskJob?: RiskAnalysisJobConfig;
};

export type DlpJob = Resource<
  "GCP.DLP.DlpJob",
  DlpJobProps,
  {
    /** Full resource name `projects/{project}/dlpJobs/{id}`. */
    name: string;
    /** Job id (last path segment). */
    jobId: string;
    /** Project id. */
    project: string;
    /** Job type (`INSPECT_JOB` or `RISK_ANALYSIS_JOB`). */
    type: string | undefined;
    /** Job state (`PENDING`, `RUNNING`, `DONE`, …). */
    state: string | undefined;
    /** Inspect-job snapshot, if this is an inspect job. */
    inspectJob: dlp.GooglePrivacyDlpV2InspectJobConfig | undefined;
    /** Trigger that created the job, if any. */
    jobTriggerName: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 start timestamp. */
    startTime: string | undefined;
    /** RFC3339 end timestamp. */
    endTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A project-scoped Cloud DLP inspect or risk-analysis job.
 *
 * DLP jobs have no labels or description field. For inspect jobs Alchemy
 * stamps ownership into `storageConfig.hybridOptions.labels` so `list` /
 * nuke can find them. Jobs are not updatable — changing `jobId`,
 * `inspectJob`, or `riskJob` replaces the job.
 *
 * ### Creating a DLP Job
 * **Example:** Hybrid inspect job
 * ```typescript
 * const job = yield* GCP.DLP.DlpJob("Scan", {
 *   inspectJob: {
 *     inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
 *     storageConfig: { hybridOptions: { description: "hybrid scan" } },
 *   },
 * });
 * ```
 *
 * @resource
 * @category DLP
 */
export const DlpJob = Resource<DlpJob>("GCP.DLP.DlpJob");

export class DlpJobNotResolved extends Data.TaggedError(
  "GCP.DLP.DlpJobNotResolved",
)<{
  name: string;
}> {}

const MAX_JOB_ID_LENGTH = 64;

const stripJobPrefix = (jobId: string) => jobId.replace(/^[ir]-/, "");

const prefixedJobId = (jobId: string, risk: boolean) => {
  const bare = stripJobPrefix(jobId).slice(0, MAX_JOB_ID_LENGTH - 2);
  return `${risk ? "r" : "i"}-${bare}`;
};

const resourceName = (project: string, jobId: string, risk: boolean) =>
  `projects/${project}/dlpJobs/${prefixedJobId(jobId, risk)}`;

const observedInspectJob = (job: dlp.GooglePrivacyDlpV2DlpJob) =>
  job.inspectDetails?.requestedOptions?.jobConfig;

const observedHybridLabels = (job: dlp.GooglePrivacyDlpV2DlpJob) =>
  observedInspectJob(job)?.storageConfig?.hybridOptions?.labels;

const stampInspectJob = (
  inspectJob: dlp.GooglePrivacyDlpV2InspectJobConfig | undefined,
  ownership: Record<string, string>,
): dlp.GooglePrivacyDlpV2InspectJobConfig | undefined => {
  if (inspectJob === undefined) return undefined;
  const hybrid = inspectJob.storageConfig?.hybridOptions;
  const storage = inspectJob.storageConfig;
  const usingOtherStorage =
    storage?.cloudStorageOptions !== undefined ||
    storage?.bigQueryOptions !== undefined ||
    storage?.datastoreOptions !== undefined;
  if (usingOtherStorage && hybrid === undefined) return inspectJob;
  return {
    ...inspectJob,
    storageConfig: {
      ...storage,
      hybridOptions: {
        ...hybrid,
        labels: {
          ...hybrid?.labels,
          ...hybridLabels(ownership),
        },
        description: encodeOwnership(ownership, hybrid?.description),
      },
    },
  };
};

const toAttrs = (job: dlp.GooglePrivacyDlpV2DlpJob, project: string) => {
  const name = job.name ?? "";
  return {
    name,
    jobId: lastSegment(name),
    project: projectOf(name) || project,
    type: job.type,
    state: job.state,
    inspectJob: observedInspectJob(job),
    jobTriggerName: job.jobTriggerName,
    createTime: job.createTime,
    startTime: job.startTime,
    endTime: job.endTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dlp
        .getProjectsDlpJobs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const DlpJobProvider = () =>
  Provider.succeed(DlpJob, {
    stables: ["name", "jobId", "project", "type", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = olds?.jobId ?? output?.jobId;
      const idChanged =
        previous !== undefined &&
        news.jobId !== undefined &&
        news.jobId !== previous;
      const inspectChanged =
        olds !== undefined && !jsonEqual(olds.inspectJob, news.inspectJob);
      const riskChanged =
        olds !== undefined && !jsonEqual(olds.riskJob, news.riskJob);
      return replaceOnIdentity(idChanged || inspectChanged || riskChanged);
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const jobId = yield* toResourceId(
        id,
        olds?.jobId !== undefined ? stripJobPrefix(olds.jobId) : undefined,
        output?.jobId !== undefined ? stripJobPrefix(output.jobId) : undefined,
      );
      const risk =
        olds?.riskJob !== undefined || output?.type === "RISK_ANALYSIS_JOB";
      const name = output?.name ?? resourceName(env.project, jobId, risk);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      if (output !== undefined && output.name === attrs.name) return attrs;
      const labels = observedHybridLabels(existing);
      return hasHybridOwnership(labels) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          dlp.listProjectsDlpJobs.pages({
            parent: `projects/${env.project}`,
            pageSize: 100,
            type: "INSPECT_JOB",
          }),
          (page) => page.jobs,
        ).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed([] as dlp.GooglePrivacyDlpV2DlpJob[]),
          ),
        );
        return items
          .filter((job) => hasHybridOwnership(observedHybridLabels(job)))
          .map((job) => toAttrs(job, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const jobId = yield* toResourceId(
        id,
        news.jobId !== undefined ? stripJobPrefix(news.jobId) : undefined,
        output?.jobId !== undefined ? stripJobPrefix(output.jobId) : undefined,
      );
      const risk = news.riskJob !== undefined;
      const name = resourceName(env.project, jobId, risk);
      const ownership = yield* createInternalLabels(id);
      const inspectJob = stampInspectJob(news.inspectJob, ownership);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dlp
          .createProjectsDlpJobs({
            parent: `projects/${env.project}`,
            body: {
              jobId: prefixedJobId(jobId, risk),
              inspectJob,
              riskJob: news.riskJob,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DlpJobNotResolved({ name });
      }

      if (
        inspectJob !== undefined &&
        observedHybridLabels(current) === undefined
      ) {
        current = yield* getByName(current.name ?? name).pipe(
          Effect.filterOrFail(
            (job) =>
              job !== undefined &&
              (observedHybridLabels(job) !== undefined ||
                job.state === "FAILED" ||
                job.state === "DONE" ||
                job.state === "CANCELED"),
            () => new DlpJobNotResolved({ name }),
          ),
          Effect.retry({
            while: (error) => error._tag === "GCP.DLP.DlpJobNotResolved",
            times: 8,
            schedule: Schedule.spaced("1 second"),
          }),
          Effect.catchTag("GCP.DLP.DlpJobNotResolved", () =>
            Effect.succeed(current),
          ),
        );
      }

      if (current === undefined) {
        return yield* new DlpJobNotResolved({ name });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dlp
        .deleteProjectsDlpJobs({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
