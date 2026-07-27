import * as firehose from "@distilled.cloud/aws/firehose";
import * as iam from "@distilled.cloud/aws/iam";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
  type Tags,
} from "../../Tags.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";

export type DeliveryStreamName = string;
export type DeliveryStreamArn =
  `arn:aws:firehose:${RegionID}:${AccountID}:deliverystream/${DeliveryStreamName}`;

export type DeliveryStreamStatus =
  | "CREATING"
  | "CREATING_FAILED"
  | "DELETING"
  | "DELETING_FAILED"
  | "ACTIVE";

export type DeliveryStreamSourceType = "DirectPut" | "KinesisStreamAsSource";

export type CompressionFormat =
  | "UNCOMPRESSED"
  | "GZIP"
  | "ZIP"
  | "Snappy"
  | "HADOOP_SNAPPY";

export interface KinesisStreamSourceProps {
  /**
   * ARN of the Kinesis Data Stream that feeds the delivery stream.
   * Changing the source stream replaces the delivery stream.
   */
  kinesisStreamArn: string;
  /**
   * ARN of the IAM role Firehose assumes to read from the Kinesis stream.
   * @default a role is auto-created granting kinesis:DescribeStream,
   * kinesis:GetShardIterator, kinesis:GetRecords and kinesis:ListShards on
   * the source stream.
   */
  roleArn?: string;
}

export interface S3DestinationProps {
  /**
   * ARN of the destination S3 bucket.
   */
  bucketArn: string;
  /**
   * ARN of the IAM role Firehose assumes to write to the bucket.
   * @default a role is auto-created granting s3:PutObject, s3:GetObject,
   * s3:ListBucket, s3:GetBucketLocation, s3:AbortMultipartUpload and
   * s3:ListBucketMultipartUploads on the bucket.
   */
  roleArn?: string;
  /**
   * Prefix prepended to delivered S3 object keys.
   */
  prefix?: string;
  /**
   * Prefix for objects that failed delivery or transformation.
   */
  errorOutputPrefix?: string;
  /**
   * Buffering interval before flushing to S3 — e.g. `"1 minute"` or
   * `Duration.seconds(60)`. Sent to AWS as whole seconds; valid values range
   * from 0 (zero buffering) to 900 seconds.
   * @default "300 seconds"
   */
  bufferingInterval?: Duration.Input;
  /**
   * Buffering size in MiB before flushing to S3.
   * Valid values range from 1 to 128.
   * @default 5
   */
  bufferingSizeInMBs?: number;
  /**
   * Compression format applied to delivered objects.
   * @default "UNCOMPRESSED"
   */
  compressionFormat?: CompressionFormat;
}

export type DeliveryStreamEncryptionKeyType =
  | "AWS_OWNED_CMK"
  | "CUSTOMER_MANAGED_CMK";

export type DeliveryStreamEncryptionStatus =
  | "ENABLED"
  | "ENABLING"
  | "ENABLING_FAILED"
  | "DISABLED"
  | "DISABLING"
  | "DISABLING_FAILED";

export interface DeliveryStreamEncryptionProps {
  /**
   * Which key to use for server-side encryption: the AWS-owned CMK that
   * Firehose manages for you, or a customer-managed KMS key (`keyArn`
   * required).
   */
  keyType: DeliveryStreamEncryptionKeyType;
  /**
   * ARN of the customer-managed KMS key. Required when `keyType` is
   * `CUSTOMER_MANAGED_CMK`; must be omitted for `AWS_OWNED_CMK`.
   */
  keyArn?: string;
}

export interface DeliveryStreamProps {
  /**
   * Name of the delivery stream. Changing the name replaces the stream.
   * @default ${app}-${id}-${stage}-${instanceId}
   */
  deliveryStreamName?: string;
  /**
   * Kinesis Data Stream source. When omitted the stream is `DirectPut` and
   * producers write via `PutRecord` / `PutRecordBatch`. Adding, removing or
   * changing the source replaces the delivery stream.
   */
  source?: KinesisStreamSourceProps;
  /**
   * S3 destination configuration (Firehose "extended S3" destination).
   * Destination settings update in place via `UpdateDestination`.
   */
  destination: S3DestinationProps;
  /**
   * Server-side encryption (SSE) for records at rest inside the delivery
   * stream. Only supported for `DirectPut` streams — streams with a Kinesis
   * source inherit encryption from the source stream. Adding, changing or
   * removing encryption updates the stream in place via
   * `StartDeliveryStreamEncryption` / `StopDeliveryStreamEncryption`.
   * @default no server-side encryption
   */
  encryption?: DeliveryStreamEncryptionProps;
  /**
   * Tags to associate with the delivery stream.
   */
  tags?: Record<string, string>;
}

