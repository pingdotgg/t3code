import * as r2 from "@distilled.cloud/cloudflare/r2";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import type { Bucket } from "./Bucket.ts";

const TypeId = "Cloudflare.R2.BucketSippy" as const;
type TypeId = typeof TypeId;

/**
 * Source bucket configuration for an AWS S3 origin.
 */
export interface BucketSippyAwsSource {
  /** Marks the source as an AWS S3 bucket. */
  provider: "aws";
  /**
   * Name of the AWS S3 bucket to migrate objects from.
   */
  bucket: string;
  /**
   * AWS region the source bucket lives in, e.g. `us-east-1`.
   */
  region: string;
  /**
   * Access Key ID of an AWS IAM credential with read access to the
   * source bucket. Write-only — Cloudflare never returns it.
   */
  accessKeyId: Redacted.Redacted<string>;
  /**
   * Secret Access Key paired with `accessKeyId`. Write-only.
   */
  secretAccessKey: Redacted.Redacted<string>;
}

/**
 * Source bucket configuration for a Google Cloud Storage origin.
 */
export interface BucketSippyGcsSource {
  /** Marks the source as a Google Cloud Storage bucket. */
  provider: "gcs";
  /**
   * Name of the GCS bucket to migrate objects from.
   */
  bucket: string;
  /**
   * Client email of a GCP service account with read access to the
   * source bucket.
   */
  clientEmail: string;
  /**
   * Private key of the GCP service account. Write-only — Cloudflare
   * never returns it.
   */
  privateKey: Redacted.Redacted<string>;
}

/**
 * The upstream bucket Sippy pulls objects from on R2 cache misses.
 */
export type BucketSippySource = BucketSippyAwsSource | BucketSippyGcsSource;

/**
 * R2 credentials Sippy uses to write migrated objects into the
 * destination bucket. Create an R2 API token with write access to the
 * bucket and pass its S3-compatible credentials here.
 */
export interface BucketSippyDestination {
  /**
   * Access Key ID of the R2 API token. Write-only at the secret level —
   * Cloudflare echoes only the key ID back.
   */
  accessKeyId: Redacted.Redacted<string>;
  /**
   * Secret Access Key of the R2 API token. Write-only.
   */
  secretAccessKey: Redacted.Redacted<string>;
}

export interface BucketSippyProps {
  /**
   * Name of the R2 bucket to enable incremental migration into. Pass
   * `bucket.bucketName` from a `Cloudflare.R2.Bucket`.
   *
   * Immutable — changing the bucket triggers a replacement.
   */
  bucketName: string;
  /**
   * Jurisdiction of the bucket (must match the bucket's own
   * jurisdiction).
   *
   * Immutable — changing the jurisdiction triggers a replacement.
   * @default "default"
   */
  jurisdiction?: Bucket.Jurisdiction;
  /**
   * The upstream AWS S3 or Google Cloud Storage bucket to migrate
   * objects from. Source credentials are write-only — they are sent to
   * Cloudflare but never read back.
   */
  source: BucketSippySource;
  /**
   * R2 API token credentials Sippy uses to write objects into the
   * destination bucket.
   */
  destination: BucketSippyDestination;
}

export interface BucketSippyAttributes {
  /** Name of the R2 bucket Sippy is enabled on. */
  bucketName: string;
  /** Account the bucket lives in. */
  accountId: string;
  /** Jurisdiction of the bucket. */
  jurisdiction: Bucket.Jurisdiction;
  /** Whether Sippy is currently enabled on the bucket. */
  enabled: boolean;
  /** The configured source bucket as reported by Cloudflare (sans secrets). */
  source: BucketSippy.SourceAttributes;
  /** The configured destination as reported by Cloudflare (sans secrets). */
  destination: BucketSippy.DestinationAttributes;
}

export type BucketSippy = Resource<
  TypeId,
  BucketSippyProps,
  BucketSippyAttributes,
  never,
  Providers
>;

