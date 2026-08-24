import * as s3vectors from "@distilled.cloud/aws/s3vectors";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";

/**
 * Server-side encryption configuration for a vector bucket. Immutable —
 * changing it replaces the bucket.
 */
export interface VectorBucketEncryption {
  /**
   * The SSE algorithm. `AES256` uses S3-managed keys; `aws:kms` uses a KMS
   * key (supply `kmsKeyArn`).
   * @default "AES256"
   */
  sseType?: "AES256" | "aws:kms";
  /**
   * ARN of the KMS key to use when `sseType` is `aws:kms`.
   */
  kmsKeyArn?: string;
}

export interface VectorBucketProps {
  /**
   * Name of the vector bucket (3-63 chars, lowercase). If omitted, a unique
   * name is generated from the app, stage, and logical id.
   *
   * Changing the name replaces the bucket.
   * @default ${app}-${stage}-${id}
   */
  vectorBucketName?: string;
  /**
   * Server-side encryption configuration. Immutable — changing it replaces
   * the bucket.
   */
  encryption?: VectorBucketEncryption;
  /**
   * Resource policy statements for the vector bucket, granting or denying
   * cross-account/principal access to it and the indexes inside it
   * (`arn:…:bucket/<name>/index/*`). Rendered as a standard
   * `2012-10-17` policy document via `PutVectorBucketPolicy`; omitting the
   * prop removes any existing policy.
   */
  policy?: PolicyStatement[];
  /**
   * Tags to apply to the bucket. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface VectorBucket extends Resource<
  "AWS.S3Vectors.VectorBucket",
  VectorBucketProps,
  {
    /**
     * Name of the vector bucket.
     */
    vectorBucketName: string;
    /**
     * ARN of the vector bucket.
     */
    vectorBucketArn: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon S3 Vectors bucket — durable storage for vector embeddings,
 * queryable by similarity. Create one or more {@link Index}es inside it to
 * store and query vectors.
 *
 * S3 Vectors is in preview; availability varies by region.
 *
 * @resource
 * @section Creating a Vector Bucket
 * @example Basic Vector Bucket
 * ```typescript
 * import * as S3Vectors from "alchemy/AWS/S3Vectors";
 *
 * const bucket = yield* S3Vectors.VectorBucket("Embeddings", {});
 * ```
 *
 * @example Vector Bucket with KMS Encryption
 * ```typescript
 * const bucket = yield* S3Vectors.VectorBucket("Embeddings", {
 *   encryption: { sseType: "aws:kms", kmsKeyArn: key.keyArn },
 * });
 * ```
 *
 * @section Bucket Policy
 * @example Grant Another Account Read Access
 * ```typescript
 * const bucket = yield* S3Vectors.VectorBucket("Embeddings", {
 *   vectorBucketName: "shared-embeddings",
 *   policy: [
 *     {
 *       Effect: "Allow",
 *       Principal: { AWS: "arn:aws:iam::123456789012:root" },
 *       Action: ["s3vectors:GetVectors", "s3vectors:QueryVectors"],
 *       Resource:
 *         "arn:aws:s3vectors:us-east-1:999999999999:bucket/shared-embeddings/index/*",
 *     },
 *   ],
 * });
 * ```
 */
export const VectorBucket = Resource<VectorBucket>(
  "AWS.S3Vectors.VectorBucket",
);

const encryptionKey = (e: VectorBucketEncryption | undefined) =>
  JSON.stringify({ sseType: e?.sseType, kmsKeyArn: e?.kmsKeyArn });

export const VectorBucketProvider = () =>
  Provider.effect(
    VectorBucket,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<VectorBucketProps, "vectorBucketName">,
      ) {
        return (
          props.vectorBucketName ??
          (yield* createPhysicalName({ id, maxLength: 63 })).toLowerCase()
        );
      });

      const observe = (vectorBucketName: string) =>
        s3vectors.getVectorBucket({ vectorBucketName }).pipe(
          Effect.map((r) => r.vectorBucket),
          Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
        );

      const observedTags = (resourceArn: string) =>
        s3vectors.listTagsForResource({ resourceArn }).pipe(
          Effect.map(
            (r) =>
              Object.fromEntries(
                Object.entries(r.tags ?? {}).filter(([, v]) => v !== undefined),
              ) as Record<string, string>,
          ),
          Effect.catchTag("NotFoundException", () =>
            Effect.succeed({} as Record<string, string>),
          ),
        );

      const observedPolicy = (vectorBucketName: string) =>
        s3vectors.getVectorBucketPolicy({ vectorBucketName }).pipe(
          Effect.map((r) => r.policy),
          Effect.catchTag("NotFoundException", () =>
            Effect.succeed(undefined as string | undefined),
          ),
        );

      const desiredEncryption = (props: VectorBucketProps) =>
        props.encryption
          ? {
              sseType: props.encryption.sseType,
              kmsKeyArn: props.encryption.kmsKeyArn,
            }
          : undefined;

      return VectorBucket.Provider.of({
        stables: ["vectorBucketName", "vectorBucketArn"],
        list: () =>
          Effect.gen(function* () {
            const buckets = yield* s3vectors.listVectorBuckets
              .items({})
              .pipe(Stream.runCollect);
            return Array.from(buckets).map((b) => ({
              vectorBucketName: b.vectorBucketName,
              vectorBucketArn: b.vectorBucketArn,
            }));
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.vectorBucketName ?? (yield* createName(id, olds ?? {}));
          const found = yield* observe(name);
          if (!found) return undefined;
          const attrs = {
            vectorBucketName: found.vectorBucketName,
            vectorBucketArn: found.vectorBucketArn,
          };
          const tags = yield* observedTags(found.vectorBucketArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          if (oldName !== newName) return { action: "replace" } as const;
          // Encryption is fixed at create time — any change replaces.
          if (
            encryptionKey(olds?.encryption) !== encryptionKey(news?.encryption)
          ) {
            return { action: "replace" } as const;
          }
          // fall through: engine default update (tags only)
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name =
            output?.vectorBucketName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative.
          let live = yield* observe(name);

          // 2. ENSURE — create when missing; a concurrent create surfaces as
          //    ConflictException, which we treat as a race and re-observe.
          if (live === undefined) {
            yield* s3vectors
              .createVectorBucket({
                vectorBucketName: name,
                encryptionConfiguration: desiredEncryption(news),
                tags: desiredTags,
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
            live = yield* observe(name);
          }

          const vectorBucketArn =
            live?.vectorBucketArn ?? output?.vectorBucketArn;

          // 3. SYNC TAGS — diff against OBSERVED cloud tags so adoption and
          //    drift converge (create-time tags only apply on first create).
          if (vectorBucketArn !== undefined) {
            const currentTags = yield* observedTags(vectorBucketArn);
            const { upsert, removed } = diffTags(currentTags, desiredTags);
            if (upsert.length > 0) {
              yield* s3vectors.tagResource({
                resourceArn: vectorBucketArn,
                tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
              });
            }
            if (removed.length > 0) {
              yield* s3vectors.untagResource({
                resourceArn: vectorBucketArn,
                tagKeys: removed,
              });
            }
          }

          // 4. SYNC POLICY — diff desired against the OBSERVED bucket policy
          //    so adoption and drift converge (delete when the prop is gone).
          const desiredPolicy =
            news.policy !== undefined && news.policy.length > 0
              ? JSON.stringify({
                  Version: "2012-10-17",
                  Statement: news.policy,
                })
              : undefined;
          const existingPolicy = yield* observedPolicy(name);
          if (desiredPolicy !== undefined) {
            if (existingPolicy !== desiredPolicy) {
              yield* s3vectors.putVectorBucketPolicy({
                vectorBucketName: name,
                policy: desiredPolicy,
              });
              yield* session.note(`Updated bucket policy: ${name}`);
            }
          } else if (existingPolicy !== undefined) {
            yield* s3vectors
              .deleteVectorBucketPolicy({ vectorBucketName: name })
              .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
            yield* session.note(`Removed bucket policy: ${name}`);
          }

          yield* session.note(name);
          return { vectorBucketName: name, vectorBucketArn: vectorBucketArn! };
        }),
        delete: Effect.fn(function* ({ output, force }) {
          const vectorBucketName = output.vectorBucketName;
          if (force !== true) {
            yield* s3vectors
              .deleteVectorBucket({ vectorBucketName })
              .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
            return;
          }

          const purgeAndDelete = Effect.gen(function* () {
            // Indexes are scoped to their bucket and invisible to a global
            // nuke scan. Only the explicit force path may purge them.
            const indexes = yield* s3vectors.listIndexes
              .items({ vectorBucketName })
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) => Array.from(chunk)),
                Effect.catchTag("NotFoundException", () => Effect.succeed([])),
              );
            yield* Effect.forEach(
              indexes,
              (index) =>
                s3vectors
                  .deleteIndex({
                    vectorBucketName,
                    indexName: index.indexName,
                  })
                  .pipe(
                    Effect.catchTag("NotFoundException", () => Effect.void),
                  ),
              { concurrency: 4, discard: true },
            );
            yield* s3vectors.deleteVectorBucket({ vectorBucketName });
          });

          yield* purgeAndDelete.pipe(
            // Index deletion is eventually consistent and bucket deletion can
            // report Conflict until all indexes disappear. Re-list on retry.
            Effect.retry({
              while: (e) =>
                e._tag === "ConflictException" ||
                e._tag === "ServiceUnavailableException",
              schedule: Schedule.max([
                Schedule.exponential(500),
                Schedule.recurs(8),
              ]),
            }),
            Effect.catchTag("NotFoundException", () => Effect.void),
          );
        }),
      });
    }),
  );