export interface DeliveryStream extends Resource<
  "AWS.Firehose.DeliveryStream",
  DeliveryStreamProps,
  {
    /**
     * The delivery stream's physical name.
     */
    deliveryStreamName: DeliveryStreamName;
    /**
     * ARN of the delivery stream.
     */
    deliveryStreamArn: DeliveryStreamArn;
    /**
     * Current lifecycle status of the delivery stream.
     */
    deliveryStreamStatus: DeliveryStreamStatus;
    /**
     * Source type of the delivery stream.
     */
    deliveryStreamType: DeliveryStreamSourceType;
    /**
     * Current version ID of the delivery stream configuration.
     */
    versionId: string;
    /**
     * ID of the (single) destination attached to the stream.
     */
    destinationId: string | undefined;
    /**
     * ARN of the destination S3 bucket.
     */
    bucketArn: string;
    /**
     * ARN of the IAM role Firehose assumes to write to the destination.
     */
    roleArn: string;
    /**
     * Name of the auto-created IAM role, when one was synthesized for this
     * stream. `undefined` when the caller supplied every role ARN.
     */
    roleName: string | undefined;
    /**
     * ARN of the source Kinesis stream, for `KinesisStreamAsSource` streams.
     */
    kinesisStreamArn: string | undefined;
    /**
     * Prefix prepended to delivered S3 object keys.
     */
    prefix: string | undefined;
    /**
     * Prefix for objects that failed delivery.
     */
    errorOutputPrefix: string | undefined;
    /**
     * Buffering interval in seconds currently configured on the destination.
     */
    bufferingIntervalInSeconds: number | undefined;
    /**
     * Buffering size in MiB currently configured on the destination.
     */
    bufferingSizeInMBs: number | undefined;
    /**
     * Compression format currently configured on the destination.
     */
    compressionFormat: CompressionFormat | undefined;
    /**
     * Server-side encryption status reported by the stream — `ENABLED` when
     * SSE is active, `DISABLED` when it is not.
     */
    encryptionStatus: DeliveryStreamEncryptionStatus | undefined;
    /**
     * Key type used for server-side encryption, when enabled.
     */
    encryptionKeyType: DeliveryStreamEncryptionKeyType | undefined;
    /**
     * ARN of the customer-managed KMS key used for server-side encryption,
     * when `encryptionKeyType` is `CUSTOMER_MANAGED_CMK`.
     */
    encryptionKeyArn: string | undefined;
    /**
     * Current tags reported for the delivery stream.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Data Firehose delivery stream that buffers records and delivers
 * them to an S3 bucket.
 *
 * `DeliveryStream` owns the stream's lifecycle and mutable destination
 * configuration (buffering hints, compression, prefixes, tags). The stream is
 * `DirectPut` by default — producers write with `PutRecord` /
 * `PutRecordBatch` — or it can drain an existing Kinesis Data Stream via the
 * `source` prop. Unless you supply role ARNs, an IAM role is auto-created
 * granting Firehose write access to the destination bucket (and read access
 * to the source stream when one is configured).
 * @resource
 * @section Creating Delivery Streams
 * @example DirectPut stream delivering to S3
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const bucket = yield* AWS.S3.Bucket("DataLake");
 * const stream = yield* AWS.Firehose.DeliveryStream("Events", {
 *   destination: {
 *     bucketArn: bucket.bucketArn,
 *   },
 * });
 * ```
 *
 * @example Tuned buffering and compression
 * ```typescript
 * const stream = yield* AWS.Firehose.DeliveryStream("Events", {
 *   destination: {
 *     bucketArn: bucket.bucketArn,
 *     prefix: "events/",
 *     errorOutputPrefix: "errors/",
 *     bufferingInterval: "1 minute",
 *     bufferingSizeInMBs: 1,
 *     compressionFormat: "GZIP",
 *   },
 * });
 * ```
 *
 * @example Server-side encryption at rest
 * ```typescript
 * const stream = yield* AWS.Firehose.DeliveryStream("Events", {
 *   destination: { bucketArn: bucket.bucketArn },
 *   encryption: { keyType: "AWS_OWNED_CMK" },
 * });
 * ```
 *
 * @example Kinesis Data Stream as source
 * ```typescript
 * const source = yield* AWS.Kinesis.Stream("Clickstream");
 * const stream = yield* AWS.Firehose.DeliveryStream("ClickstreamArchive", {
 *   source: { kinesisStreamArn: source.streamArn },
 *   destination: { bucketArn: bucket.bucketArn },
 * });
 * ```
 *
 * @section Runtime Producers
 * Bind producer operations in the init phase and use them in runtime
 * handlers. Records are buffered by Firehose and appear in S3 after the
 * buffering interval elapses.
 *
 * @example Put a record from a handler
 * ```typescript
 * // init
 * const putRecord = yield* AWS.Firehose.PutRecord(stream);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const response = yield* putRecord({
 *       Record: { Data: new TextEncoder().encode("hello\n") },
 *     });
 *     return HttpServerResponse.json({ recordId: response.RecordId });
 *   }),
 * };
 * ```
 *
 * @example Put a batch of records
 * ```typescript
 * // init
 * const putRecordBatch = yield* AWS.Firehose.PutRecordBatch(stream);
 *
 * // runtime
 * const response = yield* putRecordBatch({
 *   Records: lines.map((line) => ({
 *     Data: new TextEncoder().encode(`${line}\n`),
 *   })),
 * });
 * ```
 */
export const DeliveryStream = Resource<DeliveryStream>(
  "AWS.Firehose.DeliveryStream",
);

/**
 * The delivery stream entered `CREATING_FAILED` — AWS never recovers this
 * state; the stream must be deleted and recreated.
 */
export class DeliveryStreamCreateFailed extends Data.TaggedError(
  "DeliveryStreamCreateFailed",
)<{
  readonly deliveryStreamName: string;
  readonly details: string | undefined;
}> {}

/**
 * Validation error raised before any AWS call when the props are invalid.
 */
export class DeliveryStreamValidationError extends Data.TaggedError(
  "DeliveryStreamValidationError",
)<{
  readonly message: string;
}> {}

/**
 * Server-side encryption reached a terminal failure state
 * (`ENABLING_FAILED` / `DISABLING_FAILED`) while converging to the desired
 * encryption configuration.
 */
export class DeliveryStreamEncryptionFailed extends Data.TaggedError(
  "DeliveryStreamEncryptionFailed",
)<{
  readonly deliveryStreamName: string;
  readonly status: string;
  readonly details: string | undefined;
}> {}

class DeliveryStreamNotActive extends Data.TaggedError(
  "DeliveryStreamNotActive",
)<{
  readonly status: string;
}> {}

class DeliveryStreamEncryptionPending extends Data.TaggedError(
  "DeliveryStreamEncryptionPending",
) {}

class DeliveryStreamStillExists extends Data.TaggedError(
  "DeliveryStreamStillExists",
) {}

const defaultBufferingIntervalInSeconds = 300;
const defaultBufferingSizeInMBs = 5;
const defaultCompressionFormat = "UNCOMPRESSED" as const;

const createDeliveryStreamName = (
  id: string,
  props: { deliveryStreamName?: string | undefined },
) =>
  Effect.gen(function* () {
    if (props.deliveryStreamName) {
      return props.deliveryStreamName;
    }
    return yield* createPhysicalName({ id, maxLength: 64 });
  });

/**
 * Data-FIRST `Effect.retry(self, options)` wrapped with an explicit return
 * annotation — inlining `Effect.retry` with an options object in provider
 * lifecycle code leaves `Retry.Return`'s conditional type unresolved in the
 * provider's inferred layer type, which TypeScript's declaration emit widens
 * to an `unknown` R — poisoning `AWS.providers()` for every downstream
 * consumer (see `retryThroughDeletionWindow` in SecretsManager/Secret.ts).
 *
 * Retries `InvalidArgumentException`s that mention the IAM role — a freshly
 * created role takes a few seconds to become assumable by the Firehose
 * service principal, and `CreateDeliveryStream` surfaces that propagation
 * window as a role-related `InvalidArgumentException`.
 */
const retryThroughRolePropagation = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "InvalidArgumentException" &&
      /role|assume|trust/i.test((e as { message?: string }).message ?? ""),
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(15)]),
  });