/**
 * Sippy — incremental migration from AWS S3 or Google Cloud Storage
 * into a Cloudflare R2 bucket.
 *
 * When Sippy is enabled on a bucket, any object requested from R2 that
 * is not yet present is fetched from the configured source bucket,
 * served, and copied into R2 — migrating data on demand without a bulk
 * transfer and without paying double storage during the transition.
 *
 * One Sippy configuration exists per bucket (it is a singleton
 * sub-resource of the bucket). Destroying the resource disables Sippy;
 * objects already migrated stay in the R2 bucket.
 * @resource
 * @product R2
 * @category Storage & Databases
 * @section Migrating from AWS S3
 * @example Enable Sippy on a bucket with an S3 source
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("Media");
 *
 * yield* Cloudflare.R2.BucketSippy("MediaMigration", {
 *   bucketName: bucket.bucketName,
 *   source: {
 *     provider: "aws",
 *     bucket: "legacy-media",
 *     region: "us-east-1",
 *     accessKeyId: alchemy.secret.env.AWS_ACCESS_KEY_ID,
 *     secretAccessKey: alchemy.secret.env.AWS_SECRET_ACCESS_KEY,
 *   },
 *   destination: {
 *     accessKeyId: alchemy.secret.env.R2_ACCESS_KEY_ID,
 *     secretAccessKey: alchemy.secret.env.R2_SECRET_ACCESS_KEY,
 *   },
 * });
 * ```
 *
 * @section Migrating from Google Cloud Storage
 * @example Enable Sippy with a GCS source
 * ```typescript
 * yield* Cloudflare.R2.BucketSippy("MediaMigration", {
 *   bucketName: bucket.bucketName,
 *   source: {
 *     provider: "gcs",
 *     bucket: "legacy-media",
 *     clientEmail: "sippy@my-project.iam.gserviceaccount.com",
 *     privateKey: alchemy.secret.env.GCS_PRIVATE_KEY,
 *   },
 *   destination: {
 *     accessKeyId: alchemy.secret.env.R2_ACCESS_KEY_ID,
 *     secretAccessKey: alchemy.secret.env.R2_SECRET_ACCESS_KEY,
 *   },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/r2/data-migration/sippy/
 */
export const BucketSippy = Resource<BucketSippy>(TypeId);

export declare namespace BucketSippy {
  /**
   * The source bucket as echoed back by Cloudflare. Secrets are never
   * returned.
   */
  export type SourceAttributes = {
    provider: "aws" | "gcs" | undefined;
    bucket: string | undefined;
    region: string | undefined;
    bucketUrl: string | undefined;
  };
  /**
   * The destination as echoed back by Cloudflare. Only the access key
   * ID is returned, never the secret.
   */
  export type DestinationAttributes = {
    provider: "r2" | undefined;
    account: string | undefined;
    bucket: string | undefined;
    accessKeyId: string | undefined;
  };
}

/**
 * Returns true if the given value is an BucketSippy resource.
 */
