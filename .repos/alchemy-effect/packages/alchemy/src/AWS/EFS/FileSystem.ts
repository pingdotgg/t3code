import * as efs from "@distilled.cloud/aws/efs";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import {
  normalizePolicyDocument,
  type PolicyDocument,
  stringifyPolicyDocument,
} from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";

/**
 * A single EFS lifecycle-management rule. EFS requires each rule to carry
 * exactly one transition setting, so a full configuration is expressed as an
 * array of single-setting policies.
 */
export interface FileSystemLifecyclePolicy {
  /**
   * Transition files to the Infrequent Access (IA) storage class after the
   * given period without access, e.g. `"AFTER_30_DAYS"`.
   */
  transitionToIA?: efs.TransitionToIARules;
  /**
   * Transition files back to primary storage on first access, e.g.
   * `"AFTER_1_ACCESS"`.
   */
  transitionToPrimaryStorageClass?: efs.TransitionToPrimaryStorageClassRules;
  /**
   * Transition files to the Archive storage class after the given period
   * without access, e.g. `"AFTER_90_DAYS"`.
   */
  transitionToArchive?: efs.TransitionToArchiveRules;
}

export interface FileSystemProps {
  /**
   * Performance mode of the file system. `generalPurpose` is recommended for
   * all workloads; `maxIO` is a previous-generation mode for highly
   * parallelized workloads. Cannot be changed after creation (replacement).
   * `maxIO` is not supported with `elastic` throughput or One Zone file
   * systems.
   * @default "generalPurpose"
   */
  performanceMode?: "generalPurpose" | "maxIO";
  /**
   * Whether the file system is encrypted at rest. Cannot be changed after
   * creation (replacement).
   * @default true
   */
  encrypted?: boolean;
  /**
   * The KMS key used to encrypt the file system. Only meaningful when
   * `encrypted` is `true`. Cannot be changed after creation (replacement).
   * @default the AWS-managed `/aws/elasticfilesystem` key
   */
  kmsKeyId?: string;
  /**
   * Throughput mode of the file system. `elastic` scales automatically and is
   * recommended for spiky workloads; `provisioned` requires
   * `provisionedThroughputInMibps`. Updatable in place.
   * @default "bursting"
   */
  throughputMode?: "bursting" | "provisioned" | "elastic";
  /**
   * Provisioned throughput in MiB/s. Required when `throughputMode` is
   * `provisioned`.
   */
  provisionedThroughputInMibps?: number;
  /**
   * Create a One Zone file system in this Availability Zone (e.g.
   * `us-west-2a`). Cannot be changed after creation (replacement).
   * @default regional (multi-AZ) file system
   */
  availabilityZoneName?: string;
  /**
   * Lifecycle management rules that transition files between storage
   * classes. Omit (or pass an empty array) to disable lifecycle management.
   */
  lifecyclePolicies?: FileSystemLifecyclePolicy[];
  /**
   * Whether AWS Backup automatic backups are enabled for the file system.
   * Updatable in place. When omitted, the AWS default is left alone
   * (disabled for regional file systems, enabled for One Zone file
   * systems).
   * @default AWS default (regional: disabled; One Zone: enabled)
   */
  backup?: boolean;
  /**
   * Replication overwrite protection. `ENABLED` (the AWS default) makes the
   * file system writable and blocks it from being used as a replication
   * destination; `DISABLED` makes it read-only so an EFS replication
   * configuration can overwrite it. Updatable in place. When omitted, the
   * current protection setting is left alone.
   * @default AWS default ("ENABLED")
   */
  replicationOverwriteProtection?: "ENABLED" | "DISABLED";
  /**
   * The file system policy — an IAM resource-based policy controlling client
   * access to the file system (e.g. enforcing in-transit encryption or
   * restricting mounts to access points). Either a structured
   * {@link PolicyDocument} or a raw JSON string. Omitting the property
   * removes any explicit policy, reverting to the default EFS policy.
   */
  policy?: PolicyDocument | string;
  /**
   * Tags to apply to the file system. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface FileSystem extends Resource<
  "AWS.EFS.FileSystem",
  FileSystemProps,
  {
    /** The ID of the file system (e.g. `fs-0123456789abcdef0`). */
    fileSystemId: string;
    /** The ARN of the file system. */
    fileSystemArn: string;
  },
  {},
  Providers
> {}

