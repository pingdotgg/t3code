import { createHash } from "node:crypto";
import { Region } from "@distilled.cloud/aws/Region";
import type { BucketLocationConstraint } from "@distilled.cloud/aws/s3";
import * as s3 from "@distilled.cloud/aws/s3";
import { deepEqual, isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { ScopedPlanStatusSession } from "alchemy/Report";
import { Resource, type ResourceBinding } from "alchemy/Resource";
import { Stack } from "alchemy/Stack";
import { isActionState, State } from "alchemy/State/State";
import { diffTags } from "alchemy/Tags";
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import { durationToDays } from "../IAM/common.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";

export type BucketName = string;
export type BucketArn = `arn:aws:s3:::${BucketName}`;

/**
 * Server-side encryption configuration for a bucket.
 */
export interface BucketEncryption {
  /**
   * Server-side encryption algorithm to use for the default encryption.
   */
  sseAlgorithm: "AES256" | "aws:kms" | "aws:kms:dsse";
  /**
   * KMS key id (or ARN) to use when `sseAlgorithm` is `aws:kms` or
   * `aws:kms:dsse`. Ignored for `AES256`.
   */
  kmsMasterKeyId?: string;
  /**
   * Whether to use an S3 Bucket Key for SSE-KMS to reduce KMS request costs.
   * @default false
   */
  bucketKeyEnabled?: boolean;
  /**
   * Encryption types to block for new object writes. Currently supports SSE-C
   * (server-side encryption with customer-provided keys).
   * Omitted or `[]` blocks no encryption types and permits SSE-C, sending
   * AWS's `NONE` value. Set to `["SSE-C"]` to block customer-provided keys.
   * Removing this property resets the blocklist to its default.
   * @default []
   */
  blockedEncryptionTypes?: "SSE-C"[];
}

/**
 * Public access block settings for a bucket. Each flag defaults to `false`
 * (i.e. the corresponding public access is allowed) when omitted.
 */
export interface BucketPublicAccessBlock {
  /** Block new public ACLs and uploading public objects. */
  blockPublicAcls?: boolean;
  /** Ignore all public ACLs on the bucket and its objects. */
  ignorePublicAcls?: boolean;
  /** Block new bucket policies that grant public access. */
  blockPublicPolicy?: boolean;
  /** Restrict access granted by public bucket policies to AWS principals. */
  restrictPublicBuckets?: boolean;
}

/**
 * Access-logging configuration for a bucket.
 */
export interface BucketLogging {
  /** Bucket that receives the access logs. */
  targetBucket: string;
  /** Key prefix applied to log object names. */
  targetPrefix: string;
  /** Optional grants giving accounts access to the log objects. */
  targetGrants?: s3.TargetGrant[];
  /** Optional log object key format (simple or partitioned prefix). */
  targetObjectKeyFormat?: s3.TargetObjectKeyFormat;
}

/**
 * Static-website hosting configuration for a bucket.
 */
export interface BucketWebsite {
  /** Index document served for directory-style requests. */
  indexDocument?: { suffix: string };
  /** Document served for 4XX errors. */
  errorDocument?: { key: string };
  /** Redirect every request to another host instead of serving objects. */
  redirectAllRequestsTo?: { hostName: string; protocol?: "http" | "https" };
  /** Routing rules for conditional redirects. */
  routingRules?: s3.RoutingRule[];
}

/**
 * Cross-region (or same-region) replication configuration for a bucket.
 * Requires `versioning: "Enabled"` on the source bucket and an IAM role
 * that S3 can assume to perform the replication.
 */
export interface BucketReplication {
  /** ARN of the IAM role S3 assumes to replicate objects. */
  role: string;
  /** Replication rules describing what to replicate and where. */
  rules: s3.ReplicationRule[];
}

/**
 * Default object-lock retention applied to objects placed in a bucket that
 * was created with `objectLockEnabled: true`.
 */
export interface BucketObjectLockConfiguration {
  /** Retention mode. */
  mode: "GOVERNANCE" | "COMPLIANCE";
  /**
   * Retention period (e.g. `"30 days"` or `Duration.days(30)`; a bare number
   * is milliseconds). Rounded to whole days on the wire. Mutually exclusive
   * with `years`.
   */
  days?: Duration.Input;
  /** Retention period in years (mutually exclusive with `days`). */
  years?: number;
}

export interface BucketProps {
  /**
   * Name of the bucket. If omitted, a unique name will be generated.
   * Must be lowercase and between 3-63 characters.
   */
  bucketName?: string;
  /**
   * Indicates whether this bucket has Object Lock enabled.
   * Once enabled, cannot be disabled.
   */
  objectLockEnabled?: boolean;
  /**
   * Whether to delete all objects when the bucket is destroyed.
   * @default false
   */
  forceDestroy?: boolean;
  /**
   * Tags to apply to the bucket.
   */
  tags?: Record<string, string>;
  /**
   * Object versioning status. `"Enabled"` keeps every version of an object;
   * `"Suspended"` stops accruing new versions (existing versions are kept).
   */
  versioning?: "Enabled" | "Suspended";
  /**
   * MFA-delete status. Rarely used — enabling it requires an MFA serial and
   * the root account, so it cannot be toggled through normal credentials.
   */
  mfaDelete?: "Enabled" | "Disabled";
  /**
   * Default server-side encryption for new objects. Omission restores AES256,
   * no KMS key, bucket keys disabled, and no encryption types blocked.
   * Existing objects are not re-encrypted. External changes are repaired on deploy.
   */
  encryption?: BucketEncryption;
  /**
   * Block-public-access settings. Applied before any ACL or policy that
   * grants public access.
   */
  publicAccessBlock?: BucketPublicAccessBlock;
  /**
   * Cross-origin resource sharing (CORS) rules.
   */
  cors?: s3.CORSRule[];
  /**
   * Object lifecycle rules (expiration, transition, abort-incomplete-MPU…).
   */
  lifecycleRules?: s3.LifecycleRule[];
  /**
   * Object ownership control. `"BucketOwnerEnforced"` disables ACLs entirely.
   */
  objectOwnership?: "BucketOwnerPreferred" | "ObjectWriter" | "BucketOwnerEnforced";
  /**
   * Canned ACL to apply. Only valid when object ownership is not
   * `BucketOwnerEnforced`.
   */
  acl?: s3.BucketCannedACL;
  /**
   * Access-logging configuration.
   */
  logging?: BucketLogging;
  /**
   * S3 Transfer Acceleration status.
   */
  transferAcceleration?: "Enabled" | "Suspended";
  /**
   * Who pays for requests and data transfer. `"Requester"` enables
   * requester-pays.
   */
  requestPayer?: "BucketOwner" | "Requester";
  /**
   * Static-website hosting configuration.
   */
  website?: BucketWebsite;
  /**
   * Replication configuration. Requires `versioning: "Enabled"` and an
   * IAM role.
   */
  replication?: BucketReplication;
  /**
   * S3 Intelligent-Tiering configurations (id-keyed).
   */
  intelligentTiering?: s3.IntelligentTieringConfiguration[];
  /**
   * Default object-lock retention. Requires `objectLockEnabled: true`.
   */
  objectLockConfiguration?: BucketObjectLockConfiguration;
  /**
   * Explicit bucket policy as policy statements. Merged with any
   * policy statements contributed via bindings.
   */
  policy?: PolicyStatement[];
}

export interface Bucket extends Resource<
  "AWS.S3.Bucket",
  BucketProps,
  {
    /**
     * Name of the bucket.
     */
    bucketName: BucketName;
    /**
     * ARN of the bucket.
     */
    bucketArn: BucketArn;
    /**
     * Domain name of the bucket (e.g., bucket-name.s3.amazonaws.com).
     */
    bucketDomainName: `${BucketName}.s3.amazonaws.com`;
    /**
     * Regional domain name of the bucket.
     */
    bucketRegionalDomainName: `${BucketName}.s3.${RegionID}.amazonaws.com`;
    /**
     * AWS region where the bucket is located.
     */
    region: RegionID;
    /**
     * AWS account ID that owns the bucket.
     */
    accountId: AccountID;
    /**
     * Notification configuration requested through bindings, retained for drift
     * detection when binding outputs are unresolved during planning.
     */
    managedNotificationConfiguration?: s3.NotificationConfiguration;
    // The attributes below record the bucket's configuration as observed on
    // S3, so `alchemy drift` detects out-of-band changes. Settings whose prop
    // is unset are not managed and are not observed.
    /** Tags on the bucket, as observed. */
    tags?: Record<string, string>;
    /** Bucket policy document (explicit statements plus bindings), as observed. */
    policy?: unknown;
    /** Default encryption, as observed. */
    encryption?: {
      sseAlgorithm?: string;
      kmsMasterKeyId?: string;
      bucketKeyEnabled: boolean;
      blockedEncryptionTypes: string[];
    };
    /**
     * Event notification targets Alchemy owns (`<id>:<target>` keys), and
     * whether it owns EventBridge delivery, as observed.
     */
    notifications?: {
      lambdaFunctions: string[];
      queues: string[];
      topics: string[];
      eventBridge: boolean;
    };
    /** Versioning status, observed when `versioning` is set. */
    versioning?: string;
    /** MFA-delete status, observed when `mfaDelete` is set. */
    mfaDelete?: string;
    /** Block-public-access settings, observed when `publicAccessBlock` is set. */
    publicAccessBlock?: Required<BucketPublicAccessBlock>;
    /** CORS rules, observed when `cors` is set. */
    cors?: s3.CORSRule[];
    /** Lifecycle rules (sorted by id), observed when `lifecycleRules` is set. */
    lifecycleRules?: s3.LifecycleRule[];
    /** Object ownership, observed when `objectOwnership` is set. */
    objectOwnership?: string;
    /**
     * Non-owner ACL grants (`<grantee>:<permission>`), observed when `acl`
     * is set.
     */
    aclGrants?: string[];
    /** Access logging, observed when `logging` is set. */
    logging?: {
      targetBucket?: string;
      targetPrefix?: string;
      targetGrants?: s3.TargetGrant[];
    };
    /** Transfer acceleration status, observed when `transferAcceleration` is set. */
    transferAcceleration?: string;
    /** Request payer, observed when `requestPayer` is set. */
    requestPayer?: string;
    /** Website hosting configuration, observed when `website` is set. */
    website?: {
      indexDocument?: s3.IndexDocument;
      errorDocument?: s3.ErrorDocument;
      redirectAllRequestsTo?: s3.RedirectAllRequestsTo;
      routingRules?: s3.RoutingRule[];
    };
    /** Replication configuration, observed when `replication` is set. */
    replication?: {
      role?: string;
      rules: s3.ReplicationRule[];
    };
    /**
     * The declared Intelligent-Tiering configurations (sorted by id;
     * `undefined` for one that no longer exists), observed when
     * `intelligentTiering` is set.
     */
    intelligentTiering?: (s3.IntelligentTieringConfiguration | undefined)[];
    /**
     * Default Object Lock retention, observed when `objectLockConfiguration`
     * is set.
     */
    objectLockConfiguration?: {
      mode?: string;
      days?: number;
      years?: number;
    };
  },
  {
    /**
     * Notification configuration for the bucket. Alchemy assigns stable target
     * IDs and reconciles Lambda, queue, topic, and EventBridge bindings.
     */
    notificationConfiguration?: s3.NotificationConfiguration;
    /**
     * Policy statements for the bucket.
     */
    policyStatements?: PolicyStatement[];
  },
  Providers
> {}

/**
 * An S3 bucket for storing objects in AWS.
 *
 * A bucket name is auto-generated from the app, stage, and logical ID unless
 * you provide one explicitly via `bucketName`. Enable `forceDestroy` to allow
 * Alchemy to empty the bucket before deleting it.
 * ### Creating a Bucket
 * **Example:** Basic Bucket
 * ```typescript
 * import * as S3 from "@alchemy.run/aws/S3";
 *
 * const bucket = yield* S3.Bucket("my-bucket", {});
 * ```
 *
 * **Example:** Bucket with a custom name
 * ```typescript
 * const bucket = yield* S3.Bucket("my-bucket", {
 *   bucketName: "my-company-assets",
 * });
 * ```
 *
 * **Example:** Bucket with force destroy
 * ```typescript
 * const bucket = yield* S3.Bucket("my-bucket", {
 *   forceDestroy: true,
 * });
 * ```
 *
 * ### Configuring a Bucket
 * **Example:** Versioning and encryption
 * ```typescript
 * const bucket = yield* S3.Bucket("my-bucket", {
 *   versioning: "Enabled",
 *   encryption: { sseAlgorithm: "AES256" },
 * });
 * ```
 *
 * **Example:** Block all public access
 * ```typescript
 * const bucket = yield* S3.Bucket("my-bucket", {
 *   publicAccessBlock: {
 *     blockPublicAcls: true,
 *     ignorePublicAcls: true,
 *     blockPublicPolicy: true,
 *     restrictPublicBuckets: true,
 *   },
 * });
 * ```
 *
 * **Example:** CORS and lifecycle rules
 * ```typescript
 * const bucket = yield* S3.Bucket("my-bucket", {
 *   cors: [
 *     {
 *       AllowedMethods: ["GET"],
 *       AllowedOrigins: ["*"],
 *       AllowedHeaders: ["*"],
 *       MaxAgeSeconds: 3000,
 *     },
 *   ],
 *   lifecycleRules: [
 *     {
 *       ID: "expire-old",
 *       Status: "Enabled",
 *       Filter: { Prefix: "logs/" },
 *       Expiration: { Days: 30 },
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Static website hosting
 * ```typescript
 * const bucket = yield* S3.Bucket("my-bucket", {
 *   objectOwnership: "BucketOwnerPreferred",
 *   website: {
 *     indexDocument: { suffix: "index.html" },
 *     errorDocument: { key: "error.html" },
 *   },
 * });
 * ```
 *
 * ### Default Bucket Encryption
 * **Example:** Use the default encryption settings
 * ```typescript
 * const bucket = yield* S3.Bucket("my-bucket", {});
 * ```
 *
 * The default is AES256 encryption with S3-managed keys, bucket keys disabled,
 * and no encryption types blocked. Requests may explicitly supply their own
 * encryption keys (SSE-C); permitting SSE-C does not change the default
 * encryption used by requests without those keys.
 *
 * ### Blocking Customer-Provided Encryption Keys
 * **Example:** Reject new SSE-C writes
 * ```typescript
 * const bucket = yield* S3.Bucket("my-bucket", {
 *   encryption: {
 *     sseAlgorithm: "AES256",
 *     blockedEncryptionTypes: ["SSE-C"],
 *   },
 * });
 * ```
 *
 * `blockedEncryptionTypes` lists encryption types to reject. This blocks new
 * writes using customer-provided keys while retaining AES256 default encryption.
 * Existing encrypted objects are unchanged.
 *
 * ### Resetting Encryption Restrictions
 * **Example:** Remove the block to restore the default
 * ```diff
 * const bucket = yield* S3.Bucket("my-bucket", {
 *   encryption: {
 *     sseAlgorithm: "AES256",
 * -    blockedEncryptionTypes: ["SSE-C"],
 *   },
 * });
 * ```
 *
 * Redeploy the same logical resource after removing the property. Alchemy
 * resets the blocklist to its default, `[]`, so SSE-C writes are permitted.
 * It updates AWS rather than preserving the previously configured block.
 *
 * **Example:** Set the default blocklist explicitly
 * ```typescript
 * const bucket = yield* S3.Bucket("my-bucket", {
 *   encryption: {
 *     sseAlgorithm: "AES256",
 *     blockedEncryptionTypes: [],
 *   },
 * });
 * ```
 *
 * `[]` and omission have the same desired state: no encryption types blocked.
 * The provider sends AWS's `NONE` value when it needs to reset a restriction.
 * Redeploying unchanged code also repairs externally modified restrictions.
 *
 * ### Resetting All Encryption Settings
 * **Example:** Remove the entire encryption configuration
 * ```diff
 * const bucket = yield* S3.Bucket("my-bucket", {
 * -  encryption: {
 * -    sseAlgorithm: "aws:kms",
 * -    kmsMasterKeyId: "arn:aws:kms:us-west-2:123456789012:key/12345678-1234-1234-1234-123456789012",
 * -    bucketKeyEnabled: true,
 * -    blockedEncryptionTypes: ["SSE-C"],
 * -  },
 * });
 * ```
 *
 * Omitting `encryption` resets every setting to the defaults: AES256, no custom
 * KMS key, bucket keys disabled, and an empty blocklist. Previously configured
 * KMS encryption is also reset; existing objects are not re-encrypted.
 *
 * ### Runtime Operations
 * Bind S3 operations in the init phase and use them in runtime
 * handlers. Bindings inject the bucket name and grant scoped IAM
 * permissions automatically.
 *
 * **Example:** Read and write objects
 * ```typescript
 * // init
 * const getObject = yield* S3.GetObject(bucket);
 * const putObject = yield* S3.PutObject(bucket);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* putObject({
 *       Key: "hello.txt",
 *       Body: "Hello, World!",
 *       ContentType: "text/plain",
 *     });
 *     const response = yield* getObject({ Key: "hello.txt" });
 *     return HttpServerResponse.text("OK");
 *   }),
 * };
 * ```
 *
 * **Example:** Delete an object
 * ```typescript
 * // init
 * const deleteObject = yield* S3.DeleteObject(bucket);
 * ```
 *
 * ### Event Notifications
 * Subscribe to bucket events from the init phase. The runtime binding creates
 * the delivery permissions: Lambda invokes directly, while servers consume an SQS queue.
 *
 * Notification bindings reconcile Lambda, SQS, SNS, and EventBridge destinations.
 * Removing a binding removes the targets Alchemy manages while preserving external
 * configurations, including identical pre-existing targets. EventBridge ownership
 * is recorded in a reserved bucket tag so interrupted deployments can recover.
 *
 * **Example:** Process object creation events
 * ```typescript
 * // init
 * yield* S3.consumeBucketEvents(bucket, {
 *   events: ["s3:ObjectCreated:*"],
 * }, (stream) =>
 *   stream.pipe(
 *     Stream.runForEach((event) =>
 *       Effect.log(`New object: ${event.key}`),
 *     ),
 *   ),
 * );
 * ```
 *
 * @resource
 */
export const Bucket = Resource<Bucket>("AWS.S3.Bucket");

export const BucketProvider = () =>
  Provider.effect(
    Bucket,
    Effect.gen(function* () {
      const createBucketName = (id: string, props: { bucketName?: string | undefined }) =>
        Effect.gen(function* () {
          if (props.bucketName) {
            return props.bucketName;
          }
          return yield* createPhysicalName({
            id,
            maxLength: 63,
            lowercase: true,
          });
        });

      const deleteAllObjects = Effect.fn(function* (bucketName: string) {
        yield* Effect.logInfo(`S3 Bucket delete: deleting all objects from ${bucketName}`);
        // Delete every object VERSION and DELETE MARKER, by Key+VersionId.
        // `DeleteBucket` fails with BucketNotEmpty until all of them are
        // gone — deleting only current objects (listObjectsV2) leaves
        // versions/markers behind in versioned buckets. listObjectVersions
        // also covers unversioned buckets (plain objects surface as
        // Versions with VersionId "null"), so this single loop empties
        // both. Pagination is gated on IsTruncated — never on NextKeyMarker,
        // which S3 may omit even mid-listing.
        let isTruncated = true;
        let keyMarker: string | undefined;
        let versionIdMarker: string | undefined;
        while (isTruncated) {
          const page = yield* s3.listObjectVersions({
            Bucket: bucketName,
            KeyMarker: keyMarker,
            VersionIdMarker: versionIdMarker,
          });

          const objectsToDelete = [
            ...(page.Versions ?? []).map((v) => ({
              Key: v.Key!,
              VersionId: v.VersionId,
            })),
            ...(page.DeleteMarkers ?? []).map((dm) => ({
              Key: dm.Key!,
              VersionId: dm.VersionId,
            })),
          ];

          if (objectsToDelete.length > 0) {
            yield* Effect.logInfo(
              `S3 Bucket delete: deleting ${objectsToDelete.length} object version(s)/delete marker(s) from ${bucketName}`,
            );
            yield* s3.deleteObjects({
              Bucket: bucketName,
              Delete: {
                Objects: objectsToDelete,
                Quiet: true,
              },
            });
          }

          isTruncated = page.IsTruncated === true;
          keyMarker = page.NextKeyMarker;
          versionIdMarker = page.NextVersionIdMarker;
        }

        // Abort any in-progress multipart uploads — their stored parts also
        // keep DeleteBucket failing with BucketNotEmpty.
        let uploadsTruncated = true;
        let uploadKeyMarker: string | undefined;
        let uploadIdMarker: string | undefined;
        while (uploadsTruncated) {
          const uploads = yield* s3.listMultipartUploads({
            Bucket: bucketName,
            KeyMarker: uploadKeyMarker,
            UploadIdMarker: uploadIdMarker,
          });
          const inProgress = (uploads.Uploads ?? []).filter(
            (u) => u.Key != null && u.UploadId != null,
          );
          if (inProgress.length > 0) {
            yield* Effect.logInfo(
              `S3 Bucket delete: aborting ${inProgress.length} in-progress multipart upload(s) in ${bucketName}`,
            );
            yield* Effect.forEach(
              inProgress,
              (u) =>
                s3
                  .abortMultipartUpload({
                    Bucket: bucketName,
                    Key: u.Key!,
                    UploadId: u.UploadId!,
                  })
                  // Already aborted/completed concurrently — a race, not a
                  // failure.
                  .pipe(Effect.catchTag("NoSuchUpload", () => Effect.void)),
              { concurrency: 8 },
            );
          }
          uploadsTruncated = uploads.IsTruncated === true;
          uploadKeyMarker = uploads.NextKeyMarker;
          uploadIdMarker = uploads.NextUploadIdMarker;
        }
      });

      const ensureBucketExists = Effect.fn(function* ({
        id,
        news = {},
      }: {
        id: string;
        news: BucketProps;
      }) {
        const { region } = yield* AWSEnvironment.current;
        const { accountId } = yield* AWSEnvironment.current;
        const bucketName = yield* createBucketName(id, news);

        yield* Effect.logInfo(`S3 Bucket create: bucket=${bucketName} region=${region} `);

        // For us-east-1, BucketAlreadyOwnedByYou is not thrown, so we need to
        // pre-emptively check if the bucket exists for idempotency
        if (region === "us-east-1") {
          const exists = yield* s3
            .getBucketLocation({
              Bucket: bucketName,
              ExpectedBucketOwner: accountId,
            })
            .pipe(
              Effect.map(() => true),
              Effect.catchTag("NoSuchBucket", () => Effect.succeed(false)),
            );

          yield* Effect.logInfo(
            `S3 Bucket create: us-east-1 existence check for ${bucketName} -> ${exists}`,
          );

          if (!exists) {
            yield* Effect.logInfo(`S3 Bucket create: creating bucket ${bucketName} in us-east-1`);
            yield* s3
              .createBucket({
                Bucket: bucketName,
                ObjectLockEnabledForBucket: news.objectLockEnabled ?? false,
              })
              .pipe(
                Effect.retry({
                  while: (e) => e._tag === "OperationAborted" || e._tag === "ServiceUnavailable",
                  schedule: Schedule.exponential(100),
                }),
              );
          }
        } else {
          // For non-us-east-1 regions, we can rely on BucketAlreadyOwnedByYou
          yield* Effect.logInfo(`S3 Bucket create: creating bucket ${bucketName} in ${region}`);
          yield* s3
            .createBucket({
              Bucket: bucketName,
              CreateBucketConfiguration: {
                LocationConstraint: region as BucketLocationConstraint,
              },
              ObjectLockEnabledForBucket: news.objectLockEnabled,
            })
            .pipe(
              Effect.catchTag("BucketAlreadyOwnedByYou", () => Effect.void),
              Effect.retry({
                while: (e) => e._tag === "OperationAborted" || e._tag === "ServiceUnavailable",
                schedule: Schedule.exponential(100),
              }),
            );
        }

        // Wait for bucket to exist (eventual consistency)
        yield* s3
          .getBucketLocation({
            Bucket: bucketName,
            ExpectedBucketOwner: accountId,
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "NoSuchBucket",
              schedule: Schedule.exponential(100),
              times: 8,
            }),
          );
        yield* Effect.logInfo(`S3 Bucket create: bucket is available ${bucketName}`);

        return {
          bucketName,
          bucketArn: `arn:aws:s3:::${bucketName}` as const,
          bucketDomainName: `${bucketName}.s3.amazonaws.com` as const,
          bucketRegionalDomainName: `${bucketName}.s3.${region}.amazonaws.com` as const,
          region,
          accountId,
        };
      });

      const fetchBucketTags = (bucketName: string) =>
        s3.getBucketTagging({ Bucket: bucketName }).pipe(
          Effect.map((r) => Object.fromEntries((r.TagSet ?? []).map((t) => [t.Key!, t.Value!]))),
          Effect.catchTag("NoSuchTagSet", () => Effect.succeed<Record<string, string>>({})),
        );

      const eventBridgeOwnerTag = "alchemy:notifications:eventbridge";
      // The tags `alchemy drift` compares: the EventBridge ownership marker
      // is notification bookkeeping, not a user tag.
      const withoutOwnerTag = (tags: Record<string, string>) =>
        Object.fromEntries(Object.entries(tags).filter(([key]) => key !== eventBridgeOwnerTag));
      const readBucketTags = (bucketName: string) =>
        fetchBucketTags(bucketName).pipe(Effect.map(withoutOwnerTag));
      const notificationOwner = (bucketName: string) =>
        Effect.sync(
          () =>
            `alchemy-notification-${createHash("sha256").update(bucketName).digest("hex").slice(0, 16)}-`,
        );

      const syncBucketTags = Effect.fn(function* ({
        bucketName,
        oldTags,
        newTags,
        session,
        operation,
        previous,
      }: {
        bucketName: string;
        oldTags?: Record<string, string>;
        newTags?: Record<string, string>;
        session: ScopedPlanStatusSession;
        operation: "create" | "update";
        /** The last observed projection (`output`); a divergence forces the write. */
        previous?: unknown;
      }) {
        // Compare against the cloud's actual tags so drift surfaces
        // correctly even after a cold-start adoption (where olds.tags
        // equals news.tags and would otherwise look like a no-op).
        const previousTags = oldTags ?? (yield* fetchBucketTags(bucketName));
        const desiredTags = { ...newTags };
        delete desiredTags[eventBridgeOwnerTag];
        if (previousTags[eventBridgeOwnerTag]) {
          desiredTags[eventBridgeOwnerTag] = previousTags[eventBridgeOwnerTag];
        }
        const { removed, upsert } = diffTags(previousTags, desiredTags);
        const expected = withoutOwnerTag(desiredTags);

        yield* Effect.logInfo(
          `S3 Bucket ${operation}: bucket=${bucketName} removedTags=${removed.length} upsertTags=${Object.keys(upsert).length}`,
        );

        if (
          removed.length === 0 &&
          Object.keys(upsert).length === 0 &&
          settled(previous, withoutOwnerTag(previousTags))
        ) {
          return withoutOwnerTag(previousTags);
        }
        const written = settle(readBucketTags(bucketName), (observed) =>
          deepEqual(observed, expected),
        );

        if (Object.keys(desiredTags).length > 0) {
          yield* Effect.logInfo(
            `S3 Bucket ${operation}: writing ${Object.keys(desiredTags).length} total tag(s) to ${bucketName}`,
          );
          yield* s3.putBucketTagging({
            Bucket: bucketName,
            Tagging: {
              TagSet: Object.entries(desiredTags).map(([Key, Value]) => ({
                Key,
                Value,
              })),
            },
          });
          yield* session.note(`Updated bucket tags: ${bucketName}`);
          return yield* written;
        }

        yield* Effect.logInfo(`S3 Bucket ${operation}: removing all tags from ${bucketName}`);
        yield* s3.deleteBucketTagging({
          Bucket: bucketName,
        });
        yield* session.note(`Removed all tags from bucket: ${bucketName}`);
        return yield* written;
      });

      const parsePolicy = (policy: string): unknown => {
        try {
          return JSON.parse(policy);
        } catch {
          return policy;
        }
      };
      const readBucketPolicy = (bucketName: string) =>
        s3.getBucketPolicy({ Bucket: bucketName }).pipe(
          Effect.map((r): unknown => (r.Policy === undefined ? undefined : parsePolicy(r.Policy))),
          Effect.catchTag("NoSuchBucketPolicy", () => Effect.undefined),
        );

      const syncBucketPolicy = Effect.fn(function* ({
        bucketName,
        bindings,
        explicitStatements,
        session,
        operation,
        previous,
      }: {
        bucketName: string;
        session: ScopedPlanStatusSession;
        bindings: ResourceBinding<Bucket["Binding"]>[];
        explicitStatements?: PolicyStatement[];
        operation: "create" | "update";
        /** The last observed projection (`output`); a divergence forces the write. */
        previous?: unknown;
      }) {
        const policyStatements = [
          ...(explicitStatements ?? []),
          ...bindings.flatMap((binding) => binding.data.policyStatements ?? []),
        ];
        const desiredPolicy =
          policyStatements.length > 0
            ? JSON.stringify({
                Version: "2012-10-17",
                Statement: policyStatements,
              })
            : undefined;
        const expected = desiredPolicy === undefined ? undefined : parsePolicy(desiredPolicy);
        const read = readBucketPolicy(bucketName);
        const matches = (observed: unknown) => deepEqual(observed, expected);
        const existingPolicy = yield* read;

        yield* Effect.logInfo(
          `S3 Bucket ${operation}: bucket=${bucketName} policyStatements=${policyStatements.length}`,
        );

        if (matches(existingPolicy) && settled(previous, existingPolicy)) {
          return existingPolicy;
        }

        if (desiredPolicy) {
          yield* Effect.logInfo(
            `S3 Bucket ${operation}: applying ${policyStatements.length} policy statement(s) to ${bucketName}`,
          );
          yield* s3.putBucketPolicy({
            Bucket: bucketName,
            Policy: desiredPolicy,
          });
          yield* session.note(`Updated bucket policy: ${bucketName}`);
          return yield* settle(read, matches);
        }

        yield* Effect.logInfo(`S3 Bucket ${operation}: deleting bucket policy for ${bucketName}`);
        yield* s3.deleteBucketPolicy({ Bucket: bucketName });
        yield* session.note(`Removed bucket policy: ${bucketName}`);
        return yield* settle(read, matches);
      });

      type NotificationTarget =
        | s3.LambdaFunctionConfiguration
        | s3.QueueConfiguration
        | s3.TopicConfiguration;
      const notificationTargetKey = (target: NotificationTarget) =>
        JSON.stringify({
          arn:
            "LambdaFunctionArn" in target
              ? target.LambdaFunctionArn
              : "QueueArn" in target
                ? target.QueueArn
                : target.TopicArn,
          events: [...(target.Events ?? [])].sort(),
          filter: (target.Filter?.Key?.FilterRules ?? [])
            .map((rule) => [rule.Name?.toLowerCase(), rule.Value])
            .sort(([a, av], [b, bv]) => `${a}:${av}`.localeCompare(`${b}:${bv}`)),
        });
      const readManagedNotifications = Effect.fn(function* (
        fqn: string,
        instanceId: string,
        output: Bucket["Attributes"] | undefined,
      ) {
        if (!output || output.managedNotificationConfiguration !== undefined) {
          return output?.managedNotificationConfiguration;
        }
        const stack = yield* Stack;
        const state = yield* yield* State;
        const row = yield* state.get({
          stack: stack.name,
          stage: stack.stage,
          fqn,
        });
        if (
          !row ||
          isActionState(row) ||
          row.resourceType !== "AWS.S3.Bucket" ||
          row.fqn !== fqn ||
          row.instanceId !== instanceId ||
          row.attr?.bucketName !== output.bucketName ||
          (row.status !== "created" &&
            row.status !== "updated" &&
            row.status !== "replaced" &&
            row.status !== "updating") ||
          (row.status === "updating" && row.adopting)
        ) {
          return undefined;
        }
        // An updating row contains the new bindings; only its old snapshot proves ownership.
        const previous = row.status === "updating" ? row.old : row;
        if (
          previous.attr?.bucketName !== output.bucketName ||
          previous.attr?.bucketArn !== output.bucketArn ||
          previous.attr?.accountId !== output.accountId ||
          previous.attr?.region !== output.region
        ) {
          return undefined;
        }
        const managed: s3.NotificationConfiguration | undefined =
          previous.attr.managedNotificationConfiguration;
        if (managed !== undefined) return managed;
        const bindings: ResourceBinding<Bucket["Binding"]>[] = previous.bindings ?? [];
        if (!isResolved(bindings)) return undefined;
        const legacy = bindings.flatMap(
          ({ data }) => data.notificationConfiguration?.LambdaFunctionConfigurations ?? [],
        );
        if (legacy.length === 0) return undefined;
        const observed = yield* s3.getBucketNotificationConfiguration({
          Bucket: output.bucketName,
        });
        return {
          LambdaFunctionConfigurations: (observed.LambdaFunctionConfigurations ?? []).filter(
            (target) =>
              legacy.some(
                (old) =>
                  (old.Id === undefined || old.Id === target.Id) &&
                  notificationTargetKey(old) === notificationTargetKey(target),
              ),
          ),
        } satisfies s3.NotificationConfiguration;
      });
      const notificationKey = (config: s3.NotificationConfiguration) => {
        const targets = (values: NotificationTarget[] = []) =>
          values.map((target) => `${target.Id ?? ""}:${notificationTargetKey(target)}`).sort();
        return JSON.stringify({
          lambda: targets(config.LambdaFunctionConfigurations),
          queue: targets(config.QueueConfigurations),
          topic: targets(config.TopicConfigurations),
          eventBridge: config.EventBridgeConfiguration !== undefined,
        });
      };
      const desiredNotifications = (
        bindings: ResourceBinding<Bucket["Binding"]>[],
        owner: string,
      ) =>
        Effect.sync(() => {
          const desired: s3.NotificationConfiguration = {
            LambdaFunctionConfigurations: [],
            QueueConfigurations: [],
            TopicConfigurations: [],
          };
          for (const { sid, data } of bindings) {
            const config = data.notificationConfiguration;
            if (!config) continue;
            const target = <T extends NotificationTarget>(value: T): T => ({
              ...value,
              Id: `${owner}${createHash("sha256")
                .update(JSON.stringify([sid, value.Id ?? notificationTargetKey(value)]))
                .digest("hex")}`,
            });
            desired.LambdaFunctionConfigurations!.push(
              ...(config.LambdaFunctionConfigurations ?? []).map(target),
            );
            desired.QueueConfigurations!.push(...(config.QueueConfigurations ?? []).map(target));
            desired.TopicConfigurations!.push(...(config.TopicConfigurations ?? []).map(target));
            if (config.EventBridgeConfiguration !== undefined) {
              desired.EventBridgeConfiguration = {};
            }
          }
          return desired;
        });
      const mergeNotifications = (
        existing: s3.NotificationConfiguration,
        desired: s3.NotificationConfiguration,
        previous: s3.NotificationConfiguration | undefined,
        owner: string,
        ownsEventBridge: boolean,
      ): s3.NotificationConfiguration => {
        const targets = <T extends NotificationTarget>(
          observed: T[] = [],
          wanted: T[] = [],
          managed: T[] = [],
        ): T[] => {
          const managedIds = new Set(managed.flatMap((target) => (target.Id ? [target.Id] : [])));
          const external = observed.filter(
            (target) =>
              !(
                target.Id?.startsWith(owner) && /^[0-9a-f]{64}$/.test(target.Id.slice(owner.length))
              ) && !managedIds.has(target.Id ?? ""),
          );
          const satisfied = new Set(external.map(notificationTargetKey));
          return [
            ...external,
            ...[...wanted]
              .sort((a, b) => (a.Id ?? "").localeCompare(b.Id ?? ""))
              .filter((target) => {
                const key = notificationTargetKey(target);
                if (satisfied.has(key)) return false;
                satisfied.add(key);
                return true;
              }),
          ];
        };
        return {
          LambdaFunctionConfigurations: targets(
            existing.LambdaFunctionConfigurations,
            desired.LambdaFunctionConfigurations,
            previous?.LambdaFunctionConfigurations,
          ),
          QueueConfigurations: targets(
            existing.QueueConfigurations,
            desired.QueueConfigurations,
            previous?.QueueConfigurations,
          ),
          TopicConfigurations: targets(
            existing.TopicConfigurations,
            desired.TopicConfigurations,
            previous?.TopicConfigurations,
          ),
          ...(desired.EventBridgeConfiguration !== undefined ||
          (existing.EventBridgeConfiguration !== undefined && !ownsEventBridge)
            ? { EventBridgeConfiguration: {} }
            : {}),
        };
      };
      /**
       * The notification targets `alchemy drift` compares: only the targets
       * Alchemy owns (stable owner-prefixed ids) and whether it owns the
       * EventBridge switch. External targets are not managed.
       */
      const projectNotifications = (
        config: s3.NotificationConfiguration,
        owner: string,
        ownsEventBridge: boolean,
      ) => {
        const owned = (targets: NotificationTarget[] = []) =>
          targets
            .filter(
              (target) =>
                target.Id?.startsWith(owner) &&
                /^[0-9a-f]{64}$/.test(target.Id.slice(owner.length)),
            )
            .map((target) => `${target.Id}:${notificationTargetKey(target)}`)
            .sort();
        const projected = {
          lambdaFunctions: owned(config.LambdaFunctionConfigurations),
          queues: owned(config.QueueConfigurations),
          topics: owned(config.TopicConfigurations),
          eventBridge: ownsEventBridge && config.EventBridgeConfiguration !== undefined,
        };
        return projected.lambdaFunctions.length === 0 &&
          projected.queues.length === 0 &&
          projected.topics.length === 0 &&
          !projected.eventBridge
          ? undefined
          : projected;
      };
      const readBucketNotifications = Effect.fn(function* (bucketName: string, owner: string) {
        const [config, tags] = yield* Effect.all(
          [
            s3.getBucketNotificationConfiguration({ Bucket: bucketName }),
            fetchBucketTags(bucketName),
          ],
          { concurrency: "unbounded" },
        );
        return projectNotifications(config, owner, tags[eventBridgeOwnerTag] === owner);
      });

      const syncBucketNotifications = Effect.fn(function* ({
        bucketName,
        bindings,
        previous,
        session,
        operation,
      }: {
        bucketName: string;
        session: ScopedPlanStatusSession;
        bindings: ResourceBinding<Bucket["Binding"]>[];
        previous: s3.NotificationConfiguration | undefined;
        operation: "create" | "update";
      }) {
        const owner = yield* notificationOwner(bucketName);
        const desired = yield* desiredNotifications(bindings, owner);
        const existing = yield* s3.getBucketNotificationConfiguration({
          Bucket: bucketName,
        });
        const tags = yield* fetchBucketTags(bucketName);
        let ownsEventBridge = tags[eventBridgeOwnerTag] === owner;
        if (
          desired.EventBridgeConfiguration !== undefined &&
          existing.EventBridgeConfiguration === undefined &&
          !ownsEventBridge
        ) {
          // Record ownership before enabling so interrupted writes remain recoverable.
          yield* s3.putBucketTagging({
            Bucket: bucketName,
            Tagging: {
              TagSet: Object.entries({
                ...tags,
                [eventBridgeOwnerTag]: owner,
              }).map(([Key, Value]) => ({ Key, Value })),
            },
          });
          ownsEventBridge = true;
        }
        const next = mergeNotifications(existing, desired, previous, owner, ownsEventBridge);
        if (notificationKey(existing) !== notificationKey(next)) {
          yield* Effect.logInfo(
            `S3 Bucket ${operation}: applying notification configuration to ${bucketName}`,
          );
          yield* s3.putBucketNotificationConfiguration({
            Bucket: bucketName,
            NotificationConfiguration: next,
            // Destination policies can reconcile later in the same binding cycle.
            SkipDestinationValidation: true,
          });
          yield* session.note(`Updated bucket notifications: ${bucketName}`);
        }
        if (desired.EventBridgeConfiguration === undefined && ownsEventBridge) {
          delete tags[eventBridgeOwnerTag];
          if (Object.keys(tags).length > 0) {
            yield* s3.putBucketTagging({
              Bucket: bucketName,
              Tagging: {
                TagSet: Object.entries(tags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              },
            });
          } else {
            yield* s3.deleteBucketTagging({ Bucket: bucketName });
          }
        }
        const expected = projectNotifications(
          next,
          owner,
          desired.EventBridgeConfiguration !== undefined,
        );
        const observed = yield* settle(readBucketNotifications(bucketName, owner), (observed) =>
          deepEqual(observed, expected),
        );
        return { managed: desired, observed };
      });

      // ---- Bucket configuration sync helpers ------------------------------
      // Each aspect has a read (the live cloud state), a projection (the
      // canonical shape `alchemy drift` compares) and a sync helper that
      // diffs observed against desired, applies only the delta, and returns
      // the projection it converged to. `read` reuses the same read and
      // projection, so a converged bucket reads unchanged. An aspect whose
      // prop is unset is unmanaged: it is neither synced nor observed.
      // The "not configured" read error for each aspect is already a typed
      // tag in distilled (see processes/AWS/catalog/S3.md), so we
      // `Effect.catchTag` it rather than inspecting status codes.

      /**
       * Re-read after a write until S3 reports the desired state: bucket
       * configuration is eventually consistent. Returns the last observation
       * either way, so attributes record what S3 reports.
       */
      const settle = <A, E, R>(read: Effect.Effect<A, E, R>, matches: (observed: A) => boolean) =>
        read.pipe(
          Effect.repeat({
            until: matches,
            schedule: Schedule.spaced("1 second"),
            times: 8,
          }),
        );

      /**
       * S3 can serve a stale read, so a sync may only skip its write when the
       * last observation (`output`, which drift fills with what it just read)
       * agrees with the current read. `undefined` (no observation yet, or a
       * row from before the attribute existed) is no evidence either way.
       */
      const settled = (previous: unknown, current: unknown) =>
        previous === undefined || deepEqual(previous, current);

      const projectVersioning = (
        current: s3.GetBucketVersioningOutput,
        versioning: BucketProps["versioning"],
        mfaDelete: BucketProps["mfaDelete"],
      ) => ({
        versioning: versioning === undefined ? undefined : current.Status,
        mfaDelete: mfaDelete === undefined ? undefined : (current.MFADelete ?? "Disabled"),
      });

      const syncBucketVersioning = Effect.fn(function* ({
        bucketName,
        versioning,
        mfaDelete,
        session,
        previous,
      }: {
        bucketName: string;
        versioning?: "Enabled" | "Suspended";
        mfaDelete?: "Enabled" | "Disabled";
        session: ScopedPlanStatusSession;
        /** The last observed projection (`output`); a divergence forces the write. */
        previous?: unknown;
      }) {
        if (versioning === undefined && mfaDelete === undefined) {
          return projectVersioning({}, versioning, mfaDelete);
        }
        const read = s3.getBucketVersioning({ Bucket: bucketName });
        const matches = (current: s3.GetBucketVersioningOutput) =>
          deepEqual(projectVersioning(current, versioning, mfaDelete), { versioning, mfaDelete });
        const current = yield* read;
        if (
          matches(current) &&
          settled(previous, projectVersioning(current, versioning, mfaDelete))
        ) {
          return projectVersioning(current, versioning, mfaDelete);
        }
        yield* s3.putBucketVersioning({
          Bucket: bucketName,
          VersioningConfiguration: {
            Status: versioning,
            MFADelete: mfaDelete,
          },
        });
        yield* session.note(`Updated bucket versioning: ${bucketName}`);
        return projectVersioning(yield* settle(read, matches), versioning, mfaDelete);
      });

      const readPublicAccessBlock = (bucketName: string) =>
        s3.getPublicAccessBlock({ Bucket: bucketName }).pipe(
          Effect.map((r) => r.PublicAccessBlockConfiguration),
          Effect.catchTag("NoSuchPublicAccessBlockConfiguration", () => Effect.undefined),
        );

      const projectPublicAccessBlock = (
        c: s3.PublicAccessBlockConfiguration | undefined,
      ): Required<BucketPublicAccessBlock> => ({
        blockPublicAcls: c?.BlockPublicAcls ?? false,
        ignorePublicAcls: c?.IgnorePublicAcls ?? false,
        blockPublicPolicy: c?.BlockPublicPolicy ?? false,
        restrictPublicBuckets: c?.RestrictPublicBuckets ?? false,
      });

      const syncPublicAccessBlock = Effect.fn(function* ({
        bucketName,
        publicAccessBlock,
        session,
        previous,
      }: {
        bucketName: string;
        publicAccessBlock?: BucketPublicAccessBlock;
        session: ScopedPlanStatusSession;
        /** The last observed projection (`output`); a divergence forces the write. */
        previous?: unknown;
      }) {
        if (publicAccessBlock === undefined) return undefined;
        const desired: s3.PublicAccessBlockConfiguration = {
          BlockPublicAcls: publicAccessBlock.blockPublicAcls ?? false,
          IgnorePublicAcls: publicAccessBlock.ignorePublicAcls ?? false,
          BlockPublicPolicy: publicAccessBlock.blockPublicPolicy ?? false,
          RestrictPublicBuckets: publicAccessBlock.restrictPublicBuckets ?? false,
        };
        const read = readPublicAccessBlock(bucketName).pipe(Effect.map(projectPublicAccessBlock));
        const matches = (current: Required<BucketPublicAccessBlock>) =>
          deepEqual(current, projectPublicAccessBlock(desired));
        const current = yield* read;
        if (matches(current) && settled(previous, current)) return current;
        yield* s3.putPublicAccessBlock({
          Bucket: bucketName,
          PublicAccessBlockConfiguration: desired,
        });
        yield* session.note(`Updated public access block: ${bucketName}`);
        return yield* settle(read, matches);
      });

      // Drop S3-assigned `ID`s and sort member arrays so re-ordering
      // doesn't read as drift.
      const projectCors = (rules: readonly s3.CORSRule[]) =>
        Arr.map(rules, (r) => ({
          AllowedHeaders: Arr.sort(r.AllowedHeaders ?? [], Order.String),
          AllowedMethods: Arr.sort(r.AllowedMethods ?? [], Order.String),
          AllowedOrigins: Arr.sort(r.AllowedOrigins ?? [], Order.String),
          ExposeHeaders: Arr.sort(r.ExposeHeaders ?? [], Order.String),
          MaxAgeSeconds: r.MaxAgeSeconds,
        }));

      const readBucketCors = (bucketName: string) =>
        s3.getBucketCors({ Bucket: bucketName }).pipe(
          Effect.map((r) => projectCors(r.CORSRules ?? [])),
          Effect.catchTag("NoSuchCORSConfiguration", () =>
            Effect.succeed<ReturnType<typeof projectCors>>([]),
          ),
        );

      const syncBucketCors = Effect.fn(function* ({
        bucketName,
        cors,
        session,
        previous,
      }: {
        bucketName: string;
        cors?: s3.CORSRule[];
        session: ScopedPlanStatusSession;
        /** The last observed projection (`output`); a divergence forces the write. */
        previous?: unknown;
      }) {
        if (cors === undefined) return undefined;
        const read = readBucketCors(bucketName);
        const matches = (current: ReturnType<typeof projectCors>) =>
          deepEqual(current, projectCors(cors));
        const current = yield* read;
        if (matches(current) && settled(previous, current)) return current;
        if (cors.length === 0) {
          yield* s3.deleteBucketCors({ Bucket: bucketName });
          yield* session.note(`Removed bucket CORS: ${bucketName}`);
        } else {
          yield* s3.putBucketCors({
            Bucket: bucketName,
            CORSConfiguration: { CORSRules: cors },
          });
          yield* session.note(`Updated bucket CORS: ${bucketName}`);
        }
        return yield* settle(read, matches);
      });

      const projectLifecycle = (rules: readonly s3.LifecycleRule[]) =>
        Arr.sort(
          Arr.map(rules, (r) => ({ ...r })),
          Order.mapInput(Order.String, (r: s3.LifecycleRule) => r.ID ?? ""),
        );

      const readBucketLifecycle = (bucketName: string) =>
        s3.getBucketLifecycleConfiguration({ Bucket: bucketName }).pipe(
          Effect.map((r) => projectLifecycle(r.Rules ?? [])),
          Effect.catchTag("NoSuchLifecycleConfiguration", () =>
            Effect.succeed<s3.LifecycleRule[]>([]),
          ),
        );

      const syncBucketLifecycle = Effect.fn(function* ({
        bucketName,
        lifecycleRules,
        session,
        previous,
      }: {
        bucketName: string;
        lifecycleRules?: s3.LifecycleRule[];
        session: ScopedPlanStatusSession;
        /** The last observed projection (`output`); a divergence forces the write. */
        previous?: unknown;
      }) {
        if (lifecycleRules === undefined) return undefined;
        const read = readBucketLifecycle(bucketName);
        const matches = (current: s3.LifecycleRule[]) =>
          deepEqual(current, projectLifecycle(lifecycleRules));
        const current = yield* read;
        if (matches(current) && settled(previous, current)) return current;
        if (lifecycleRules.length === 0) {
          yield* s3.deleteBucketLifecycle({ Bucket: bucketName });
          yield* session.note(`Removed bucket lifecycle: ${bucketName}`);
        } else {
          yield* s3.putBucketLifecycleConfiguration({
            Bucket: bucketName,
            LifecycleConfiguration: { Rules: lifecycleRules },
          });
          yield* session.note(`Updated bucket lifecycle: ${bucketName}`);
        }
        return yield* settle(read, matches);
      });

      const readBucketOwnershipControls = (bucketName: string) =>
        s3.getBucketOwnershipControls({ Bucket: bucketName }).pipe(
          Effect.map((r) => r.OwnershipControls?.Rules?.[0]?.ObjectOwnership),
          Effect.catchTag("OwnershipControlsNotFoundError", () => Effect.undefined),
        );

      const syncBucketOwnershipControls = Effect.fn(function* ({
        bucketName,
        objectOwnership,
        session,
        previous,
      }: {
        bucketName: string;
        objectOwnership?: "BucketOwnerPreferred" | "ObjectWriter" | "BucketOwnerEnforced";
        session: ScopedPlanStatusSession;
        /** The last observed projection (`output`); a divergence forces the write. */
        previous?: unknown;
      }) {
        if (objectOwnership === undefined) return undefined;
        const read = readBucketOwnershipControls(bucketName);
        const current = yield* read;
        if (current === objectOwnership && settled(previous, current)) return current;
        yield* s3.putBucketOwnershipControls({
          Bucket: bucketName,
          OwnershipControls: {
            Rules: [{ ObjectOwnership: objectOwnership }],
          },
        });
        yield* session.note(`Updated object ownership: ${bucketName}`);
        return yield* settle(read, (observed) => observed === objectOwnership);
      });

      // S3 has no canned-ACL read: compare the grants a canned ACL expands
      // to (owner grants excluded) with the observed grants.
      const projectAclGrants = (acl: s3.GetBucketAclOutput) =>
        Arr.sort(
          (acl.Grants ?? []).flatMap(({ Grantee: grantee, Permission: permission }) => {
            if (grantee?.ID !== undefined && grantee.ID === acl.Owner?.ID) return [];
            const who =
              grantee?.URI?.split("/").pop() ??
              (grantee?.ID ? `id:${grantee.ID}` : `email:${grantee?.EmailAddress ?? ""}`);
            return [`${who}:${permission}`];
          }),
          Order.String,
        );
      const cannedAclGrants: Partial<Record<s3.BucketCannedACL, string[]>> = {
        private: [],
        "public-read": ["AllUsers:READ"],
        "public-read-write": ["AllUsers:READ", "AllUsers:WRITE"],
        "authenticated-read": ["AuthenticatedUsers:READ"],
      };

      const syncBucketAcl = Effect.fn(function* ({
        bucketName,
        acl,
        session,
        previous,
      }: {
        bucketName: string;
        acl?: s3.BucketCannedACL;
        session: ScopedPlanStatusSession;
        /** The last observed projection (`output`); a divergence forces the write. */
        previous?: unknown;
      }) {
        if (acl === undefined) return undefined;
        const read = s3.getBucketAcl({ Bucket: bucketName }).pipe(Effect.map(projectAclGrants));
        const expected = cannedAclGrants[acl];
        const matches = (grants: string[]) => expected !== undefined && deepEqual(grants, expected);
        const current = yield* read;
        if (matches(current) && settled(previous, current)) return current;
        // putBucketAcl is idempotent for canned ACLs; an ACL whose grants we
        // can't predict is applied on every reconcile.
        yield* s3.putBucketAcl({ Bucket: bucketName, ACL: acl });
        yield* session.note(`Updated bucket ACL: ${bucketName}`);
        return expected === undefined ? yield* read : yield* settle(read, matches);
      });

      const projectLogging = (logging: s3.LoggingEnabled | undefined) =>
        logging === undefined
          ? undefined
          : {
              targetBucket: logging.TargetBucket,
              targetPrefix: logging.TargetPrefix,
              targetGrants: logging.TargetGrants?.length ? logging.TargetGrants : undefined,
            };

      const readBucketLogging = (bucketName: string) =>
        s3
          .getBucketLogging({ Bucket: bucketName })
          .pipe(Effect.map((r) => projectLogging(r.LoggingEnabled)));

      const syncBucketLogging = Effect.fn(function* ({
        bucketName,
        logging,
        session,
        previous,
      }: {
        bucketName: string;
        logging?: BucketLogging;
        session: ScopedPlanStatusSession;
        /** The last observed projection (`output`); a divergence forces the write. */
        previous?: unknown;
      }) {
        if (logging === undefined) return undefined;
        const desired: s3.LoggingEnabled = {
          TargetBucket: logging.targetBucket,
          TargetPrefix: logging.targetPrefix,
          TargetGrants: logging.targetGrants,
          TargetObjectKeyFormat: logging.targetObjectKeyFormat,
        };
        const read = readBucketLogging(bucketName);
        const matches = (current: ReturnType<typeof projectLogging>) =>
          deepEqual(current, projectLogging(desired));
        const current = yield* read;
        if (matches(current) && settled(previous, current)) return current;
        yield* s3.putBucketLogging({
          Bucket: bucketName,
          BucketLoggingStatus: { LoggingEnabled: desired },
        });
        yield* session.note(`Updated bucket logging: ${bucketName}`);
        return yield* settle(read, matches);
      });

      const readTransferAcceleration = (bucketName: string) =>
        s3
          .getBucketAccelerateConfiguration({ Bucket: bucketName })
          .pipe(Effect.map((r) => r.Status));

      const syncTransferAcceleration = Effect.fn(function* ({
        bucketName,
        transferAcceleration,
        session,
        previous,
      }: {
        bucketName: string;
        transferAcceleration?: "Enabled" | "Suspended";
        session: ScopedPlanStatusSession;
        /** The last observed projection (`output`); a divergence forces the write. */
        previous?: unknown;
      }) {
        if (transferAcceleration === undefined) return undefined;
        const read = readTransferAcceleration(bucketName);
        const current = yield* read;
        if (current === transferAcceleration && settled(previous, current)) return current;
        yield* s3.putBucketAccelerateConfiguration({
          Bucket: bucketName,
          AccelerateConfiguration: { Status: transferAcceleration },
        });
        yield* session.note(`Updated transfer acceleration: ${bucketName}`);
        return yield* settle(read, (observed) => observed === transferAcceleration);
      });

      const readRequestPayment = (bucketName: string) =>
        s3.getBucketRequestPayment({ Bucket: bucketName }).pipe(Effect.map((r) => r.Payer));

      const syncRequestPayment = Effect.fn(function* ({
        bucketName,
        requestPayer,
        session,
        previous,
      }: {
        bucketName: string;
        requestPayer?: "BucketOwner" | "Requester";
        session: ScopedPlanStatusSession;
        /** The last observed projection (`output`); a divergence forces the write. */
        previous?: unknown;
      }) {
        if (requestPayer === undefined) return undefined;
        const read = readRequestPayment(bucketName);
        const current = yield* read;
        if (current === requestPayer && settled(previous, current)) return current;
        yield* s3.putBucketRequestPayment({
          Bucket: bucketName,
          RequestPaymentConfiguration: { Payer: requestPayer },
        });
        yield* session.note(`Updated request payment: ${bucketName}`);
        return yield* settle(read, (observed) => observed === requestPayer);
      });

      const projectWebsite = (
        w: s3.GetBucketWebsiteOutput | s3.WebsiteConfiguration | undefined,
      ) => ({
        indexDocument: w?.IndexDocument,
        errorDocument: w?.ErrorDocument,
        redirectAllRequestsTo: w?.RedirectAllRequestsTo,
        routingRules: w?.RoutingRules,
      });

      const readBucketWebsite = (bucketName: string) =>
        s3.getBucketWebsite({ Bucket: bucketName }).pipe(
          Effect.map(projectWebsite),
          Effect.catchTag("NoSuchWebsiteConfiguration", () =>
            Effect.succeed(projectWebsite(undefined)),
          ),
        );

      const syncBucketWebsite = Effect.fn(function* ({
        bucketName,
        website,
        session,
        previous,
      }: {
        bucketName: string;
        website?: BucketWebsite;
        session: ScopedPlanStatusSession;
        /** The last observed projection (`output`); a divergence forces the write. */
        previous?: unknown;
      }) {
        if (website === undefined) return undefined;
        const desired: s3.WebsiteConfiguration = {
          IndexDocument: website.indexDocument
            ? { Suffix: website.indexDocument.suffix }
            : undefined,
          ErrorDocument: website.errorDocument ? { Key: website.errorDocument.key } : undefined,
          RedirectAllRequestsTo: website.redirectAllRequestsTo
            ? {
                HostName: website.redirectAllRequestsTo.hostName,
                Protocol: website.redirectAllRequestsTo.protocol,
              }
            : undefined,
          RoutingRules: website.routingRules,
        };
        const read = readBucketWebsite(bucketName);
        const matches = (current: ReturnType<typeof projectWebsite>) =>
          deepEqual(current, projectWebsite(desired));
        const current = yield* read;
        if (matches(current) && settled(previous, current)) return current;
        yield* s3.putBucketWebsite({
          Bucket: bucketName,
          WebsiteConfiguration: desired,
        });
        yield* session.note(`Updated bucket website: ${bucketName}`);
        return yield* settle(read, matches);
      });

      const projectReplication = (
        cfg: { Role?: string; Rules?: readonly s3.ReplicationRule[] } | undefined,
      ) =>
        cfg === undefined
          ? undefined
          : {
              role: cfg.Role,
              rules: Arr.sort(
                Arr.map(cfg.Rules ?? [], (r) => ({ ...r })),
                Order.mapInput(Order.String, (r: s3.ReplicationRule) => r.ID ?? ""),
              ),
            };

      const readBucketReplication = (bucketName: string) =>
        s3.getBucketReplication({ Bucket: bucketName }).pipe(
          Effect.map((r) => projectReplication(r.ReplicationConfiguration)),
          Effect.catchTag("ReplicationConfigurationNotFoundError", () =>
            Effect.succeed(projectReplication(undefined)),
          ),
        );

      const syncBucketReplication = Effect.fn(function* ({
        bucketName,
        replication,
        session,
        previous,
      }: {
        bucketName: string;
        replication?: BucketReplication;
        session: ScopedPlanStatusSession;
        /** The last observed projection (`output`); a divergence forces the write. */
        previous?: unknown;
      }) {
        if (replication === undefined) return undefined;
        const desired: s3.ReplicationConfiguration = {
          Role: replication.role,
          Rules: replication.rules,
        };
        const read = readBucketReplication(bucketName);
        const matches = (current: ReturnType<typeof projectReplication>) =>
          deepEqual(current, projectReplication(desired));
        const current = yield* read;
        if (matches(current) && settled(previous, current)) return current;
        yield* s3.putBucketReplication({
          Bucket: bucketName,
          ReplicationConfiguration: desired,
        });
        yield* session.note(`Updated bucket replication: ${bucketName}`);
        return yield* settle(read, matches);
      });

      const readIntelligentTiering = (bucketName: string, id: string) =>
        s3
          .getBucketIntelligentTieringConfiguration({
            Bucket: bucketName,
            Id: id,
          })
          .pipe(
            Effect.map((r) => r.IntelligentTieringConfiguration),
            Effect.catchTag("NoSuchConfiguration", () => Effect.undefined),
          );

      // The declared configurations, observed per id (the per-id read is
      // read-after-write consistent; `list` is not).
      const observeIntelligentTiering = (
        bucketName: string,
        intelligentTiering: s3.IntelligentTieringConfiguration[],
      ) =>
        Effect.forEach(
          Arr.sort(
            Arr.map(intelligentTiering, (c) => c.Id),
            Order.String,
          ),
          (id) => readIntelligentTiering(bucketName, id),
        );

      const syncIntelligentTiering = Effect.fn(function* ({
        bucketName,
        intelligentTiering,
        oldIntelligentTiering,
        session,
      }: {
        bucketName: string;
        intelligentTiering?: s3.IntelligentTieringConfiguration[];
        oldIntelligentTiering?: s3.IntelligentTieringConfiguration[];
        session: ScopedPlanStatusSession;
      }) {
        if (intelligentTiering === undefined) return undefined;
        const desiredById = new Map(Arr.map(intelligentTiering, (c) => [c.Id, c] as const));
        // Reconcile each desired id: put when missing or changed.
        for (const [id, desired] of desiredById) {
          const current = yield* readIntelligentTiering(bucketName, id);
          if (deepEqual(current, desired)) continue;
          yield* s3.putBucketIntelligentTieringConfiguration({
            Bucket: bucketName,
            Id: id,
            IntelligentTieringConfiguration: desired,
          });
          yield* session.note(`Updated intelligent-tiering ${id}: ${bucketName}`);
        }
        // Remove ids that were previously declared but are no longer desired.
        // `list` is eventually-consistent, so diff against the prior props
        // (when available) and fall back to listing for adoption. Each delete
        // tolerates a config that is already gone.
        const removedIds = new Set<string>();
        for (const old of oldIntelligentTiering ?? []) {
          if (old.Id && !desiredById.has(old.Id)) removedIds.add(old.Id);
        }
        if (oldIntelligentTiering === undefined) {
          const observed = yield* s3
            .listBucketIntelligentTieringConfigurations({ Bucket: bucketName })
            .pipe(Effect.map((r) => r.IntelligentTieringConfigurationList ?? []));
          for (const cfg of observed) {
            if (cfg.Id && !desiredById.has(cfg.Id)) removedIds.add(cfg.Id);
          }
        }
        for (const id of removedIds) {
          // delete is idempotent server-side (no NoSuchConfiguration in the
          // typed error union), so a missing id is simply a no-op.
          yield* s3.deleteBucketIntelligentTieringConfiguration({
            Bucket: bucketName,
            Id: id,
          });
          yield* session.note(`Removed intelligent-tiering ${id}: ${bucketName}`);
        }
        return yield* observeIntelligentTiering(bucketName, intelligentTiering);
      });

      const projectObjectLockRetention = (r: s3.DefaultRetention | undefined) => ({
        mode: r?.Mode,
        days: r?.Days,
        years: r?.Years,
      });

      const readObjectLockRetention = (bucketName: string) =>
        s3.getObjectLockConfiguration({ Bucket: bucketName }).pipe(
          Effect.map((r) =>
            projectObjectLockRetention(r.ObjectLockConfiguration?.Rule?.DefaultRetention),
          ),
          Effect.catchTag("ObjectLockConfigurationNotFoundError", () =>
            Effect.succeed(projectObjectLockRetention(undefined)),
          ),
        );

      const syncObjectLockRetention = Effect.fn(function* ({
        bucketName,
        objectLockConfiguration,
        session,
        previous,
      }: {
        bucketName: string;
        objectLockConfiguration?: BucketObjectLockConfiguration;
        session: ScopedPlanStatusSession;
        /** The last observed projection (`output`); a divergence forces the write. */
        previous?: unknown;
      }) {
        if (objectLockConfiguration === undefined) return undefined;
        const desired: s3.DefaultRetention = {
          Mode: objectLockConfiguration.mode,
          Days: durationToDays(objectLockConfiguration.days),
          Years: objectLockConfiguration.years,
        };
        const read = readObjectLockRetention(bucketName);
        const matches = (current: ReturnType<typeof projectObjectLockRetention>) =>
          deepEqual(current, projectObjectLockRetention(desired));
        const current = yield* read;
        if (matches(current) && settled(previous, current)) return current;
        yield* s3.putObjectLockConfiguration({
          Bucket: bucketName,
          ObjectLockConfiguration: {
            ObjectLockEnabled: "Enabled",
            Rule: { DefaultRetention: desired },
          },
        });
        yield* session.note(`Updated object-lock retention: ${bucketName}`);
        return yield* settle(read, matches);
      });

      /**
       * Observe every managed aspect of a bucket as `read` reports it: the
       * same projections the sync helpers return from `reconcile`.
       */
      const observeBucketConfiguration = Effect.fn(function* (
        bucketName: string,
        props: BucketProps,
      ) {
        const owner = yield* notificationOwner(bucketName);
        const managed = <A, E, R>(isManaged: boolean, read: () => Effect.Effect<A, E, R>) =>
          isManaged ? read() : Effect.undefined;
        return yield* Effect.all(
          {
            tags: readBucketTags(bucketName),
            policy: readBucketPolicy(bucketName),
            encryption: readBucketEncryption(bucketName).pipe(Effect.map(projectEncryption)),
            notifications: readBucketNotifications(bucketName, owner),
            versioning: managed(
              props.versioning !== undefined || props.mfaDelete !== undefined,
              () =>
                s3
                  .getBucketVersioning({ Bucket: bucketName })
                  .pipe(
                    Effect.map((current) =>
                      projectVersioning(current, props.versioning, props.mfaDelete),
                    ),
                  ),
            ),
            publicAccessBlock: managed(props.publicAccessBlock !== undefined, () =>
              readPublicAccessBlock(bucketName).pipe(Effect.map(projectPublicAccessBlock)),
            ),
            cors: managed(props.cors !== undefined, () => readBucketCors(bucketName)),
            lifecycleRules: managed(props.lifecycleRules !== undefined, () =>
              readBucketLifecycle(bucketName),
            ),
            objectOwnership: managed(props.objectOwnership !== undefined, () =>
              readBucketOwnershipControls(bucketName),
            ),
            aclGrants: managed(props.acl !== undefined, () =>
              s3.getBucketAcl({ Bucket: bucketName }).pipe(Effect.map(projectAclGrants)),
            ),
            logging: managed(props.logging !== undefined, () => readBucketLogging(bucketName)),
            transferAcceleration: managed(props.transferAcceleration !== undefined, () =>
              readTransferAcceleration(bucketName),
            ),
            requestPayer: managed(props.requestPayer !== undefined, () =>
              readRequestPayment(bucketName),
            ),
            website: managed(props.website !== undefined, () => readBucketWebsite(bucketName)),
            replication: managed(props.replication !== undefined, () =>
              readBucketReplication(bucketName),
            ),
            intelligentTiering: managed(props.intelligentTiering !== undefined, () =>
              observeIntelligentTiering(bucketName, props.intelligentTiering ?? []),
            ),
            objectLockConfiguration: managed(props.objectLockConfiguration !== undefined, () =>
              readObjectLockRetention(bucketName),
            ),
          },
          { concurrency: 8 },
        ).pipe(
          Effect.map(({ versioning, ...observed }) => ({
            ...observed,
            versioning: versioning?.versioning,
            mfaDelete: versioning?.mfaDelete,
          })),
        );
      });

      return {
        stables: ["bucketName", "bucketArn", "region", "accountId"],
        // ListBuckets enumerates this account. Read verifies the same ownership
        // with ExpectedBucketOwner; cross-account access alone is not ownership.
        // GetBucketLocation needs configuration access, not HeadBucket's
        // s3:ListBucket permission to enumerate the bucket's objects.
        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            // S3 only includes `BucketRegion` in the response when the request
            // carries at least one parameter — hence the explicit MaxBuckets.
            return yield* s3.listBuckets.pages({ MaxBuckets: 1000 }).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.Buckets ?? [])
                    .filter((b): b is s3.Bucket & { Name: string } => b.Name != null)
                    .map((b) => {
                      // ListBuckets is global — record each bucket's actual
                      // region so later operations (delete) can target it.
                      const bucketRegion = (b.BucketRegion ?? region) as RegionID;
                      return {
                        bucketName: b.Name,
                        bucketArn: `arn:aws:s3:::${b.Name}` as const,
                        bucketDomainName: `${b.Name}.s3.amazonaws.com` as const,
                        bucketRegionalDomainName:
                          `${b.Name}.s3.${bucketRegion}.amazonaws.com` as const,
                        region: bucketRegion,
                        accountId,
                      };
                    }),
                ),
              ),
            );
          }),
        read: Effect.fn(function* ({ id, fqn, instanceId, olds, output }) {
          const bucketName = output?.bucketName ?? (yield* createBucketName(id, olds ?? {}));
          const { accountId, region } = yield* AWSEnvironment.current;
          const exists = yield* s3
            .getBucketLocation({
              Bucket: bucketName,
              ExpectedBucketOwner: accountId,
            })
            .pipe(
              Effect.map(() => true),
              Effect.catchTag("NoSuchBucket", () => Effect.succeed(false)),
            );
          if (!exists) return undefined;
          return {
            bucketName,
            bucketArn: `arn:aws:s3:::${bucketName}` as const,
            bucketDomainName: `${bucketName}.s3.amazonaws.com` as const,
            bucketRegionalDomainName: `${bucketName}.s3.${region}.amazonaws.com` as const,
            region,
            accountId,
            managedNotificationConfiguration: yield* readManagedNotifications(
              fqn,
              instanceId,
              output,
            ),
            ...(yield* observeBucketConfiguration(bucketName, olds ?? {})),
          };
        }),
        diff: Effect.fn(function* ({
          id,
          fqn,
          instanceId,
          news = {},
          olds = {},
          output,
          newBindings,
        }) {
          if (!isResolved(news)) return undefined;
          const oldBucketName = yield* createBucketName(id, olds);
          const newBucketName = yield* createBucketName(id, news);
          yield* Effect.logInfo(
            `S3 Bucket diff: old=${oldBucketName} new=${newBucketName} oldObjectLock=${olds.objectLockEnabled ?? false} newObjectLock=${news.objectLockEnabled ?? false}`,
          );
          if (oldBucketName !== newBucketName) {
            yield* Effect.logInfo(
              `S3 Bucket diff: replacing bucket because name changed from ${oldBucketName} to ${newBucketName}`,
            );
            return { action: "replace" } as const;
          }
          // Object lock can only be enabled at creation time
          if ((olds.objectLockEnabled ?? false) !== (news.objectLockEnabled ?? false)) {
            yield* Effect.logInfo(
              `S3 Bucket diff: replacing bucket because object lock changed for ${newBucketName}`,
            );
            return { action: "replace" } as const;
          }
          if (output) {
            const observed = yield* readBucketEncryption(output.bucketName).pipe(
              Effect.catchTag("NoSuchBucket", () => Effect.undefined),
            );
            if (
              encryptionFingerprint(observed) !==
              encryptionFingerprint(desiredEncryptionRule(news.encryption))
            ) {
              return { action: "update" } as const;
            }
            const previous = yield* readManagedNotifications(fqn, instanceId, output);
            if (output.managedNotificationConfiguration === undefined && previous !== undefined) {
              return { action: "update" } as const;
            }
            const owner = yield* notificationOwner(output.bucketName);
            const desired = isResolved(newBindings)
              ? yield* desiredNotifications(newBindings, owner)
              : previous;
            if (desired) {
              const notifications = yield* s3
                .getBucketNotificationConfiguration({
                  Bucket: output.bucketName,
                })
                .pipe(Effect.catchTag("NoSuchBucket", () => Effect.undefined));
              const tags: Record<string, string> = notifications
                ? yield* fetchBucketTags(output.bucketName)
                : {};
              if (
                notifications &&
                ((desired.EventBridgeConfiguration === undefined &&
                  tags[eventBridgeOwnerTag] === owner) ||
                  notificationKey(notifications) !==
                    notificationKey(
                      mergeNotifications(
                        notifications,
                        desired,
                        previous,
                        owner,
                        tags[eventBridgeOwnerTag] === owner,
                      ),
                    ))
              ) {
                return { action: "update" } as const;
              }
            }
          }
        }),
        precreate: (props) => ensureBucketExists(props),
        reconcile: Effect.fn(function* ({
          id,
          fqn,
          instanceId,
          news = {},
          olds,
          output,
          session,
          bindings,
        }) {
          const operation = output === undefined ? "create" : "update";
          const resolved = output ?? (yield* ensureBucketExists({ id, news }));

          const tags = yield* syncBucketTags({
            bucketName: resolved.bucketName,
            previous: output?.tags,
            // Omit `oldTags` so syncBucketTags fetches the cloud's actual
            // current tags. This makes drift detection correct even after
            // a cold-start adoption where olds.tags would equal news.tags.
            newTags: news.tags,
            session,
            operation,
          });

          // Ownership + public-access-block must precede any ACL/policy that
          // grants public access, else those puts can fail with AccessDenied.
          const objectOwnership = yield* syncBucketOwnershipControls({
            bucketName: resolved.bucketName,
            previous: output?.objectOwnership,
            objectOwnership: news.objectOwnership,
            session,
          });

          const publicAccessBlock = yield* syncPublicAccessBlock({
            bucketName: resolved.bucketName,
            previous: output?.publicAccessBlock,
            publicAccessBlock: news.publicAccessBlock,
            session,
          });

          // Versioning before replication (replication requires it enabled).
          const versioning = yield* syncBucketVersioning({
            bucketName: resolved.bucketName,
            previous:
              output?.versioning === undefined && output?.mfaDelete === undefined
                ? undefined
                : { versioning: output.versioning, mfaDelete: output.mfaDelete },
            versioning: news.versioning,
            mfaDelete: news.mfaDelete,
            session,
          });

          if (
            yield* syncBucketEncryption(resolved.bucketName, news.encryption, output?.encryption)
          ) {
            yield* session.note(`Updated bucket encryption: ${resolved.bucketName}`);
          }
          const encryption = projectEncryption(yield* readBucketEncryption(resolved.bucketName));

          const cors = yield* syncBucketCors({
            bucketName: resolved.bucketName,
            previous: output?.cors,
            cors: news.cors,
            session,
          });

          const lifecycleRules = yield* syncBucketLifecycle({
            bucketName: resolved.bucketName,
            previous: output?.lifecycleRules,
            lifecycleRules: news.lifecycleRules,
            session,
          });

          const logging = yield* syncBucketLogging({
            bucketName: resolved.bucketName,
            previous: output?.logging,
            logging: news.logging,
            session,
          });

          const transferAcceleration = yield* syncTransferAcceleration({
            bucketName: resolved.bucketName,
            previous: output?.transferAcceleration,
            transferAcceleration: news.transferAcceleration,
            session,
          });

          const requestPayer = yield* syncRequestPayment({
            bucketName: resolved.bucketName,
            previous: output?.requestPayer,
            requestPayer: news.requestPayer,
            session,
          });

          const website = yield* syncBucketWebsite({
            bucketName: resolved.bucketName,
            previous: output?.website,
            website: news.website,
            session,
          });

          const replication = yield* syncBucketReplication({
            bucketName: resolved.bucketName,
            previous: output?.replication,
            replication: news.replication,
            session,
          });

          const intelligentTiering = yield* syncIntelligentTiering({
            bucketName: resolved.bucketName,
            intelligentTiering: news.intelligentTiering,
            oldIntelligentTiering: olds?.intelligentTiering,
            session,
          });

          const objectLockConfiguration = yield* syncObjectLockRetention({
            bucketName: resolved.bucketName,
            previous: output?.objectLockConfiguration,
            objectLockConfiguration: news.objectLockConfiguration,
            session,
          });

          // ACL after ownership/public-access-block.
          const aclGrants = yield* syncBucketAcl({
            bucketName: resolved.bucketName,
            previous: output?.aclGrants,
            acl: news.acl,
            session,
          });

          const policy = yield* syncBucketPolicy({
            bucketName: resolved.bucketName,
            previous: output?.policy,
            bindings,
            explicitStatements: news.policy,
            session,
            operation,
          });

          const notifications = yield* syncBucketNotifications({
            bucketName: resolved.bucketName,
            bindings,
            previous: yield* readManagedNotifications(fqn, instanceId, output),
            session,
            operation,
          });

          if (operation === "create") {
            yield* session.note(`Ensured bucket: ${resolved.bucketName}`);
          }

          return {
            ...resolved,
            managedNotificationConfiguration: notifications.managed,
            tags,
            policy,
            encryption,
            notifications: notifications.observed,
            versioning: versioning.versioning,
            mfaDelete: versioning.mfaDelete,
            publicAccessBlock,
            cors,
            lifecycleRules,
            objectOwnership,
            aclGrants,
            logging,
            transferAcceleration,
            requestPayer,
            website,
            replication,
            intelligentTiering,
            objectLockConfiguration,
          };
        }),
        delete: Effect.fn(function* ({ olds = {}, output, session, force }) {
          // Whether we are allowed to destroy the bucket's contents.
          // - `olds.forceDestroy` — the user opted in on the resource props.
          // - `force` — set only by `alchemy unsafe nuke`, an explicit
          //   operator-confirmed account teardown. Nuke enumerates buckets
          //   straight from the cloud (its `olds` is Attributes, not Props),
          //   so `forceDestroy` is never present there. S3 ownership is
          //   account-level: list enumerates this account and read verifies
          //   ExpectedBucketOwner. This provider deliberately does not stamp
          //   alchemy tags on buckets, so every bucket nuke hands us is one
          //   this account owns.
          // A normal destroy without `forceDestroy` must NOT empty the
          // bucket — a non-empty bucket fails with BucketNotEmpty, which is
          // the data-protection behavior users rely on.
          const mayEmpty = olds.forceDestroy === true || force === true;
          yield* Effect.logInfo(
            `S3 Bucket delete: bucket=${output.bucketName} forceDestroy=${olds.forceDestroy ?? false} force=${force ?? false} region=${output.region}`,
          );
          const run = Effect.gen(function* () {
            // If we may destroy contents, delete all object versions and
            // delete markers first. The bucket may already be gone (deleted
            // out-of-band, or a previous destroy partially succeeded) —
            // treat NoSuchBucket as a no-op so the overall delete still
            // converges.
            if (mayEmpty) {
              yield* session.note(
                `Force destroying bucket: ${output.bucketName} - deleting all objects...`,
              );
              yield* deleteAllObjects(output.bucketName).pipe(
                Effect.catchTag("NoSuchBucket", () => Effect.void),
              );
            }

            yield* s3
              .deleteBucket({
                Bucket: output.bucketName,
              })
              .pipe(
                Effect.catchTags({
                  NoSuchBucket: () => Effect.void,
                  // BucketNotEmpty after an empty is eventual consistency (or
                  // a concurrent writer landing new versions between the empty
                  // and the DeleteBucket): re-empty so the bounded retry below
                  // has a chance to succeed instead of spinning on a bucket
                  // that still has content.
                  BucketNotEmpty: (e) =>
                    Effect.gen(function* () {
                      if (!mayEmpty) return yield* e;
                      yield* deleteAllObjects(output.bucketName).pipe(
                        Effect.catchTag("NoSuchBucket", () => Effect.void),
                      );
                      // Re-fail with the original error so the retry policy
                      // drives the next DeleteBucket attempt.
                      return yield* e;
                    }),
                }),
                Effect.retry({
                  // BucketHasAccessPointsAttached: S3's access-point
                  // attachment view is eventually consistent — deleting a
                  // bucket immediately after its access points were deleted
                  // can transiently report attachments. Retry until the view
                  // converges (bounded).
                  while: (e): boolean =>
                    e._tag === "BucketNotEmpty" || e._tag === "BucketHasAccessPointsAttached",
                  schedule: Schedule.max([Schedule.exponential(250), Schedule.recurs(7)]),
                }),
              );
          });

          // The bucket may live in a different region than the ambient client
          // (list enumerates buckets from every region) — target the bucket's
          // own region to avoid PermanentRedirect. If we still get redirected
          // (e.g. a stale/missing region attribute), retry once in the region
          // the redirect reports.
          yield* (
            output.region
              ? run.pipe(Effect.provideService(Region, Effect.succeed(output.region)))
              : run
          ).pipe(
            Effect.tapError(Effect.logInfo),
            Effect.catchTag("PermanentRedirect", (e) =>
              e.BucketRegion
                ? run.pipe(
                    Effect.provideService(Region, Effect.succeed(e.BucketRegion as RegionID)),
                  )
                : Effect.fail(e),
            ),
          );

          yield* session.note(`Deleted bucket: ${output.bucketName}`);
        }),
      };
    }),
  );