export const isBucketSippy = (value: unknown): value is BucketSippy =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const BucketSippyProvider = () =>
  Provider.succeed(BucketSippy, {
    stables: ["bucketName", "accountId", "jurisdiction"],

    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      // The bucket is the configuration's identity — moving Sippy to a
      // different bucket (or jurisdiction) is a replacement. Compare
      // only once both sides are concrete strings.
      if (
        typeof olds.bucketName === "string" &&
        typeof news.bucketName === "string" &&
        olds.bucketName !== news.bucketName
      ) {
        return { action: "replace" } as const;
      }
      if (
        olds.bucketName !== undefined &&
        (olds.jurisdiction ?? "default") !== (news.jurisdiction ?? "default")
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      // The bucket is the configuration's identity; cold reads derive it
      // from the last-persisted props.
      const bucketName =
        output?.bucketName ??
        (typeof olds?.bucketName === "string" ? olds.bucketName : undefined);
      if (bucketName === undefined) return undefined;
      const jurisdiction =
        output?.jurisdiction ?? olds?.jurisdiction ?? "default";

      const observed = yield* r2
        .getBucketSippy({ accountId: acct, bucketName, jurisdiction })
        .pipe(
          Effect.map((config): r2.GetBucketSippyResponse | undefined => config),
          // The bucket itself is gone — so is its Sippy configuration.
          Effect.catchTag("NoSuchBucket", () => Effect.succeed(undefined)),
        );
      // A bucket with Sippy never configured (or disabled) reads back as
      // `{ enabled: false }` — that is "absent" for this resource.
      if (!observed || observed.enabled !== true) return undefined;

      const attrs = toAttributes(observed, acct, bucketName, jurisdiction);
      // Sippy configs carry no ownership markers. With no prior output we
      // cannot prove we enabled it — brand it `Unowned` so takeover is
      // gated behind the adopt policy.
      return output ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      // Inputs have been resolved to concrete strings by Plan.
      const bucketName = news.bucketName as string;
      const jurisdiction = news.jurisdiction ?? "default";

      // The PUT is a full upsert of the bucket's single Sippy
      // configuration — enabling when absent and re-configuring when
      // present — so observe/ensure/sync collapse into one idempotent
      // call. Source/destination secrets are write-only, so an observed
      // config can never be diffed against the desired one anyway.
      const synced = yield* r2.putBucketSippy({
        accountId: acct,
        bucketName,
        jurisdiction,
        source: toRequestSource(news.source),
        destination: {
          provider: "r2",
          accessKeyId: Redacted.value(news.destination.accessKeyId),
          secretAccessKey: Redacted.value(news.destination.secretAccessKey),
        },
      });

      return toAttributes(synced, acct, bucketName, jurisdiction);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Disabling Sippy on a bucket where it is already disabled is a
      // success (`{ enabled: false }`); a missing bucket means there is
      // nothing left to disable — both make delete idempotent.
      yield* r2
        .deleteBucketSippy({
          accountId: output.accountId,
          bucketName: output.bucketName,
          jurisdiction: output.jurisdiction,
        })
        .pipe(Effect.catchTag("NoSuchBucket", () => Effect.void));
    }),

    // Sippy is a per-bucket singleton with no account-wide enumeration
    // API, so fan out from the parent: enumerate every R2 bucket, read its
    // Sippy config with bounded concurrency, and emit one item per bucket
    // that actually has Sippy enabled (mirroring `read`, which treats a
    // disabled/absent config as "not present").
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { buckets } = yield* r2.listBuckets({ accountId });
      const perBucket = yield* Effect.forEach(
        buckets ?? [],
        (bucket) => {
          const bucketName = bucket.name;
          if (bucketName == null) {
            return Effect.succeed([] as BucketSippyAttributes[]);
          }
          const jurisdiction = (bucket.jurisdiction ??
            "default") as Bucket.Jurisdiction;
          return r2
            .getBucketSippy({ accountId, bucketName, jurisdiction })
            .pipe(
              Effect.map((config) =>
                config.enabled === true
                  ? [toAttributes(config, accountId, bucketName, jurisdiction)]
                  : [],
              ),
              // A bucket that vanished mid-enumeration, or one whose plan
              // rejects the Sippy route, contributes nothing — skip it.
              Effect.catchTag(
                ["NoSuchBucket", "InvalidRoute", "Forbidden"],
                () => Effect.succeed([] as BucketSippyAttributes[]),
              ),
            );
        },
        { concurrency: 10 },
      );
      return perBucket.flat();
    }),
  });

/**
 * Build the request body shape the distilled `putBucketSippy` method
 * accepts. Secrets are unwrapped here because the distilled TS types
 * declare the credential fields as plain strings.
 */
const toRequestSource = (source: BucketSippySource) =>
  source.provider === "aws"
    ? {
        provider: "aws" as const,
        bucket: source.bucket,
        region: source.region,
        accessKeyId: Redacted.value(source.accessKeyId),
        secretAccessKey: Redacted.value(source.secretAccessKey),
      }
    : {
        provider: "gcs" as const,
        bucket: source.bucket,
        clientEmail: source.clientEmail,
        privateKey: Redacted.value(source.privateKey),
      };

const toAttributes = (
  config: r2.GetBucketSippyResponse,
  accountId: string,
  bucketName: string,
  jurisdiction: Bucket.Jurisdiction,
): BucketSippyAttributes => ({
  bucketName,
  accountId,
  jurisdiction,
  enabled: config.enabled ?? false,
  source: {
    // Cloudflare reports AWS sources as either "aws" or the legacy "s3".
    provider:
      config.source?.provider === "gcs"
        ? "gcs"
        : config.source?.provider != null
          ? "aws"
          : undefined,
    bucket: config.source?.bucket ?? undefined,
    region: config.source?.region ?? undefined,
    bucketUrl: config.source?.bucketUrl ?? undefined,
  },
  destination: {
    provider: config.destination?.provider ?? undefined,
    account: config.destination?.account ?? undefined,
    bucket: config.destination?.bucket ?? undefined,
    accessKeyId: config.destination?.accessKeyId ?? undefined,
  },
});