/**
 * An Amazon EFS file system — serverless, elastic, shared POSIX storage.
 *
 * The file system is created encrypted by default with a deterministic
 * creation token derived from the app, stage, and logical ID, so retried
 * creates are idempotent. Mount it into compute with
 * {@link MountTarget} (per-subnet network endpoints) and
 * {@link AccessPoint} (application-specific POSIX entry points — required
 * for Lambda mounts).
 * @resource
 * @section Creating File Systems
 * @example Default file system (encrypted, general purpose)
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const files = yield* AWS.EFS.FileSystem("Files");
 * ```
 *
 * @example Elastic throughput
 * ```typescript
 * const files = yield* AWS.EFS.FileSystem("Files", {
 *   throughputMode: "elastic",
 * });
 * ```
 *
 * @section Lifecycle Management
 * @example Tier cold files to Infrequent Access
 * ```typescript
 * const files = yield* AWS.EFS.FileSystem("Files", {
 *   lifecyclePolicies: [
 *     { transitionToIA: "AFTER_30_DAYS" },
 *     { transitionToPrimaryStorageClass: "AFTER_1_ACCESS" },
 *   ],
 * });
 * ```
 *
 * @section Backup and Protection
 * @example Enable AWS Backup automatic backups
 * ```typescript
 * const files = yield* AWS.EFS.FileSystem("Files", {
 *   backup: true,
 * });
 * ```
 *
 * @example Allow the file system to be a replication destination
 * ```typescript
 * const files = yield* AWS.EFS.FileSystem("Files", {
 *   replicationOverwriteProtection: "DISABLED",
 * });
 * ```
 *
 * @section File System Policy
 * @example Enforce in-transit encryption with a typed PolicyDocument
 * ```typescript
 * const files = yield* AWS.EFS.FileSystem("Files", {
 *   policy: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Sid: "DenyUnencryptedTransport",
 *         Effect: "Deny",
 *         Principal: { AWS: "*" },
 *         Action: ["elasticfilesystem:ClientMount"],
 *         Condition: { Bool: { "aws:SecureTransport": "false" } },
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @section Mounting into Lambda
 * Lambda mounts EFS through an access point; the function must be attached
 * to a VPC that can reach a mount target.
 *
 * @example File system + mount target + access point + Lambda
 * ```typescript
 * const files = yield* AWS.EFS.FileSystem("Files");
 * const target = yield* AWS.EFS.MountTarget("FilesTarget", {
 *   fileSystemId: files.fileSystemId,
 *   subnetId,
 * });
 * const accessPoint = yield* AWS.EFS.AccessPoint("FilesAccess", {
 *   fileSystemId: files.fileSystemId,
 *   posixUser: { uid: 1000, gid: 1000 },
 *   rootDirectory: {
 *     path: "/lambda",
 *     creationInfo: { ownerUid: 1000, ownerGid: 1000, permissions: "750" },
 *   },
 * });
 * const fn = yield* AWS.Lambda.Function("Api", {
 *   main: "./src/handler.ts",
 *   vpc: { subnetIds: [subnetId], securityGroupIds: [securityGroupId] },
 *   fileSystemConfigs: [
 *     // pass the AccessPoint resource itself (or its ARN)
 *     { accessPoint, localMountPath: "/mnt/files" },
 *   ],
 *   // depend on the mount target so the function is created only after
 *   // the network endpoint is available
 *   env: { EFS_MOUNT_TARGET: target.mountTargetId },
 * });
 * ```
 *
 * @example Host-agnostic mount binding (Lambda or ECS)
 * `EFS.mount` wires the mount config + least-privilege IAM through the
 * host's binding channel — the same code works inside a Lambda Function or
 * an ECS Task body (provide `AWS.EFS.MountLive` on the host Effect).
 * ```typescript
 * export default class Api extends AWS.Lambda.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url, vpc: { subnetIds, securityGroupIds } },
 *   Effect.gen(function* () {
 *     const files = yield* AWS.EFS.mount(accessPoint, { path: "/mnt/files" });
 *     return Effect.fn(function* (event: unknown) {
 *       // read/write under files.path at runtime
 *       return { mountedAt: files.path };
 *     });
 *   }).pipe(Effect.provide(AWS.EFS.MountLive)),
 * ) {}
 * ```
 */
export const FileSystem = Resource<FileSystem>("AWS.EFS.FileSystem");