class BucketEncryptionNotConverged extends Data.TaggedError("BucketEncryptionNotConverged")<{
  bucket: string;
}> {}

const desiredEncryptionRule = (encryption?: BucketEncryption): s3.ServerSideEncryptionRule => {
  const algorithm = encryption?.sseAlgorithm ?? "AES256";
  const blocked = encryption?.blockedEncryptionTypes ?? [];
  return {
    ApplyServerSideEncryptionByDefault: {
      SSEAlgorithm: algorithm,
      KMSMasterKeyID: algorithm === "AES256" ? undefined : encryption?.kmsMasterKeyId,
    },
    BucketKeyEnabled: encryption?.bucketKeyEnabled ?? false,
    BlockedEncryptionTypes: {
      EncryptionType: blocked.length ? [...new Set(blocked)] : ["NONE"],
    },
  };
};

/** The default-encryption settings `alchemy drift` compares. */
const projectEncryption = (rule: s3.ServerSideEncryptionRule | undefined) => {
  const key = rule?.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID;
  return {
    sseAlgorithm: rule?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm,
    kmsMasterKeyId: (Redacted.isRedacted(key) ? Redacted.value(key) : key) ?? undefined,
    bucketKeyEnabled: rule?.BucketKeyEnabled ?? false,
    blockedEncryptionTypes: [
      ...new Set(
        rule?.BlockedEncryptionTypes?.EncryptionType?.filter((type) => type !== "NONE") ?? [],
      ),
    ].sort(),
  };
};