/**
 * Retries `ResourceInUseException` (stream still `CREATING`, or a concurrent
 * operation in flight) on a bounded schedule. Explicitly annotated for the
 * same declaration-emit reason as {@link retryThroughRolePropagation}.
 */
const retryWhileInUse = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ResourceInUseException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(30)]),
  });

/**
 * Retries `ConcurrentModificationException` from `UpdateDestination` — the
 * read-modify-write cycle re-reads the fresh `VersionId` on every attempt.
 * Explicitly annotated for the same declaration-emit reason as
 * {@link retryThroughRolePropagation}.
 */
const retryConcurrentModification = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConcurrentModificationException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(5)]),
  });

const toTagRecord = (
  tags: ReadonlyArray<{ Key: string; Value?: string }> | undefined,
) =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

const toAttrs = ({
  description,
  tags,
  roleName,
}: {
  description: firehose.DeliveryStreamDescription;
  tags: Record<string, string>;
  roleName: string | undefined;
}): DeliveryStream["Attributes"] => {
  const destination = description.Destinations[0];
  const s3 = destination?.ExtendedS3DestinationDescription;
  const encryption = description.DeliveryStreamEncryptionConfiguration;
  return {
    deliveryStreamName: description.DeliveryStreamName,
    deliveryStreamArn: description.DeliveryStreamARN as DeliveryStreamArn,
    deliveryStreamStatus:
      description.DeliveryStreamStatus as DeliveryStreamStatus,
    deliveryStreamType:
      description.DeliveryStreamType as DeliveryStreamSourceType,
    versionId: description.VersionId,
    destinationId: destination?.DestinationId,
    bucketArn: s3?.BucketARN ?? "",
    roleArn: s3?.RoleARN ?? "",
    roleName,
    kinesisStreamArn:
      description.Source?.KinesisStreamSourceDescription?.KinesisStreamARN,
    prefix: s3?.Prefix || undefined,
    errorOutputPrefix: s3?.ErrorOutputPrefix || undefined,
    bufferingIntervalInSeconds: s3?.BufferingHints?.IntervalInSeconds,
    bufferingSizeInMBs: s3?.BufferingHints?.SizeInMBs,
    compressionFormat: s3?.CompressionFormat as CompressionFormat | undefined,
    encryptionStatus: encryption?.Status as
      | DeliveryStreamEncryptionStatus
      | undefined,
    encryptionKeyType:
      encryption?.Status === "ENABLED"
        ? (encryption.KeyType as DeliveryStreamEncryptionKeyType | undefined)
        : undefined,
    encryptionKeyArn:
      encryption?.Status === "ENABLED" ? encryption.KeyARN : undefined,
    tags,
  };
};