const isMutableEfsTagKey = (key: string): boolean =>
  !key.toLowerCase().startsWith("aws:");

const mutableEfsTags = (tags: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags).filter(([key]) => isMutableEfsTagKey(key)),
  );

const efsTagsToRecord = (
  tags: readonly efs.Tag[] | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter((tag) => isMutableEfsTagKey(tag.Key))
      .map((tag) => [tag.Key, tag.Value]),
  );

/**
 * A file system briefly reports `creating`/`updating` before settling in
 * `available`. Bounded poll (~60s), explicitly typed so declaration emit
 * never widens the provider layer (see PATTERNS §7).
 */
const retryUntilFileSystemAvailable = <E extends { _tag: string }, R>(
  self: Effect.Effect<efs.FileSystemDescription, E, R>,
): Effect.Effect<efs.FileSystemDescription, E | FileSystemNotAvailable, R> =>
  Effect.retry(
    Effect.flatMap(self, (fs) =>
      fs.LifeCycleState === "available"
        ? Effect.succeed(fs)
        : Effect.fail(
            new FileSystemNotAvailable({
              fileSystemId: fs.FileSystemId,
              state: fs.LifeCycleState,
            }),
          ),
    ),
    {
      while: (e) => e._tag === "FileSystemNotAvailable",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(30),
      ]),
    },
  );

/**
 * Deleting a file system whose mount targets are still tearing down (their
 * ENIs release asynchronously) transiently fails with `FileSystemInUse`.
 * Bounded retry (~60s), explicitly typed (PATTERNS §7).
 */
const retryWhileFileSystemInUse = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "FileSystemInUse",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(20)]),
  });

/**
 * Throughput updates are rejected with `IncorrectFileSystemLifeCycleState`
 * while a previous modification is still applying. Bounded retry (~60s),
 * explicitly typed (PATTERNS §7).
 */
const retryWhileFileSystemUpdating = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "IncorrectFileSystemLifeCycleState",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(20)]),
  });

/**
 * Internal marker error used to drive the bounded wait for a file system to
 * reach the `available` lifecycle state.
 */
export class FileSystemNotAvailable extends Data.TaggedError(
  "FileSystemNotAvailable",
)<{ fileSystemId: string; state: string }> {}

const toWireLifecyclePolicies = (
  policies: FileSystemLifecyclePolicy[] | undefined,
): efs.LifecyclePolicy[] =>
  (policies ?? []).map((p) => ({
    ...(p.transitionToIA !== undefined
      ? { TransitionToIA: p.transitionToIA }
      : {}),
    ...(p.transitionToPrimaryStorageClass !== undefined
      ? { TransitionToPrimaryStorageClass: p.transitionToPrimaryStorageClass }
      : {}),
    ...(p.transitionToArchive !== undefined
      ? { TransitionToArchive: p.transitionToArchive }
      : {}),
  }));

