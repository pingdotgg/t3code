import * as dlp from "@distilled.cloud/gcp/dlp_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, stripInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  collectPages,
  encodeOwnership,
  hasHybridOwnership,
  hasOwnershipMarker,
  hybridLabels,
  jsonEqual,
  lastSegment,
  locationOf,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
} from "./internal.ts";

type InspectJobConfig = dlp.GooglePrivacyDlpV2InspectJobConfig;
type RiskAnalysisJobConfig = dlp.GooglePrivacyDlpV2RiskAnalysisJobConfig;

const LOCATION = "global";
const MAX_JOB_ID_LENGTH = 64;

const stripJobPrefix = (jobId: string) => jobId.replace(/^[ir]-/, "");

const prefixedJobId = (jobId: string, risk: boolean) => {
  const bare = stripJobPrefix(jobId);
  return `${risk ? "r" : "i"}-${bare}`;
};

const toJobId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined) {
      return stripJobPrefix(requested).slice(0, MAX_JOB_ID_LENGTH);
    }
    if (existing !== undefined) return stripJobPrefix(existing);
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_JOB_ID_LENGTH,
      lowercase: true,
    });
    const next = /^[a-zA-Z]/.test(generated) ? generated : `d${generated}`;
    return next.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, MAX_JOB_ID_LENGTH);
  });

const DEFAULT_INSPECT_JOB: InspectJobConfig = {
  inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
  storageConfig: { hybridOptions: {} },
};

export type LocationsDlpJobProps = {
  /**
   * Job id (the `{dlpJob}` segment of
   * `projects/{project}/locations/{location}/dlpJobs/{dlpJob}`). If
   * omitted, a unique name is generated. Must match `[a-zA-Z0-9_-]+` and
   * is at most 64 characters. Immutable — changing it replaces the job.
   */
  jobId?: string;
  /**
   * Processing location (`global`, `us`, `europe-west1`, …). Immutable —
   * changing it replaces the job. `us-central1` is not a valid DLP job
   * location.
   * @default "global"
   */
  location?: string;
  /**
   * Inspect-job configuration. Defaults to a hybrid EMAIL_ADDRESS
   * inspect job. DlpJob has no update API — changing this replaces the
   * job.
   */
  inspectJob?: InspectJobConfig;
  /**
   * Risk-analysis job configuration. Mutually exclusive with
   * `inspectJob`. Immutable after create.
   */
  riskJob?: RiskAnalysisJobConfig;
};

