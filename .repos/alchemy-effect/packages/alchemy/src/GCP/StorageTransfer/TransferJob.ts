import * as storagetransfer from "@distilled.cloud/gcp/storagetransfer_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createOwnership,
  DEFAULT_JOB_STATUS,
  encodeOwnership,
  fieldMask,
  getTransferJob,
  hasOwnershipMarker,
  isDeletedJob,
  jobIdOf,
  listTransferJobs,
  ownedByAlchemy,
  parseOwnership,
  retryApiDisabled,
  sameValue,
  sanitizeJobId,
  toJobId,
  transferJobName,
} from "./internal.ts";

export type GcsData = storagetransfer.GcsData;
export type PosixFilesystem = storagetransfer.PosixFilesystem;
export type AwsS3Data = storagetransfer.AwsS3Data;
export type HttpData = storagetransfer.HttpData;
export type AzureBlobStorageData = storagetransfer.AzureBlobStorageData;
export type AwsS3CompatibleData = storagetransfer.AwsS3CompatibleData;
export type HdfsData = storagetransfer.HdfsData;
export type ObjectConditions = storagetransfer.ObjectConditions;
export type TransferOptions = storagetransfer.TransferOptions;
export type TransferManifest = storagetransfer.TransferManifest;
export type TransferSpec = storagetransfer.TransferSpec;
export type ReplicationSpec = storagetransfer.ReplicationSpec;
export type NotificationConfig = storagetransfer.NotificationConfig;
export type LoggingConfig = storagetransfer.LoggingConfig;
export type Schedule = storagetransfer.Schedule;
export type EventStream = storagetransfer.EventStream;
export type TransferJobStatus =
  | storagetransfer.TransferJobStatusEnum
  | (string & {});

export type TransferJobProps = {
  /**
   * Job id (the `{job}` segment of `transferJobs/{job}`). If omitted, a
   * unique name is generated from the stack, stage, and logical id. The
   * API name is `transferJobs/{job}` (max 128 characters, must not start
   * with `transferJobs/OPI` unless this is a POSIX transfer). Immutable
   * — changing it replaces the job.
   */
  jobId?: string;
  /**
   * User description (max 1024 bytes). Transfer jobs have no labels
   * field, so Alchemy ownership is stored in a `[alchemy …]` prefix and
   * stripped from attributes.
   */
  description?: string;
  /**
   * Transfer specification (source, sink, filters, options). Required
   * unless `replicationSpec` is set. Updates in place; a complete spec
   * must be provided on each update.
   */
  transferSpec?: TransferSpec;
  /**
   * Cross-bucket replication specification. Mutually exclusive with
   * `transferSpec`. Immutable after create — changing it replaces the
   * job.
   */
  replicationSpec?: ReplicationSpec;
  /**
   * Recurring or one-time schedule. Optional; omit to create a job that
   * never auto-runs (invoke `RunTransferJob` instead). Immutable after
   * create — changing it replaces the job.
   */
  schedule?: Schedule;
  /**
   * Event-driven transfer stream. When set, `schedule` is ignored.
   * Immutable after create — changing it replaces the job.
   */
  eventStream?: EventStream;
  /**
   * Pub/Sub notification configuration. Updates in place.
   */
  notificationConfig?: NotificationConfig;
  /**
   * Cloud Logging configuration. Updates in place.
   */
  loggingConfig?: LoggingConfig;
  /**
   * Job status. Must be `ENABLED` or `DISABLED` on create (the API
   * rejects `STATUS_UNSPECIFIED`). `DELETED` is applied by delete.
   * @default "ENABLED"
   */
  status?: TransferJobStatus;
  /**
   * User-managed service account that receives bucket permissions
   * instead of the Transfer Service agent. Email or unique id. Immutable
   * after create — changing it replaces the job.
   */
  serviceAccount?: string;
};