const canonicalPolicies = (policies: readonly efs.LifecyclePolicy[]): string =>
  JSON.stringify(
    policies
      .map((p) => ({
        TransitionToIA: p.TransitionToIA ?? null,
        TransitionToPrimaryStorageClass:
          p.TransitionToPrimaryStorageClass ?? null,
        TransitionToArchive: p.TransitionToArchive ?? null,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );

export const FileSystemProvider = () =>
  Provider.effect(
    FileSystem,
    Effect.gen(function* () {
      const createToken = Effect.fn(function* (id: string) {
        return yield* createPhysicalName({ id, maxLength: 64 });
      });

      const fileSystemArnOf = Effect.fn(function* (fileSystemId: string) {
        const { accountId, region } = yield* AWSEnvironment.current;
        return `arn:aws:elasticfilesystem:${region}:${accountId}:file-system/${fileSystemId}`;
      });

      const findByToken = Effect.fn(function* (token: string) {
        return yield* efs.describeFileSystems({ CreationToken: token }).pipe(
          Effect.map((r) => r.FileSystems?.[0]),
          Effect.catchTag("FileSystemNotFound", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      const findById = Effect.fn(function* (fileSystemId: string) {
        return yield* efs
          .describeFileSystems({ FileSystemId: fileSystemId })
          .pipe(
            Effect.map((r) => r.FileSystems?.[0]),
            Effect.catchTag("FileSystemNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return FileSystem.Provider.of({
        stables: ["fileSystemId", "fileSystemArn"],

        list: () =>
          Effect.gen(function* () {
            const systems = yield* efs.describeFileSystems.items({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
            );
            return yield* Effect.forEach(systems, (fs) =>
              Effect.gen(function* () {
                return {
                  fileSystemId: fs.FileSystemId,
                  fileSystemArn:
                    fs.FileSystemArn ??
                    (yield* fileSystemArnOf(fs.FileSystemId)),
                };
              }),
            );
          }),

        read: Effect.fn(function* ({ id, output }) {
          const fs = output?.fileSystemId
            ? yield* findById(output.fileSystemId)
            : yield* findByToken(yield* createToken(id));
          if (fs === undefined || fs.LifeCycleState === "deleted") {
            return undefined;
          }
          const attrs = {
            fileSystemId: fs.FileSystemId,
            fileSystemArn:
              fs.FileSystemArn ?? (yield* fileSystemArnOf(fs.FileSystemId)),
          };
          return (yield* hasAlchemyTags(id, efsTagsToRecord(fs.Tags)))
            ? attrs
            : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ news = {}, olds = {} }) {
          if (!isResolved(news)) return undefined;
          const replaced =
            (news.performanceMode ?? "generalPurpose") !==
              (olds.performanceMode ?? "generalPurpose") ||
            (news.encrypted ?? true) !== (olds.encrypted ?? true) ||
            news.kmsKeyId !== olds.kmsKeyId ||
            news.availabilityZoneName !== olds.availabilityZoneName;
          if (replaced) {
            return { action: "replace" } as const;
          }
          // undefined → default update path (throughput/lifecycle/tags sync)
        }),

        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const token = yield* createToken(id);
          const internalTags = yield* createInternalTags(id);

          // 1. OBSERVE — the creation token is the deterministic identity;
          //    output.fileSystemId is only a cache and may be stale.
          let fs = output?.fileSystemId
            ? yield* findById(output.fileSystemId)
            : yield* findByToken(token);
          if (fs?.LifeCycleState === "deleted") {
            fs = undefined;
          }

          // 2. ENSURE — create if missing. CreateFileSystem is idempotent on
          //    the creation token; a concurrent create surfaces the typed
          //    FileSystemAlreadyExists which we resolve by re-observing.
          if (fs === undefined) {
            fs = yield* efs
              .createFileSystem({
                CreationToken: token,
                PerformanceMode: news.performanceMode,
                Encrypted: news.encrypted ?? true,
                KmsKeyId: news.kmsKeyId,
                Backup: news.backup,
                ThroughputMode: news.throughputMode,
                ProvisionedThroughputInMibps: news.provisionedThroughputInMibps,
                AvailabilityZoneName: news.availabilityZoneName,
                Tags: Object.entries(
                  mutableEfsTags({ ...news.tags, ...internalTags }),
                ).map(([Key, Value]) => ({ Key, Value })),
              })
              .pipe(
                Effect.catchTag("FileSystemAlreadyExists", (e) =>
                  efs
                    .describeFileSystems({ FileSystemId: e.FileSystemId })
                    .pipe(Effect.map((r) => r.FileSystems![0])),
                ),
              );
          }

          const fileSystemId = fs.FileSystemId;

          // File-system mutations (throughput, lifecycle) require the
          // `available` state; creation settles in seconds.
          fs = yield* retryUntilFileSystemAvailable(
            efs
              .describeFileSystems({ FileSystemId: fileSystemId })
              .pipe(Effect.map((r) => r.FileSystems![0])),
          );

          // 3a. SYNC throughput — observed vs desired; only call the API on a
          //     real delta.
          if (news.throughputMode !== undefined) {
            const modeChanged = fs.ThroughputMode !== news.throughputMode;
            const provisionedChanged =
              news.throughputMode === "provisioned" &&
              fs.ProvisionedThroughputInMibps !==
                news.provisionedThroughputInMibps;
            if (modeChanged || provisionedChanged) {
              yield* retryWhileFileSystemUpdating(
                efs.updateFileSystem({
                  FileSystemId: fileSystemId,
                  ThroughputMode: news.throughputMode,
                  ProvisionedThroughputInMibps:
                    news.throughputMode === "provisioned"
                      ? news.provisionedThroughputInMibps
                      : undefined,
                }),
              );
            }
          }

          // 3b. SYNC lifecycle policies — a PUT with the full desired list;
          //     an empty list clears lifecycle management.
          const observedPolicies = yield* efs
            .describeLifecycleConfiguration({ FileSystemId: fileSystemId })
            .pipe(Effect.map((r) => r.LifecyclePolicies ?? []));
          const desiredPolicies = toWireLifecyclePolicies(
            news.lifecyclePolicies,
          );
          if (
            canonicalPolicies(observedPolicies) !==
            canonicalPolicies(desiredPolicies)
          ) {
            yield* retryWhileFileSystemUpdating(
              efs.putLifecycleConfiguration({
                FileSystemId: fileSystemId,
                LifecyclePolicies: desiredPolicies,
              }),
            );
          }

          // 3c. SYNC backup policy — observed vs desired; only call the API
          //     on a real delta. An in-flight transition (ENABLING/
          //     DISABLING) counts as its target state. When the prop is
          //     omitted the AWS default is left alone.
          if (news.backup !== undefined) {
            const observedBackupStatus = yield* efs
              .describeBackupPolicy({ FileSystemId: fileSystemId })
              .pipe(
                Effect.map((r) => r.BackupPolicy?.Status),
                Effect.catchTag("PolicyNotFound", () =>
                  Effect.succeed(undefined),
                ),
              );
            const observedBackup =
              observedBackupStatus === "ENABLED" ||
              observedBackupStatus === "ENABLING";
            if (observedBackup !== news.backup) {
              yield* retryWhileFileSystemUpdating(
                efs.putBackupPolicy({
                  FileSystemId: fileSystemId,
                  BackupPolicy: {
                    Status: news.backup ? "ENABLED" : "DISABLED",
                  },
                }),
              );
            }
          }

          // 3d. SYNC replication overwrite protection — observed vs desired
          //     from the file system description. When the prop is omitted
          //     the current protection setting is left alone.
          if (news.replicationOverwriteProtection !== undefined) {
            const observedProtection =
              fs.FileSystemProtection?.ReplicationOverwriteProtection ??
              "ENABLED";
            if (observedProtection !== news.replicationOverwriteProtection) {
              yield* retryWhileFileSystemUpdating(
                efs.updateFileSystemProtection({
                  FileSystemId: fileSystemId,
                  ReplicationOverwriteProtection:
                    news.replicationOverwriteProtection,
                }),
              );
            }
          }

          // 3e. SYNC file system policy — compare the observed policy with
          //     the desired one after canonicalization (sorted keys, no
          //     whitespace) so a re-deploy of an equivalent document is a
          //     no-op API-wise.
          const observedPolicy = yield* efs
            .describeFileSystemPolicy({ FileSystemId: fileSystemId })
            .pipe(
              Effect.map((r) => r.Policy),
              Effect.catchTag("PolicyNotFound", () =>
                Effect.succeed(undefined),
              ),
            );
          const desiredPolicy =
            news.policy === undefined
              ? undefined
              : typeof news.policy === "string"
                ? news.policy
                : stringifyPolicyDocument(news.policy);
          if (desiredPolicy === undefined) {
            if (observedPolicy !== undefined) {
              yield* retryWhileFileSystemUpdating(
                efs.deleteFileSystemPolicy({ FileSystemId: fileSystemId }),
              );
            }
          } else if (
            observedPolicy === undefined ||
            normalizePolicyDocument(observedPolicy) !==
              normalizePolicyDocument(desiredPolicy)
          ) {
            yield* retryWhileFileSystemUpdating(
              efs.putFileSystemPolicy({
                FileSystemId: fileSystemId,
                Policy: desiredPolicy,
              }),
            );
          }

          // 3f. SYNC tags — diff against OBSERVED cloud tags so adoption
          //     converges.
          const observedTags = efsTagsToRecord(fs.Tags);
          const desiredTags = mutableEfsTags({
            ...news.tags,
            ...internalTags,
          });
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* efs.tagResource({
              ResourceId: fileSystemId,
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* efs.untagResource({
              ResourceId: fileSystemId,
              TagKeys: removed,
            });
          }

          yield* session.note(fileSystemId);
          return {
            fileSystemId,
            fileSystemArn:
              fs.FileSystemArn ?? (yield* fileSystemArnOf(fileSystemId)),
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* retryWhileFileSystemInUse(
            efs.deleteFileSystem({ FileSystemId: output.fileSystemId }),
          ).pipe(Effect.catchTag("FileSystemNotFound", () => Effect.void));
        }),
      });
    }),
  );