const describeDeliveryStream = Effect.fn(function* (
  deliveryStreamName: string,
) {
  const response = yield* firehose
    .describeDeliveryStream({ DeliveryStreamName: deliveryStreamName })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  return response?.DeliveryStreamDescription;
});

const readDeliveryStream = Effect.fn(function* ({
  deliveryStreamName,
  roleName,
}: {
  deliveryStreamName: string;
  roleName: string | undefined;
}) {
  const description = yield* describeDeliveryStream(deliveryStreamName);
  if (!description) {
    return undefined;
  }
  // The stream can vanish between the describe above and the tag read (e.g.
  // a concurrent destroy) — a typed `ResourceNotFoundException` here just
  // means it's gone.
  const tagsResponse = yield* firehose
    .listTagsForDeliveryStream({ DeliveryStreamName: deliveryStreamName })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  if (!tagsResponse) {
    return undefined;
  }
  return toAttrs({
    description,
    tags: toTagRecord(tagsResponse.Tags),
    roleName,
  });
});

// Firehose activates fast (usually well under a minute); 2s × 45 bounds the
// wait at 90s.
const waitForDeliveryStreamActive = (deliveryStreamName: string) =>
  Effect.gen(function* () {
    const description = yield* describeDeliveryStream(deliveryStreamName);
    if (!description) {
      return yield* Effect.fail(
        new DeliveryStreamNotActive({ status: "MISSING" }),
      );
    }
    if (description.DeliveryStreamStatus === "CREATING_FAILED") {
      return yield* Effect.fail(
        new DeliveryStreamCreateFailed({
          deliveryStreamName,
          details: description.FailureDescription?.Details,
        }),
      );
    }
    if (description.DeliveryStreamStatus !== "ACTIVE") {
      return yield* Effect.fail(
        new DeliveryStreamNotActive({
          status: description.DeliveryStreamStatus,
        }),
      );
    }
    return description;
  }).pipe(
    Effect.retry({
      while: (e: { _tag: string }) => e._tag === "DeliveryStreamNotActive",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(45),
      ]),
    }),
  );