export type TransferJob = Resource<
  "GCP.StorageTransfer.TransferJob",
  TransferJobProps,
  {
    /** Full resource name `transferJobs/{job}`. */
    name: string;
    /** Job id (path segment after `transferJobs/`). */
    jobId: string;
    /** Project id. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Job status (`ENABLED`, `DISABLED`, `DELETED`). */
    status: string | undefined;
    /** Transfer specification. */
    transferSpec: TransferSpec | undefined;
    /** Replication specification. */
    replicationSpec: ReplicationSpec | undefined;
    /** Notification configuration. */
    notificationConfig: NotificationConfig | undefined;
    /** Logging configuration. */
    loggingConfig: LoggingConfig | undefined;
    /** Schedule, if any. */
    schedule: Schedule | undefined;
    /** Event stream, if any. */
    eventStream: EventStream | undefined;
    /** Delegated service account, if any. */
    serviceAccount: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTime: string | undefined;
    /** RFC3339 last-modification timestamp. */
    lastModificationTime: string | undefined;
    /** Most recently started TransferOperation name, if any. */
    latestOperationName: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Storage Transfer Service job that copies objects between Cloud
 * Storage, S3, Azure, POSIX, or HTTP sources and sinks.
 *
 * Transfer jobs have no labels field, so Alchemy stamps ownership into
 * `description` for `list` / nuke. Name is identity. `description`,
 * `transferSpec`, `notificationConfig`, `loggingConfig`, and `status`
 * update in place. `schedule`, `eventStream`, `serviceAccount`, and
 * `replicationSpec` are immutable after create.
 *
 * ### Creating a Transfer Job
 * **Example:** One-shot GCS-to-GCS copy (disabled until RunTransferJob)
 * ```typescript
 * const job = yield* GCP.StorageTransfer.TransferJob("Nightly", {
 *   status: "DISABLED",
 *   description: "copy uploads into the archive bucket",
 *   transferSpec: {
 *     gcsDataSource: { bucketName: source.bucketName },
 *     gcsDataSink: { bucketName: archive.bucketName },
 *   },
 * });
 * ```
 *
 * **Example:** Recurring copy with a daily schedule
 * ```typescript
 * const job = yield* GCP.StorageTransfer.TransferJob("Nightly", {
 *   description: "daily archive",
 *   transferSpec: {
 *     gcsDataSource: { bucketName: "src-bucket", path: "uploads/" },
 *     gcsDataSink: { bucketName: "dst-bucket" },
 *   },
 *   schedule: {
 *     scheduleStartDate: { year: 2026, month: 1, day: 1 },
 *     startTimeOfDay: { hours: 3, minutes: 0 },
 *     repeatInterval: "86400s",
 *   },
 * });
 * ```
 *
 * ### Updating a Transfer Job
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Enable the job and change the source prefix
 * ```typescript
 * const job = yield* GCP.StorageTransfer.TransferJob("Nightly", {
 *   status: "ENABLED",
 *   description: "daily archive",
 *   transferSpec: {
 *     gcsDataSource: { bucketName: "src-bucket", path: "inbox/" },
 *     gcsDataSink: { bucketName: "dst-bucket" },
 *   },
 * });
 * ```
 *
 * @resource
 * @category StorageTransfer
 */
export const TransferJob = Resource<TransferJob>(
  "GCP.StorageTransfer.TransferJob",
);

export class TransferJobNotResolved extends Data.TaggedError(
  "GCP.StorageTransfer.TransferJobNotResolved",
)<{
  name: string;
}> {}

const statusOf = (status: string | undefined) =>
  status && status.length > 0 ? status : DEFAULT_JOB_STATUS;

const toAttrs = (job: storagetransfer.TransferJob, project: string) => {
  const name = job.name ?? "";
  return {
    name,
    jobId: jobIdOf(name),
    project: job.projectId ?? project,
    description: parseOwnership(job.description).text,
    status: job.status,
    transferSpec: job.transferSpec,
    replicationSpec: job.replicationSpec,
    notificationConfig: job.notificationConfig,
    loggingConfig: job.loggingConfig,
    schedule: job.schedule,
    eventStream: job.eventStream,
    serviceAccount: job.serviceAccount,
    creationTime: job.creationTime,
    lastModificationTime: job.lastModificationTime,
    latestOperationName: job.latestOperationName,
  };
};

const replaceOnImmutable = (
  news: TransferJobProps,
  previous: TransferJobProps | undefined,
  output:
    | {
        jobId?: string;
        schedule?: Schedule;
        eventStream?: EventStream;
        serviceAccount?: string;
        replicationSpec?: ReplicationSpec;
      }
    | undefined,
) => {
  const previousId = previous?.jobId ?? output?.jobId;
  const nextId =
    news.jobId !== undefined ? sanitizeJobId(news.jobId) : previousId;
  if (
    previousId !== undefined &&
    nextId !== undefined &&
    previousId !== nextId
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (output === undefined && previous === undefined) return undefined;
  const observedSchedule = previous?.schedule ?? output?.schedule;
  const observedStream = previous?.eventStream ?? output?.eventStream;
  const observedAccount = previous?.serviceAccount ?? output?.serviceAccount;
  const observedReplication =
    previous?.replicationSpec ?? output?.replicationSpec;
  if (!sameValue(news.schedule, observedSchedule)) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (!sameValue(news.eventStream, observedStream)) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if ((news.serviceAccount ?? "") !== (observedAccount ?? "")) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (!sameValue(news.replicationSpec, observedReplication)) {
    return { action: "replace" as const, deleteFirst: false };
  }
  return undefined;
};

const toCreateBody = (
  name: string,
  projectId: string,
  news: TransferJobProps,
  description: string,
): storagetransfer.TransferJob => ({
  name,
  projectId,
  description,
  transferSpec: news.transferSpec,
  replicationSpec: news.replicationSpec,
  notificationConfig: news.notificationConfig,
  loggingConfig: news.loggingConfig,
  schedule: news.schedule,
  eventStream: news.eventStream,
  serviceAccount: news.serviceAccount,
  status: statusOf(news.status),
});

export const TransferJobProvider = () =>
  Provider.succeed(TransferJob, {
    stables: ["name", "jobId", "project", "creationTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnImmutable(news, olds, output);
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const jobId = yield* toJobId(id, olds?.jobId, output?.jobId);
      const name = output?.name ?? transferJobName(jobId);
      const existing = yield* getTransferJob(name, env.project);
      if (existing === undefined || isDeletedJob(existing)) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const jobs = yield* listTransferJobs(env.project);
        return jobs
          .filter(
            (job) => !isDeletedJob(job) && hasOwnershipMarker(job.description),
          )
          .map((job) => toAttrs(job, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const jobId = yield* toJobId(id, news.jobId, output?.jobId);
      const name = transferJobName(jobId);
      const ownership = yield* createOwnership(id);
      const desiredDescription = encodeOwnership(ownership, news.description);
      const desiredStatus = statusOf(news.status);

      let current = yield* getTransferJob(output?.name ?? name, env.project);

      if (current === undefined) {
        const created = yield* retryApiDisabled(
          storagetransfer.createTransferJobs({
            body: toCreateBody(name, env.project, news, desiredDescription),
          }),
        ).pipe(
          Effect.catchTag("Conflict", () => getTransferJob(name, env.project)),
        );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new TransferJobNotResolved({ name });
      }

      if (isDeletedJob(current)) {
        current = yield* storagetransfer.patchTransferJobs({
          jobName: current.name ?? name,
          body: {
            projectId: env.project,
            updateTransferJobFieldMask: fieldMask([
              "description",
              news.transferSpec !== undefined ? "transfer_spec" : undefined,
              news.notificationConfig !== undefined
                ? "notification_config"
                : undefined,
              news.loggingConfig !== undefined ? "logging_config" : undefined,
              "status",
            ]),
            transferJob: {
              description: desiredDescription,
              transferSpec: news.transferSpec,
              notificationConfig: news.notificationConfig,
              loggingConfig: news.loggingConfig,
              status: desiredStatus,
            },
          },
        });
      }

      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const specChanged = !sameValue(current.transferSpec, news.transferSpec);
      const notificationChanged = !sameValue(
        current.notificationConfig,
        news.notificationConfig,
      );
      const loggingChanged = !sameValue(
        current.loggingConfig,
        news.loggingConfig,
      );
      const statusChanged = (current.status ?? "") !== desiredStatus;
      const updateMask = fieldMask([
        descriptionChanged ? "description" : undefined,
        specChanged && news.transferSpec !== undefined
          ? "transfer_spec"
          : undefined,
        notificationChanged ? "notification_config" : undefined,
        loggingChanged ? "logging_config" : undefined,
        statusChanged ? "status" : undefined,
      ]);

      if (updateMask.length > 0) {
        current = yield* storagetransfer.patchTransferJobs({
          jobName: current.name ?? name,
          body: {
            projectId: env.project,
            updateTransferJobFieldMask: updateMask,
            transferJob: {
              description: desiredDescription,
              transferSpec: news.transferSpec,
              notificationConfig: news.notificationConfig,
              loggingConfig: news.loggingConfig,
              status: desiredStatus,
            },
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* storagetransfer
        .deleteTransferJobs({
          jobName: output.name,
          projectId: output.project,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
