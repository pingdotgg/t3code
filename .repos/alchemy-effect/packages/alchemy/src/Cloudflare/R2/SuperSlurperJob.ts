import * as r2 from "@distilled.cloud/cloudflare/r2";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { deepEqual, isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

/** S3-compatible credentials with access to a migration bucket. */
export interface SuperSlurperCredentials {
  /** Access key ID. Changing credentials replaces the migration. */
  accessKeyId: Redacted.Redacted<string>;
  /** Secret access key. Changing credentials replaces the migration. */
  secretAccessKey: Redacted.Redacted<string>;
}

/** Object selection shared by all source vendors. */
export interface SuperSlurperSourceSelection {
  /** Name of the source bucket. Immutable. */
  bucket: string;
  /** Object keys to migrate. Omit to migrate all matching objects. Immutable. */
  keys?: string[];
  /** Restrict migration to this object key prefix. Immutable. */
  pathPrefix?: string;
}

/** AWS S3 or another HTTPS S3-compatible source. */
export interface SuperSlurperS3Source extends SuperSlurperSourceSelection {
  /** Select the S3 source API. */
  vendor: "s3";
  /** Source credentials with read access. Immutable. */
  secret: SuperSlurperCredentials;
  /** Custom S3-compatible HTTPS endpoint. Immutable. */
  endpoint?: string;
  /** Source bucket region. Immutable. */
  region?: string;
}

/** Google Cloud Storage source. */
export interface SuperSlurperGcsSource extends SuperSlurperSourceSelection {
  /** Select Google Cloud Storage. */
  vendor: "gcs";
  /** Service account credentials with source read access. Immutable. */
  secret: {
    /** Service account email. */
    clientEmail: Redacted.Redacted<string>;
    /** Service account private key in PEM format. */
    privateKey: Redacted.Redacted<string>;
  };
}

/** Cloudflare R2 source. */
export interface SuperSlurperR2Source extends SuperSlurperSourceSelection {
  /** Select Cloudflare R2. */
  vendor: "r2";
  /** S3-compatible R2 credentials with source read access. Immutable. */
  secret: SuperSlurperCredentials;
  /** Source jurisdiction. Immutable. @default "default" */
  jurisdiction?: "default" | "eu" | "us" | "fedramp";
}

/** Supported source bucket configurations. */
export type SuperSlurperSource =
  | SuperSlurperS3Source
  | SuperSlurperGcsSource
  | SuperSlurperR2Source;

/** R2 destination for migrated objects. */
export interface SuperSlurperTarget {
  /** Name of the destination R2 bucket. Immutable. */
  bucket: string;
  /** The destination vendor must be R2. */
  vendor: "r2";
  /** S3-compatible R2 credentials with destination write access. Immutable. */
  secret: SuperSlurperCredentials;
  /** Destination jurisdiction. Immutable. @default "default" */
  jurisdiction?: "default" | "eu" | "us" | "fedramp";
}

export interface SuperSlurperJobProps {
  /** Source bucket and credentials. Any change replaces the job. */
  source: SuperSlurperSource;
  /** Destination R2 bucket and credentials. Any change replaces the job. */
  target: SuperSlurperTarget;
  /** Overwrite existing destination objects. Immutable. @default false */
  overwrite?: boolean;
  /**
   * Pause an active job, or resume it when false. Terminal jobs are never
   * restarted. A new job starts running before the pause request is applied,
   * so this is not a guarantee that no objects are transferred.
   * @default false
   */
  paused?: boolean;
}

export interface SuperSlurperJobAttributes {
  /** Cloudflare account that owns the migration. */
  accountId: string;
  /** Server-assigned migration ID. Stable until replacement. */
  jobId: string;
  /** Last observed job status; not a completion guarantee. */
  status: r2.GetSuperSlurperJobResponse["status"];
  /** Creation timestamp reported by Cloudflare. */
  createdAt: string | undefined;
  /** Completion timestamp, if the job has finished. */
  finishedAt: string | undefined;
}

export type SuperSlurperJob = Resource<
  "Cloudflare.R2.SuperSlurperJob",
  SuperSlurperJobProps,
  SuperSlurperJobAttributes,
  never,
  Providers
>;

/**
 * Starts a bulk migration from S3, GCS, or R2 into an R2 bucket.
 *
 * Deployment returns the job identity without waiting for the migration.
 * Completed and aborted jobs remain resources: redeploying does not run them
 * again. Changing source, target, credentials, or overwrite replaces the job.
 * Destroy only cancels this resource's active job; it never deletes copied
 * objects or Cloudflare's job history. Transfers already in flight may finish.
 *
 * Cloudflare exposes no job name, ownership tags, or idempotency key. The
 * persisted job ID is the only ownership record; similar jobs are never
 * adopted. If a create response or the subsequent state write is lost, the
 * job cannot be recovered automatically and retrying may create a second job.
 * Inspect the account's migration history and cancel that orphan explicitly.
 * Account-wide adoption and cancellation are intentionally not supported.
 * If reading a cached ID fails with Cloudflare's ambiguous server error,
 * paginated job history is checked for that exact ID before declaring it absent.
 *
 * ### Migrating from S3
 * **Example:** Copy an S3 prefix into R2
 * ```typescript
 * const target = yield* Cloudflare.R2.Bucket("Archive");
 * const job = yield* Cloudflare.R2.SuperSlurperJob("Migration", {
 *   source: {
 *     vendor: "s3",
 *     bucket: "legacy-archive",
 *     region: "us-east-1",
 *     pathPrefix: "photos/",
 *     secret: {
 *       accessKeyId: yield* Config.Redacted("AWS_ACCESS_KEY_ID"),
 *       secretAccessKey: yield* Config.Redacted("AWS_SECRET_ACCESS_KEY"),
 *     },
 *   },
 *   target: {
 *     vendor: "r2",
 *     bucket: target.bucketName,
 *     secret: {
 *       accessKeyId: yield* Config.Redacted("R2_ACCESS_KEY_ID"),
 *       secretAccessKey: yield* Config.Redacted("R2_SECRET_ACCESS_KEY"),
 *     },
 *   },
 * });
 * ```
 *
 * ### Migrating from GCS or R2
 * **Example:** Google Cloud Storage source
 * ```typescript
 * const source: Cloudflare.R2.SuperSlurperSource = {
 *   vendor: "gcs",
 *   bucket: "legacy-media",
 *   secret: {
 *     clientEmail: yield* Config.Redacted("GCS_CLIENT_EMAIL"),
 *     privateKey: yield* Config.Redacted("GCS_PRIVATE_KEY"),
 *   },
 * };
 * ```
 *
 * **Example:** R2 source and paused desired state
 * ```typescript
 * yield* Cloudflare.R2.SuperSlurperJob("Migration", {
 *   source: {
 *     vendor: "r2",
 *     bucket: "old-media",
 *     secret: {
 *       accessKeyId: yield* Config.Redacted("SOURCE_R2_ACCESS_KEY_ID"),
 *       secretAccessKey: yield* Config.Redacted("SOURCE_R2_SECRET_ACCESS_KEY"),
 *     },
 *   },
 *   target: {
 *     vendor: "r2",
 *     bucket: "new-media",
 *     secret: {
 *       accessKeyId: yield* Config.Redacted("TARGET_R2_ACCESS_KEY_ID"),
 *       secretAccessKey: yield* Config.Redacted("TARGET_R2_SECRET_ACCESS_KEY"),
 *     },
 *   },
 *   paused: true,
 * });
 * ```
 *
 * ### Referencing a Migration
 * **Example:** Read a persisted job identity without creating a new job
 * ```typescript
 * const job = yield* Cloudflare.R2.SuperSlurperJob.ref("Migration");
 * return { accountId: job.accountId, jobId: job.jobId };
 * ```
 *
 * @resource
 * @product R2
 * @category Storage & Databases
 */
export const SuperSlurperJob = Resource<SuperSlurperJob>(
  "Cloudflare.R2.SuperSlurperJob",
);

export const SuperSlurperJobProvider = () =>
  Provider.succeed(SuperSlurperJob, {
    stables: ["accountId", "jobId"],
    nuke: { skip: true },
    diff: Effect.fn(function* ({ olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (output && output.accountId !== accountId) {
        return { action: "replace" } as const;
      }
      if (
        !("source" in news) ||
        !isResolved(news.source) ||
        !isResolved(news.target) ||
        !isResolved(news.overwrite)
      ) {
        return { action: "replace" } as const;
      }
      if (
        !deepEqual(olds.source, news.source) ||
        !deepEqual(olds.target, news.target) ||
        (olds.overwrite ?? false) !== (news.overwrite ?? false)
      ) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output) return undefined;
      const observed = yield* observe(output);
      return observed ? attributes(output, observed) : undefined;
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      let identity = output;
      let observed = identity ? yield* observe(identity) : undefined;
      if (!observed) {
        const created = yield* r2
          .createSuperSlurperJob({
            accountId,
            source: sourceRequest(news.source),
            target: {
              ...news.target,
              secret: credentialsRequest(news.target.secret),
            },
            overwrite: news.overwrite ?? false,
          })
          .pipe(
            Retry.none,
            // Preconnectivity rejects before creating a job; fresh tokens may not have propagated.
            Effect.retry({
              while: (error) =>
                error._tag === "SuperSlurperPreconnectivityFailed",
              schedule: Schedule.spaced("3 seconds"),
              times: 8,
            }),
          );
        if (!created.id) {
          return yield* Effect.fail(
            new Error("Super Slurper did not return a job ID"),
          );
        }
        identity = attributes(
          { accountId, jobId: created.id },
          { status: "running" },
        );
        observed = { id: created.id, status: "running" };
      }
      const current = identity!;
      if (news.paused && observed.status === "running") {
        yield* mutate(current, "pause");
        observed = (yield* observe(current)) ?? observed;
      } else if (!news.paused && observed.status === "paused") {
        yield* mutate(current, "resume");
        observed = (yield* observe(current)) ?? observed;
      }
      return attributes(current, observed);
    }),
    delete: Effect.fn(function* ({ output }) {
      const observed = yield* observe(output);
      if (observed?.status === "running" || observed?.status === "paused") {
        yield* mutate(output, "abort");
      }
    }),
  });

const observe = (identity: { accountId: string; jobId: string }) =>
  r2
    .getSuperSlurperJob({
      accountId: identity.accountId,
      jobId: identity.jobId,
    })
    .pipe(
      Retry.none,
      Effect.map((job) => (job.id ? job : undefined)),
      Effect.catchTag("SuperSlurperJobOperationFailed", () =>
        findInHistory(identity),
      ),
    );

const findInHistory = Effect.fn(function* (identity: {
  accountId: string;
  jobId: string;
}) {
  const limit = 50;
  const seen = new Set<string>();
  for (let offset = 0; ;) {
    // The SDK's single-page paginator does not follow Slurper's offset parameter.
    const page = yield* r2
      .listSuperSlurperJobs({
        accountId: identity.accountId,
        limit,
        offset,
      })
      .pipe(Retry.none);
    const job = page.result.find((item) => item.id === identity.jobId);
    if (job) return job;
    if (page.result.length === 0) return undefined;
    const ids = page.result.flatMap((item) => (item.id ? [item.id] : []));
    if (ids.length === 0 || ids.every((id) => seen.has(id))) {
      return yield* Effect.fail(
        new Error("Super Slurper job history pagination did not advance"),
      );
    }
    for (const id of ids) seen.add(id);
    offset += page.result.length;
  }
});

const mutate = (
  identity: { accountId: string; jobId: string },
  action: "pause" | "resume" | "abort",
) => {
  const operation =
    action === "pause"
      ? r2.pauseSuperSlurperJob
      : action === "resume"
        ? r2.resumeSuperSlurperJob
        : r2.abortSuperSlurperJob;
  return operation({
    accountId: identity.accountId,
    jobId: identity.jobId,
  }).pipe(
    Retry.none,
    Effect.asVoid,
    Effect.catchTag("SuperSlurperJobOperationFailed", (error) =>
      Effect.gen(function* () {
        const current = yield* observe(identity);
        if (
          !current ||
          current.status === "completed" ||
          current.status === "aborted" ||
          (action === "pause" && current.status === "paused") ||
          (action === "resume" && current.status === "running")
        ) {
          return;
        }
        return yield* Effect.fail(error);
      }),
    ),
  );
};

const attributes = (
  identity: { accountId: string; jobId: string },
  job: r2.GetSuperSlurperJobResponse,
): SuperSlurperJobAttributes => ({
  accountId: identity.accountId,
  jobId: identity.jobId,
  status: job.status,
  createdAt: job.createdAt ?? undefined,
  finishedAt: job.finishedAt ?? undefined,
});

const credentialsRequest = (secret: SuperSlurperCredentials) => ({
  accessKeyId: Redacted.value(secret.accessKeyId),
  secretAccessKey: Redacted.value(secret.secretAccessKey),
});

const sourceRequest = (
  source: SuperSlurperSource,
): r2.SuperSlurperJobsCreateRequestSource =>
  source.vendor === "gcs"
    ? {
        ...source,
        secret: {
          clientEmail: Redacted.value(source.secret.clientEmail),
          privateKey: Redacted.value(source.secret.privateKey),
        },
      }
    : { ...source, secret: credentialsRequest(source.secret) };