export type LocationsDlpJob = Resource<
  "GCP.DLP.LocationsDlpJob",
  LocationsDlpJobProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/dlpJobs/{id}`. */
    name: string;
    /** Job id (last path segment). */
    jobId: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** Job type (`INSPECT_JOB` or `RISK_ANALYSIS_JOB`). */
    type: string | undefined;
    /** Job state (`PENDING`, `RUNNING`, `ACTIVE`, `DONE`, …). */
    state: string | undefined;
    /** Inspect-job configuration, Alchemy labels stripped. */
    inspectJob: InspectJobConfig | undefined;
    /** Risk-analysis job configuration. */
    riskJob: RiskAnalysisJobConfig | undefined;
    /** Trigger that created this job, if any. */
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
 * A regional Cloud DLP job (`projects.locations.dlpJobs`).
 *
 * Creating a DlpJob starts it immediately. Inspect jobs are stored as
 * `i-{jobId}` and risk jobs as `r-{jobId}`. There is no update API, so
 * reconcile is observe-ensure (create if missing). Delete cancels a
 * running/active job, then deletes it. DLP jobs have no labels field —
 * Alchemy stamps ownership into hybrid inspect `storageConfig.hybridOptions`
 * (labels + description) so `list` / nuke can find them.
 *
 * ### Creating a DLP Job
 * **Example:** Hybrid inspect job
 * ```typescript
 * const job = yield* GCP.DLP.LocationsDlpJob("Scan", {
 *   inspectJob: {
 *     inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
 *     storageConfig: { hybridOptions: { description: "inbox" } },
 *   },
 * });
 * ```
 *
 * @resource
 * @category DLP
 */
export const LocationsDlpJob = Resource<LocationsDlpJob>(
  "GCP.DLP.LocationsDlpJob",
);

export class LocationsDlpJobNotResolved extends Data.TaggedError(
  "GCP.DLP.LocationsDlpJobNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  project: string,
  location: string,
  jobId: string,
  risk = false,
) =>
  `${locationParent(project, location)}/dlpJobs/${prefixedJobId(jobId, risk)}`;

const stampInspectJob = (
  inspectJob: InspectJobConfig | undefined,
  ownership: Record<string, string>,
): InspectJobConfig | undefined => {
  if (inspectJob === undefined) return undefined;
  const storage = inspectJob.storageConfig;
  const isHybrid =
    storage === undefined ||
    storage.hybridOptions !== undefined ||
    (storage.cloudStorageOptions === undefined &&
      storage.bigQueryOptions === undefined &&
      storage.datastoreOptions === undefined);
  if (!isHybrid) return inspectJob;
  const userHybrid = storage?.hybridOptions ?? {};
  return {
    ...inspectJob,
    storageConfig: {
      ...storage,
      hybridOptions: {
        ...userHybrid,
        labels: {
          ...tagRecord(userHybrid.labels),
          ...hybridLabels(ownership),
        },
        description: encodeOwnership(ownership, userHybrid.description),
      },
    },
  };
};

const userInspectJob = (
  inspectJob: InspectJobConfig | undefined,
): InspectJobConfig | undefined => {
  if (inspectJob === undefined) return undefined;
  const hybrid = inspectJob.storageConfig?.hybridOptions;
  if (hybrid === undefined) return inspectJob;
  const parsed = parseOwnership(hybrid.description);
  return {
    ...inspectJob,
    storageConfig: {
      ...inspectJob.storageConfig,
      hybridOptions: {
        ...hybrid,
        description: parsed.text,
        labels: stripInternalLabels(tagRecord(hybrid.labels)),
      },
    },
  };
};

const hybridOf = (job: dlp.GooglePrivacyDlpV2DlpJob) =>
  job.inspectDetails?.requestedOptions?.jobConfig?.storageConfig?.hybridOptions;

const jobOwned = (job: dlp.GooglePrivacyDlpV2DlpJob) => {
  const hybrid = hybridOf(job);
  return (
    hasOwnershipMarker(hybrid?.description) ||
    hasHybridOwnership(hybrid?.labels)
  );
};

const toAttrs = (job: dlp.GooglePrivacyDlpV2DlpJob, project: string) => {
  const name = job.name ?? "";
  return {
    name,
    jobId: lastSegment(name),
    location: locationOf(name, LOCATION),
    project,
    type: job.type,
    state: job.state,
    inspectJob: userInspectJob(job.inspectDetails?.requestedOptions?.jobConfig),
    riskJob: job.riskDetails?.requestedOptions?.jobConfig,
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
        .getProjectsLocationsDlpJobs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listType = (parent: string, type: "INSPECT_JOB" | "RISK_ANALYSIS_JOB") =>
  collectPages(
    dlp.listProjectsLocationsDlpJobs.pages({
      parent,
      pageSize: 100,
      type,
    }),
    (page) => page.jobs,
  ).pipe(
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as dlp.GooglePrivacyDlpV2DlpJob[]),
    ),
  );

export const LocationsDlpJobProvider = () =>
  Provider.succeed(LocationsDlpJob, {
    stables: ["name", "jobId", "location", "project", "createTime", "type"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.jobId ?? output?.jobId;
      const idChanged =
        previousId !== undefined &&
        news.jobId !== undefined &&
        news.jobId !== previousId;
      const previousLocation = olds?.location ?? output?.location;
      const locationChanged =
        previousLocation !== undefined &&
        normalizeLocation(news.location, LOCATION) !==
          normalizeLocation(previousLocation, LOCATION);
      const inspectChanged =
        output !== undefined &&
        news.inspectJob !== undefined &&
        !jsonEqual(userInspectJob(news.inspectJob), output.inspectJob);
      const riskChanged =
        output !== undefined &&
        news.riskJob !== undefined &&
        !jsonEqual(news.riskJob, output.riskJob);
      if (idChanged || locationChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (inspectChanged || riskChanged) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        LOCATION,
      );
      const jobId = yield* toJobId(id, olds?.jobId, output?.jobId);
      const name =
        output?.name ??
        resourceName(
          env.project,
          location,
          jobId,
          olds?.riskJob !== undefined || output?.type === "RISK_ANALYSIS_JOB",
        );
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const hybrid = hybridOf(existing);
      const owned = yield* ownedByAlchemy(id, hybrid?.description);
      return owned || hasHybridOwnership(hybrid?.labels)
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const parent = locationParent(env.project, LOCATION);
        const inspect = yield* listType(parent, "INSPECT_JOB");
        const risk = yield* listType(parent, "RISK_ANALYSIS_JOB");
        const rows = yield* Effect.forEach(
          [...inspect, ...risk],
          (job) =>
            Effect.gen(function* () {
              let current = job;
              if (
                current.inspectDetails === undefined &&
                current.riskDetails === undefined &&
                current.name
              ) {
                current = (yield* getByName(current.name)) ?? current;
              }
              if (!jobOwned(current)) return undefined;
              return toAttrs(current, env.project);
            }),
          { concurrency: 8 },
        );
        return rows.filter((row) => row !== undefined);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        LOCATION,
      );
      const jobId = yield* toJobId(id, news.jobId, output?.jobId);
      const name = resourceName(
        env.project,
        location,
        jobId,
        news.riskJob !== undefined,
      );
      const ownership = yield* createInternalLabels(id);
      const inspectJob = stampInspectJob(
        news.riskJob === undefined
          ? (news.inspectJob ?? DEFAULT_INSPECT_JOB)
          : news.inspectJob,
        ownership,
      );

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dlp
          .createProjectsLocationsDlpJobs({
            parent: locationParent(env.project, location),
            body: {
              jobId,
              inspectJob,
              riskJob: news.riskJob,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new LocationsDlpJobNotResolved({ name });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dlp
        .cancelProjectsLocationsDlpJobs({ name: output.name, body: {} })
        .pipe(
          Effect.catchTag(
            ["NotFound", "BadRequest", "Conflict"],
            () => Effect.void,
          ),
        );
      yield* dlp.deleteProjectsLocationsDlpJobs({ name: output.name }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.retry({
          while: (e) => e._tag === "BadRequest" || e._tag === "Conflict",
          times: 8,
          schedule: Schedule.exponential("500 millis"),
        }),
      );
    }),
  });
