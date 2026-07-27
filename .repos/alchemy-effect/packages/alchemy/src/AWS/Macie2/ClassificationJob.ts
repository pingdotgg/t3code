import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  tagRecord,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { retryThroughEnablement } from "./common.ts";

/**
 * Whether the classification job runs once (`ONE_TIME`) or on a recurring
 * schedule (`SCHEDULED`).
 */
export type JobType = "ONE_TIME" | "SCHEDULED";

/**
 * How Macie selects managed data identifiers for the job.
 */
export type ManagedDataIdentifierSelector =
  | "ALL"
  | "EXCLUDE"
  | "INCLUDE"
  | "NONE"
  | "RECOMMENDED";

/**
 * A set of S3 buckets (within one account) that the job analyzes.
 */
export interface BucketDefinition {
  /** The account that owns the buckets. */
  accountId: string;
  /** The names of the buckets to analyze. */
  buckets: string[];
}

export interface ClassificationJobProps {
  /**
   * Custom name for the job. Must be unique per account. If omitted, a unique
   * name is generated from the app/stage/logical ID.
   */
  name?: string;

  /**
   * Whether the job runs once (`ONE_TIME`) or on a recurring schedule
   * (`SCHEDULED`).
   * @default "ONE_TIME"
   */
  jobType?: JobType;

  /**
   * The S3 buckets to analyze, grouped by owning account. Changing this
   * replaces the job — classification jobs are immutable once created.
   */
  bucketDefinitions: BucketDefinition[];

  /**
   * Optional description of the job.
   */
  description?: string;

  /**
   * The sampling depth, as a percentage, applied to objects in the buckets.
   * @default 100
   */
  samplingPercentage?: number;

  /**
   * For a scheduled job, whether Macie analyzes all existing eligible objects
   * immediately on the first run.
   */
  initialRun?: boolean;

  /**
   * How Macie selects managed data identifiers for the job.
   */
  managedDataIdentifierSelector?: ManagedDataIdentifierSelector;

  /**
   * Tags applied to the job. Alchemy ownership tags are merged in automatically.
   */
  tags?: Record<string, string>;
}

/** @resource */
export interface ClassificationJob extends Resource<
  "AWS.Macie2.ClassificationJob",
  ClassificationJobProps,
  {
    /** Generated job ID. */
    jobId: string;
    /** ARN of the classification job. */
    jobArn: string;
    /** The resolved job name. */
    name: string;
    /** Current job status (`RUNNING` / `COMPLETE` / `CANCELLED` / ...). */
    jobStatus: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon Macie classification job — scans one or more S3 buckets for
 * sensitive data. Requires Macie to be enabled for the account (see
 * `Macie2.Session`). Jobs are immutable once created; changing the job type,
 * name, or bucket set replaces the job. Destroy cancels the job.
 *
 * @section Creating a classification job
 * @example One-time job over a bucket
 * ```typescript
 * const job = yield* Macie2.ClassificationJob("Scan", {
 *   jobType: "ONE_TIME",
 *   bucketDefinitions: [{ accountId, buckets: ["my-bucket"] }],
 * });
 * ```
 *
 * @example Sampled scan with a description
 * ```typescript
 * const job = yield* Macie2.ClassificationJob("Scan", {
 *   jobType: "ONE_TIME",
 *   bucketDefinitions: [{ accountId, buckets: ["my-bucket"] }],
 *   samplingPercentage: 20,
 *   description: "PII sweep",
 * });
 * ```
 */
const ClassificationJobResource = Resource<ClassificationJob>(
  "AWS.Macie2.ClassificationJob",
);

export { ClassificationJobResource as ClassificationJob };

const createName = (id: string, props: Partial<ClassificationJobProps>) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({ id, maxLength: 200 });

// A stable fingerprint of the immutable definition — any change replaces.
const fingerprint = (props: Partial<ClassificationJobProps>) =>
  JSON.stringify({
    jobType: props.jobType ?? "ONE_TIME",
    bucketDefinitions: (props.bucketDefinitions ?? [])
      .map((b) => ({ accountId: b.accountId, buckets: [...b.buckets].sort() }))
      .sort((a, b) => a.accountId.localeCompare(b.accountId)),
  });

const buildAttrs = (
  jobId: string,
  d: macie2.DescribeClassificationJobResponse,
) => ({
  jobId,
  jobArn: d.jobArn!,
  name: d.name!,
  jobStatus: d.jobStatus,
});

export const ClassificationJobProvider = () =>
  Provider.effect(
    ClassificationJobResource,
    Effect.gen(function* () {
      const describe = (jobId: string) =>
        macie2
          .describeClassificationJob({ jobId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      return {
        stables: ["jobId", "jobArn", "name"],

        read: Effect.fn(function* ({ id, output }) {
          if (!output?.jobId) return undefined;
          const d = yield* describe(output.jobId);
          if (!d) return undefined;
          const attrs = buildAttrs(output.jobId, d);
          return (yield* hasAlchemyTags(id, d.tags)) ? attrs : Unowned(attrs);
        }),

        // Classification jobs are enumerable, but they are per-job resources
        // (not a singleton); the engine keys them by logical ID, so return the
        // empty set here and rely on `read` for state refresh.
        list: () => Effect.succeed([]),

        diff: Effect.fn(function* ({ id, news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          if (fingerprint(olds) !== fingerprint(news)) {
            return { action: "replace" } as const;
          }
          // Jobs are immutable apart from status; nothing else to update.
          return undefined;
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const name = output?.name ?? (yield* createName(id, news));

          // 1. OBSERVE — cloud state is authoritative; output is an id cache.
          let jobId = output?.jobId;
          let live = jobId ? yield* describe(jobId) : undefined;

          // 2. ENSURE — create the job if it does not exist.
          if (jobId === undefined || live === undefined) {
            const created = yield* retryThroughEnablement(
              macie2.createClassificationJob({
                name,
                jobType: news.jobType ?? "ONE_TIME",
                s3JobDefinition: {
                  bucketDefinitions: news.bucketDefinitions.map((b) => ({
                    accountId: b.accountId,
                    buckets: b.buckets,
                  })),
                },
                description: news.description,
                samplingPercentage: news.samplingPercentage,
                initialRun: news.initialRun,
                managedDataIdentifierSelector:
                  news.managedDataIdentifierSelector,
                tags: desiredTags,
              }),
            );
            jobId = created.jobId!;
            live = yield* macie2.describeClassificationJob({ jobId });
          } else {
            // 3. SYNC tags — the definition is immutable; only tags mutate.
            const { upsert, removed } = diffTags(
              tagRecord(live.tags),
              desiredTags,
            );
            if (upsert.length > 0) {
              yield* macie2.tagResource({
                resourceArn: live.jobArn!,
                tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
              });
            }
            if (removed.length > 0) {
              yield* macie2.untagResource({
                resourceArn: live.jobArn!,
                tagKeys: removed,
              });
            }
          }

          // 4. RETURN fresh attributes.
          const final = yield* macie2.describeClassificationJob({ jobId });
          yield* session.note(jobId);
          return buildAttrs(jobId, final);
        }),

        delete: Effect.fn(function* ({ output }) {
          // Classification jobs cannot be deleted — only cancelled. Cancelling
          // an already-terminal job raises ConflictException; treat as done.
          yield* macie2
            .updateClassificationJob({
              jobId: output.jobId,
              jobStatus: "CANCELLED",
            })
            .pipe(
              Effect.catchTag("ConflictException", () => Effect.void),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
