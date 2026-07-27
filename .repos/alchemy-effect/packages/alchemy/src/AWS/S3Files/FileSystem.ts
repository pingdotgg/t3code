import * as s3files from "@distilled.cloud/aws/s3files";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { PolicyDocument } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";
import {
  retryWhileConflict,
  S3FilesNotConverged,
  toTagList,
  toTagRecord,
  untilSettled,
} from "./internal.ts";

export interface FileSystemProps {
  /**
   * ARN of the S3 general purpose bucket the file system exposes as POSIX
   * storage (`arn:aws:s3:::my-bucket`). The bucket must have versioning
   * enabled. Changing it replaces the file system.
   */
  bucket: string;
  /**
   * Optional key prefix that scopes the file system to a portion of the
   * bucket. Changing it replaces the file system.
   */
  prefix?: string;
  /**
   * ARN of the IAM role that grants the S3 Files service permission to read
   * and write the bucket on the file system's behalf. S3 Files runs on EFS
   * infrastructure, so the role must trust the
   * `elasticfilesystem.amazonaws.com` service principal. Changing it
   * replaces the file system.
   */
  roleArn: string;
  /**
   * KMS key used to encrypt file system data. Changing it replaces the file
   * system.
   * @default AWS-managed encryption
   */
  kmsKeyId?: string;
  /**
   * Acknowledge the service warning that applies when creating a file system
   * over a bucket that already contains data.
   * @default false
   */
  acceptBucketWarning?: boolean;
  /**
   * IAM resource policy controlling access to the file system. Omitting it
   * removes any existing policy.
   */
  policy?: PolicyDocument;
  /**
   * When true, deletion force-deletes the file system even if it still has
   * pending export data.
   * @default false
   */
  forceDestroy?: boolean;
  /**
   * Tags to apply to the file system. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface FileSystem extends Resource<
  "AWS.S3Files.FileSystem",
  FileSystemProps,
  {
    /**
     * Unique ID of the file system.
     */
    fileSystemId: string;
    /**
     * ARN of the file system.
     */
    fileSystemArn: string;
    /**
     * Name of the S3 general purpose bucket backing the file system.
     */
    bucket: string;
    /**
     * ARN of the IAM role the file system uses to access the backing bucket.
     */
    roleArn: string;
    /**
     * Current lifecycle status of the file system (e.g. `AVAILABLE`).
     */
    status: string;
    /**
     * Key prefix within the backing bucket that scopes the file system, if
     * one was configured.
     */
    prefix?: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon S3 File System — POSIX-style file system access over an S3
 * general purpose bucket (mountable from EC2/ECS via mount targets, with
 * application-scoped access via {@link AccessPoint}s).
 *
 * S3 Files is a newer service; availability varies by region and account.
 *
 * @resource
 * @section Creating a File System
 * @example Basic File System
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * // S3 Files requires versioning on the source bucket.
 * const bucket = yield* AWS.S3.Bucket("Data", { versioning: "Enabled" });
 * const role = yield* AWS.IAM.Role("FilesRole", {
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         // S3 Files runs on EFS infrastructure and assumes the role as
 *         // the elasticfilesystem service principal.
 *         Principal: { Service: "elasticfilesystem.amazonaws.com" },
 *         Action: ["sts:AssumeRole"],
 *       },
 *     ],
 *   },
 *   inlinePolicies: {
 *     bucket: {
 *       Version: "2012-10-17",
 *       Statement: [
 *         {
 *           Effect: "Allow",
 *           Action: ["s3:ListBucket", "s3:ListBucketVersions"],
 *           Resource: [bucket.bucketArn],
 *         },
 *         {
 *           Effect: "Allow",
 *           Action: ["s3:GetObject*", "s3:PutObject*", "s3:DeleteObject*", "s3:List*", "s3:AbortMultipartUpload"],
 *           Resource: [AWS.Output.interpolate`${bucket.bucketArn}/*`],
 *         },
 *       ],
 *     },
 *   },
 * });
 *
 * const fs = yield* AWS.S3Files.FileSystem("Files", {
 *   bucket: bucket.bucketArn,
 *   roleArn: role.roleArn,
 * });
 * ```
 *
 * @example Prefix-Scoped File System
 * ```typescript
 * const fs = yield* AWS.S3Files.FileSystem("Files", {
 *   bucket: bucket.bucketArn,
 *   prefix: "shared/",
 *   roleArn: role.roleArn,
 * });
 * ```
 */
export const FileSystem = Resource<FileSystem>("AWS.S3Files.FileSystem");

const replacementKey = (props: Partial<FileSystemProps>) =>
  JSON.stringify({
    bucket: props.bucket,
    prefix: props.prefix,
    roleArn: props.roleArn,
    kmsKeyId: props.kmsKeyId,
  });

const normalizePolicy = (policy: string | undefined) => {
  if (policy === undefined) return undefined;
  try {
    return JSON.stringify(JSON.parse(policy));
  } catch {
    return policy;
  }
};

export const FileSystemProvider = () =>
  Provider.effect(
    FileSystem,
    Effect.gen(function* () {
      const observe = (fileSystemId: string) =>
        s3files
          .getFileSystem({ fileSystemId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const observedTags = (fileSystemId: string) =>
        s3files.listTagsForResource.items({ resourceId: fileSystemId }).pipe(
          Stream.runCollect,
          Effect.map((tags) => toTagRecord(Array.from(tags))),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({} as Record<string, string>),
          ),
        );

      const toAttributes = Effect.fn(function* (
        fs: s3files.GetFileSystemResponse,
      ) {
        if (
          fs.fileSystemId === undefined ||
          fs.fileSystemArn === undefined ||
          fs.bucket === undefined ||
          fs.roleArn === undefined ||
          fs.status === undefined
        ) {
          return yield* Effect.fail(
            new S3FilesNotConverged({
              resource: fs.fileSystemId ?? "unknown file system",
              status: fs.status,
            }),
          );
        }
        return {
          fileSystemId: fs.fileSystemId,
          fileSystemArn: fs.fileSystemArn,
          bucket: fs.bucket,
          roleArn: fs.roleArn,
          status: fs.status,
          ...(fs.prefix !== undefined ? { prefix: fs.prefix } : {}),
        };
      });

      // State-loss / conflict fallback: find the file system carrying this
      // logical id's Alchemy tags (optionally narrowed to a bucket).
      const findByAlchemyTags = Effect.fn(function* (
        id: string,
        bucket: string | undefined,
      ) {
        const fileSystems = yield* s3files.listFileSystems
          .items(bucket !== undefined ? { bucket } : {})
          .pipe(
            Stream.runCollect,
            Effect.map((c) => Array.from(c)),
          );
        for (const fs of fileSystems) {
          const tags = yield* observedTags(fs.fileSystemId);
          if (yield* hasAlchemyTags(id, tags)) {
            return yield* observe(fs.fileSystemId);
          }
        }
        return undefined;
      });

      const syncTags = Effect.fn(function* (
        fileSystemId: string,
        desired: Record<string, string>,
      ) {
        const current = yield* observedTags(fileSystemId);
        const { upsert, removed } = diffTags(current, desired);
        if (upsert.length > 0) {
          yield* s3files.tagResource({
            resourceId: fileSystemId,
            tags: upsert.map((t) => ({ key: t.Key, value: t.Value })),
          });
        }
        if (removed.length > 0) {
          yield* s3files.untagResource({
            resourceId: fileSystemId,
            tagKeys: removed,
          });
        }
      });

      const syncPolicy = Effect.fn(function* (
        fileSystemId: string,
        desired: PolicyDocument | undefined,
      ) {
        const current = yield* s3files
          .getFileSystemPolicy({ fileSystemId })
          .pipe(
            Effect.map((r) => r.policy),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        const desiredJson =
          desired !== undefined ? JSON.stringify(desired) : undefined;
        if (desiredJson !== undefined) {
          if (normalizePolicy(current) !== normalizePolicy(desiredJson)) {
            yield* s3files.putFileSystemPolicy({
              fileSystemId,
              policy: desiredJson,
            });
          }
        } else if (current !== undefined) {
          yield* s3files
            .deleteFileSystemPolicy({ fileSystemId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }
      });

      return FileSystem.Provider.of({
        stables: ["fileSystemId", "fileSystemArn", "bucket"],
        list: () =>
          Effect.gen(function* () {
            const fileSystems = yield* s3files.listFileSystems.items({}).pipe(
              Stream.runCollect,
              Effect.map((c) => Array.from(c)),
            );
            return fileSystems.map((fs) => ({
              fileSystemId: fs.fileSystemId,
              fileSystemArn: fs.fileSystemArn,
              bucket: fs.bucket,
              roleArn: fs.roleArn,
              status: fs.status,
            }));
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const found =
            output?.fileSystemId !== undefined
              ? yield* observe(output.fileSystemId)
              : yield* findByAlchemyTags(id, olds?.bucket);
          if (found === undefined) return undefined;
          const attrs = yield* toAttributes(found);
          const tags = toTagRecord(found.tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          // There is no UpdateFileSystem API — bucket, prefix, role, and
          // encryption are all fixed at create time. Only tags and the
          // resource policy are mutable in place.
          if (replacementKey(olds ?? {}) !== replacementKey(news ?? {})) {
            return { action: "replace" } as const;
          }
          // fall through: engine default update (tags + policy sync)
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const clientToken = yield* Effect.sync(() => crypto.randomUUID());
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative; output only caches
          //    the server-assigned file system id.
          let live =
            output?.fileSystemId !== undefined
              ? yield* observe(output.fileSystemId)
              : yield* findByAlchemyTags(id, news.bucket);

          // 2. ENSURE — create when missing. A ConflictException means a
          //    file system already exists for this bucket/prefix (possibly a
          //    concurrent create) — re-find it by our tags and only fail if
          //    it is not ours.
          if (live === undefined) {
            const created = yield* s3files
              .createFileSystem({
                bucket: news.bucket,
                prefix: news.prefix,
                roleArn: news.roleArn,
                kmsKeyId: news.kmsKeyId,
                acceptBucketWarning: news.acceptBucketWarning,
                clientToken,
                tags: toTagList(desiredTags),
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  Effect.succeed(undefined),
                ),
              );
            live =
              created?.fileSystemId !== undefined
                ? yield* observe(created.fileSystemId)
                : yield* findByAlchemyTags(id, news.bucket);
          }
          if (live?.fileSystemId === undefined) {
            return yield* Effect.fail(
              new S3FilesNotConverged({
                resource: `file system for bucket ${news.bucket}`,
                status: live?.status,
              }),
            );
          }
          const fileSystemId = live.fileSystemId;

          // Wait (bounded) for the file system to leave `creating`.
          const settled = yield* untilSettled(
            observe(fileSystemId),
            (fs) => fs === undefined || fs.status !== "creating",
          );
          if (settled === undefined || settled.status !== "available") {
            return yield* Effect.fail(
              new S3FilesNotConverged({
                resource: fileSystemId,
                status: settled?.status,
              }),
            );
          }

          // 3. SYNC — tags against observed cloud tags; policy against the
          //    observed resource policy.
          yield* syncTags(fileSystemId, desiredTags);
          yield* syncPolicy(fileSystemId, news.policy);

          // 4. RETURN fresh attributes.
          yield* session.note(fileSystemId);
          return yield* toAttributes(settled);
        }),
        delete: Effect.fn(function* ({ olds, output }) {
          // Idempotent: initiate deletion unless it is already underway.
          const live = yield* observe(output.fileSystemId);
          if (live === undefined) return;
          if (live.status !== "deleting" && live.status !== "deleted") {
            yield* retryWhileConflict(
              s3files.deleteFileSystem({
                fileSystemId: output.fileSystemId,
                forceDelete: olds.forceDestroy,
              }),
            ).pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
          }
          // Wait until the file system is fully gone: the source bucket
          // rejects DeleteBucket with BucketHasS3FileSystemAttached while
          // the file system still exists, and the engine deletes the bucket
          // immediately after this resource.
          const remaining = yield* untilSettled(
            observe(output.fileSystemId),
            (fs) => fs === undefined,
          );
          if (remaining !== undefined) {
            return yield* Effect.fail(
              new S3FilesNotConverged({
                resource: output.fileSystemId,
                status: remaining.status,
              }),
            );
          }
        }),
      });
    }),
  );