const encryptionFingerprint = (rule: s3.ServerSideEncryptionRule | undefined) =>
  JSON.stringify(projectEncryption(rule));

const readBucketEncryption = (bucket: string) =>
  s3
    .getBucketEncryption({ Bucket: bucket })
    .pipe(Effect.map((result) => result.ServerSideEncryptionConfiguration?.Rules?.[0]));

export const syncBucketEncryption = Effect.fn(function* (
  bucket: string,
  encryption?: BucketEncryption,
  /**
   * The last observed projection; when it disagrees with the current read
   * (S3 served a stale read), the write is forced.
   */
  previous?: Bucket["Attributes"]["encryption"],
) {
  const desired = desiredEncryptionRule(encryption);
  const matches = (rule: s3.ServerSideEncryptionRule | undefined) =>
    encryptionFingerprint(rule) === encryptionFingerprint(desired);
  const current = yield* readBucketEncryption(bucket);
  if (
    matches(current) &&
    (previous === undefined || deepEqual(previous, projectEncryption(current)))
  ) {
    return false;
  }
  yield* s3.putBucketEncryption({
    Bucket: bucket,
    ServerSideEncryptionConfiguration: { Rules: [desired] },
  });
  // Encryption reads stay stale for well over 8s after a write, notably on a
  // re-created bucket name or right after a bucket-policy change.
  const observed = yield* readBucketEncryption(bucket).pipe(
    Effect.repeat({
      until: matches,
      schedule: Schedule.spaced("2 seconds"),
      times: 15,
    }),
  );
  if (!matches(observed)) {
    return yield* new BucketEncryptionNotConverged({ bucket });
  }
  return true;
});