// SSE transitions (ENABLING → ENABLED, DISABLING → DISABLED) settle in
// seconds for the AWS-owned CMK; 2s × 45 bounds the wait at 90s. Returns the
// terminal encryption configuration (or `undefined` when the stream has
// never been encrypted).
const waitForEncryptionSettled = (deliveryStreamName: string) =>
  Effect.gen(function* () {
    const description = yield* describeDeliveryStream(deliveryStreamName);
    const encryption = description?.DeliveryStreamEncryptionConfiguration;
    if (
      encryption?.Status === "ENABLING" ||
      encryption?.Status === "DISABLING"
    ) {
      return yield* Effect.fail(new DeliveryStreamEncryptionPending());
    }
    return encryption;
  }).pipe(
    Effect.retry({
      while: (e: { _tag: string }) =>
        e._tag === "DeliveryStreamEncryptionPending",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(45),
      ]),
    }),
  );

// Deletion is usually quick but AWS documents that DELETING can linger;
// 3s × 50 bounds the wait at 150s.
const waitForDeliveryStreamDeleted = (deliveryStreamName: string) =>
  Effect.gen(function* () {
    const description = yield* describeDeliveryStream(deliveryStreamName);
    if (description !== undefined) {
      return yield* Effect.fail(new DeliveryStreamStillExists());
    }
  }).pipe(
    Effect.retry({
      while: (e: { _tag: string }) => e._tag === "DeliveryStreamStillExists",
      schedule: Schedule.max([
        Schedule.fixed("3 seconds"),
        Schedule.recurs(50),
      ]),
    }),
  );

const deleteRoleIfExists = Effect.fn(function* (roleName: string) {
  yield* iam
    .deleteRolePolicy({ RoleName: roleName, PolicyName: roleName })
    .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
  yield* iam
    .deleteRole({ RoleName: roleName })
    .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
});

export const DeliveryStreamProvider = () =>
  Provider.effect(
    DeliveryStream,
    Effect.gen(function* () {
      const createRoleName = (id: string) =>
        createPhysicalName({ id, maxLength: 64 });

      // Ensure the synthesized IAM role exists and its inline policy matches
      // the desired destination/source access. `createRole` tolerates the
      // already-exists race; `putRolePolicy` is an idempotent upsert, so the
      // policy re-converges on every reconcile (e.g. after a bucket change).
      const ensureRole = Effect.fn(function* ({
        id,
        roleName,
        bucketArn,
        kinesisStreamArn,
      }: {
        id: string;
        roleName: string;
        bucketArn: string;
        kinesisStreamArn: string | undefined;
      }) {
        const tags = yield* createInternalTags(id);
        yield* iam
          .createRole({
            RoleName: roleName,
            AssumeRolePolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "firehose.amazonaws.com" },
                  Action: "sts:AssumeRole",
                },
              ],
            }),
            Tags: createTagsList(tags),
          })
          .pipe(
            Effect.catchTag("EntityAlreadyExistsException", () =>
              iam.getRole({ RoleName: roleName }),
            ),
          );

        const statements: PolicyStatement[] = [
          {
            Effect: "Allow",
            Action: [
              "s3:AbortMultipartUpload",
              "s3:GetBucketLocation",
              "s3:GetObject",
              "s3:ListBucket",
              "s3:ListBucketMultipartUploads",
              "s3:PutObject",
            ],
            Resource: [bucketArn, `${bucketArn}/*`],
          },
        ];
        if (kinesisStreamArn) {
          statements.push({
            Effect: "Allow",
            Action: [
              "kinesis:DescribeStream",
              "kinesis:GetShardIterator",
              "kinesis:GetRecords",
              "kinesis:ListShards",
            ],
            Resource: [kinesisStreamArn],
          });
        }

        yield* iam.putRolePolicy({
          RoleName: roleName,
          PolicyName: roleName,
          PolicyDocument: JSON.stringify({
            Version: "2012-10-17",
            Statement: statements,
          }),
        });
      });

      return DeliveryStream.Provider.of({
        stables: [
          "deliveryStreamName",
          "deliveryStreamArn",
          "deliveryStreamType",
          "roleName",
        ],

        // Enumerate every delivery stream in the ambient account/region.
        // `listDeliveryStreams` pages via ExclusiveStartDeliveryStreamName +
        // HasMoreDeliveryStreams; hydrate each name into the `read` shape
        // with bounded concurrency, dropping streams that vanish mid-flight.
        list: () =>
          Effect.gen(function* () {
            const names: string[] = [];
            let exclusiveStart: string | undefined;
            while (true) {
              const page = yield* firehose.listDeliveryStreams({
                Limit: 100,
                ExclusiveStartDeliveryStreamName: exclusiveStart,
              });
              names.push(...page.DeliveryStreamNames);
              if (
                !page.HasMoreDeliveryStreams ||
                page.DeliveryStreamNames.length === 0
              ) {
                break;
              }
              exclusiveStart = names[names.length - 1];
            }

            const hydrated = yield* Effect.forEach(
              names,
              (deliveryStreamName) =>
                readDeliveryStream({ deliveryStreamName, roleName: undefined }),
              { concurrency: 10 },
            );

            return hydrated.filter(
              (attrs): attrs is DeliveryStream["Attributes"] =>
                attrs !== undefined,
            );
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const deliveryStreamName =
            output?.deliveryStreamName ??
            (yield* createDeliveryStreamName(id, olds ?? {}));
          const state = yield* readDeliveryStream({
            deliveryStreamName,
            roleName: output?.roleName,
          });
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.tags as Tags))
            ? state
            : Unowned(state);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createDeliveryStreamName(id, olds ?? {});
          const newName = yield* createDeliveryStreamName(id, news ?? {});
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // The source (DirectPut vs KinesisStreamAsSource, and which stream)
          // is immutable — any change replaces the delivery stream.
          const oldSource = olds?.source;
          const newSource = news?.source;
          if (
            (oldSource === undefined) !== (newSource === undefined) ||
            oldSource?.kinesisStreamArn !== newSource?.kinesisStreamArn
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId } = yield* AWSEnvironment.current;

          if (!news?.destination?.bucketArn) {
            return yield* Effect.fail(
              new DeliveryStreamValidationError({
                message: `DeliveryStream "${id}" requires destination.bucketArn`,
              }),
            );
          }
          if (news.encryption && news.source) {
            return yield* Effect.fail(
              new DeliveryStreamValidationError({
                message: `DeliveryStream "${id}" cannot enable server-side encryption on a KinesisStreamAsSource stream — encryption is inherited from the source Kinesis stream`,
              }),
            );
          }
          if (
            news.encryption?.keyType === "CUSTOMER_MANAGED_CMK" &&
            !news.encryption.keyArn
          ) {
            return yield* Effect.fail(
              new DeliveryStreamValidationError({
                message: `DeliveryStream "${id}" requires encryption.keyArn when keyType is CUSTOMER_MANAGED_CMK`,
              }),
            );
          }

          const deliveryStreamName =
            output?.deliveryStreamName ??
            (yield* createDeliveryStreamName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // Synthesize the IAM role when the caller didn't supply one for
          // the destination (and/or the Kinesis source).
          const needsRole =
            !news.destination.roleArn ||
            (news.source !== undefined && !news.source.roleArn);
          const roleName = needsRole
            ? (output?.roleName ?? (yield* createRoleName(id)))
            : undefined;
          const synthesizedRoleArn = roleName
            ? `arn:aws:iam::${accountId}:role/${roleName}`
            : undefined;
          const destinationRoleArn =
            news.destination.roleArn ?? synthesizedRoleArn!;
          const sourceRoleArn = news.source
            ? (news.source.roleArn ?? synthesizedRoleArn!)
            : undefined;

          if (roleName) {
            yield* ensureRole({
              id,
              roleName,
              bucketArn: news.destination.bucketArn,
              kinesisStreamArn: news.source?.kinesisStreamArn,
            });
          }

          // Observe — cloud state is authoritative; `output` is only a cache
          // for the physical name.
          let observed = yield* describeDeliveryStream(deliveryStreamName);

          // A stream stuck in CREATING_FAILED / DELETING_FAILED can never
          // recover — converge by deleting it and recreating below.
          if (
            observed &&
            (observed.DeliveryStreamStatus === "CREATING_FAILED" ||
              observed.DeliveryStreamStatus === "DELETING_FAILED")
          ) {
            yield* session.note(
              `Delivery stream ${deliveryStreamName} is ${observed.DeliveryStreamStatus}; deleting and recreating`,
            );
            yield* firehose
              .deleteDeliveryStream({
                DeliveryStreamName: deliveryStreamName,
                AllowForceDelete: true,
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );
            yield* waitForDeliveryStreamDeleted(deliveryStreamName);
            observed = undefined;
          }

          const desiredBufferingHints = {
            IntervalInSeconds:
              toWireSeconds(news.destination.bufferingInterval) ??
              defaultBufferingIntervalInSeconds,
            SizeInMBs:
              news.destination.bufferingSizeInMBs ?? defaultBufferingSizeInMBs,
          };
          const desiredCompression =
            news.destination.compressionFormat ?? defaultCompressionFormat;

          // Ensure — create the stream if it's missing. Tolerate the
          // already-exists race (`ResourceInUseException`) and retry through
          // the fresh role's IAM propagation window.
          if (observed === undefined) {
            yield* retryThroughRolePropagation(
              firehose
                .createDeliveryStream({
                  DeliveryStreamName: deliveryStreamName,
                  DeliveryStreamType: news.source
                    ? "KinesisStreamAsSource"
                    : "DirectPut",
                  KinesisStreamSourceConfiguration: news.source
                    ? {
                        KinesisStreamARN: news.source.kinesisStreamArn,
                        RoleARN: sourceRoleArn!,
                      }
                    : undefined,
                  DeliveryStreamEncryptionConfigurationInput: news.encryption
                    ? {
                        KeyType: news.encryption.keyType,
                        KeyARN: news.encryption.keyArn,
                      }
                    : undefined,
                  ExtendedS3DestinationConfiguration: {
                    RoleARN: destinationRoleArn,
                    BucketARN: news.destination.bucketArn,
                    Prefix: news.destination.prefix,
                    ErrorOutputPrefix: news.destination.errorOutputPrefix,
                    BufferingHints: desiredBufferingHints,
                    CompressionFormat: desiredCompression,
                  },
                  Tags: createTagsList(desiredTags),
                })
                .pipe(
                  Effect.catchTag("ResourceInUseException", () => Effect.void),
                ),
            );
            yield* session.note(
              `Creating delivery stream ${deliveryStreamName}...`,
            );
          }

          // Both a fresh create and a crashed prior run land here in
          // `CREATING` — wait for `ACTIVE` before syncing (bounded).
          const active = yield* waitForDeliveryStreamActive(deliveryStreamName);

          // Sync destination settings — diff observed against desired and
          // apply only the delta via UpdateDestination (read-modify-write on
          // VersionId, retried through ConcurrentModificationException).
          const syncDestination = Effect.gen(function* () {
            const description =
              yield* describeDeliveryStream(deliveryStreamName);
            if (!description) return;
            const destination = description.Destinations[0];
            const s3 = destination?.ExtendedS3DestinationDescription;
            if (!destination || !s3) return;

            const delta =
              s3.RoleARN !== destinationRoleArn ||
              s3.BucketARN !== news.destination.bucketArn ||
              (s3.Prefix ?? "") !== (news.destination.prefix ?? "") ||
              (s3.ErrorOutputPrefix ?? "") !==
                (news.destination.errorOutputPrefix ?? "") ||
              s3.BufferingHints.IntervalInSeconds !==
                desiredBufferingHints.IntervalInSeconds ||
              s3.BufferingHints.SizeInMBs !== desiredBufferingHints.SizeInMBs ||
              s3.CompressionFormat !== desiredCompression;
            if (!delta) return;

            yield* firehose.updateDestination({
              DeliveryStreamName: deliveryStreamName,
              CurrentDeliveryStreamVersionId: description.VersionId,
              DestinationId: destination.DestinationId,
              ExtendedS3DestinationUpdate: {
                RoleARN: destinationRoleArn,
                BucketARN: news.destination.bucketArn,
                Prefix: news.destination.prefix ?? "",
                ErrorOutputPrefix: news.destination.errorOutputPrefix ?? "",
                BufferingHints: desiredBufferingHints,
                CompressionFormat: desiredCompression,
              },
            });
            yield* session.note(
              `Updated destination settings for ${deliveryStreamName}`,
            );
          });
          yield* retryConcurrentModification(syncDestination);

          // Sync server-side encryption — settle any in-flight transition
          // (a crashed prior run may have left ENABLING/DISABLING), diff the
          // observed terminal state against the desired config, and apply
          // Start/Stop only on a delta. Both operations are async; the
          // bounded settle-wait converges them. A terminal *_FAILED status
          // also mismatches the desired state, so the op is re-applied.
          const observedEncryption =
            yield* waitForEncryptionSettled(deliveryStreamName);
          const encryptionEnabled = observedEncryption?.Status === "ENABLED";
          if (news.encryption) {
            const keyMatches =
              encryptionEnabled &&
              observedEncryption?.KeyType === news.encryption.keyType &&
              (news.encryption.keyType === "AWS_OWNED_CMK" ||
                observedEncryption?.KeyARN === news.encryption.keyArn);
            if (!keyMatches) {
              yield* retryWhileInUse(
                firehose.startDeliveryStreamEncryption({
                  DeliveryStreamName: deliveryStreamName,
                  DeliveryStreamEncryptionConfigurationInput: {
                    KeyType: news.encryption.keyType,
                    KeyARN: news.encryption.keyArn,
                  },
                }),
              );
              const settled =
                yield* waitForEncryptionSettled(deliveryStreamName);
              if (settled?.Status !== "ENABLED") {
                return yield* Effect.fail(
                  new DeliveryStreamEncryptionFailed({
                    deliveryStreamName,
                    status: settled?.Status ?? "UNKNOWN",
                    details: settled?.FailureDescription?.Details,
                  }),
                );
              }
              yield* session.note(
                `Enabled SSE (${news.encryption.keyType}) on ${deliveryStreamName}`,
              );
            }
          } else if (encryptionEnabled) {
            yield* retryWhileInUse(
              firehose.stopDeliveryStreamEncryption({
                DeliveryStreamName: deliveryStreamName,
              }),
            );
            const settled = yield* waitForEncryptionSettled(deliveryStreamName);
            if (settled !== undefined && settled.Status !== "DISABLED") {
              return yield* Effect.fail(
                new DeliveryStreamEncryptionFailed({
                  deliveryStreamName,
                  status: settled.Status ?? "UNKNOWN",
                  details: settled.FailureDescription?.Details,
                }),
              );
            }
            yield* session.note(`Disabled SSE on ${deliveryStreamName}`);
          }

          // Sync tags — diff against OBSERVED cloud tags (adoption may bring
          // a stream with foreign tags), never olds/output.
          const observedTagsResponse = yield* firehose
            .listTagsForDeliveryStream({
              DeliveryStreamName: deliveryStreamName,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          const observedTags = toTagRecord(observedTagsResponse?.Tags);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (removed.length > 0) {
            yield* firehose.untagDeliveryStream({
              DeliveryStreamName: deliveryStreamName,
              TagKeys: removed,
            });
          }
          if (upsert.length > 0) {
            yield* firehose.tagDeliveryStream({
              DeliveryStreamName: deliveryStreamName,
              Tags: upsert,
            });
          }

          yield* session.note(active.DeliveryStreamARN);

          // Return fresh attributes reflecting post-sync cloud state.
          const final = yield* readDeliveryStream({
            deliveryStreamName,
            roleName,
          });
          if (!final) {
            return yield* Effect.fail(
              new DeliveryStreamValidationError({
                message: `failed to read reconciled delivery stream ${deliveryStreamName}`,
              }),
            );
          }
          return final;
        }),

        delete: Effect.fn(function* ({ output }) {
          // A stream in CREATING can't be deleted — retry through the window
          // (bounded). Already-gone is success.
          yield* retryWhileInUse(
            firehose
              .deleteDeliveryStream({
                DeliveryStreamName: output.deliveryStreamName,
                AllowForceDelete: true,
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              ),
          );
          yield* waitForDeliveryStreamDeleted(output.deliveryStreamName);

          // Remove the synthesized IAM role (idempotent — it may already be
          // gone from a previous partial delete).
          if (output.roleName) {
            yield* deleteRoleIfExists(output.roleName);
          }
        }),
      });
    }),
  );
