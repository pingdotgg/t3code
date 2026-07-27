import * as fsx from "@distilled.cloud/aws/fsx";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface FileSystemProps {
  /**
   * The type of file system to create. Cannot be changed after creation
   * (replacement). `LUSTRE` is the cheapest/fastest scratch storage;
   * `WINDOWS`, `ONTAP`, and `OPENZFS` are the other managed engines.
   */
  fileSystemType: fsx.FileSystemType;
  /**
   * Storage capacity in GiB. Minimums depend on the engine and deployment
   * type (e.g. Lustre `SCRATCH_2` starts at 1200 GiB). Can be increased in
   * place; decreasing requires replacement.
   */
  storageCapacity?: number;
  /**
   * Storage type. `SSD` (default) or `HDD` (Lustre `PERSISTENT_1` / Windows
   * only), or `INTELLIGENT_TIERING` (OpenZFS). Cannot be changed after
   * creation (replacement).
   */
  storageType?: fsx.StorageType;
  /**
   * Subnet IDs the file system is deployed into. Single-AZ engines take one
   * subnet; multi-AZ ONTAP/OpenZFS take two. Cannot be changed after
   * creation (replacement).
   */
  subnetIds: string[];
  /**
   * Security group IDs to associate with the file system's network
   * interfaces.
   */
  securityGroupIds?: string[];
  /**
   * The KMS key used to encrypt the file system at rest. Cannot be changed
   * after creation (replacement).
   * @default the AWS-managed FSx key
   */
  kmsKeyId?: string;
  /**
   * Engine version string (e.g. Lustre `"2.15"`, ONTAP `"9.13"`). Cannot be
   * changed after creation (replacement).
   */
  fileSystemTypeVersion?: string;
  /**
   * Lustre-specific configuration (deployment type, per-unit throughput,
   * data-repository import/export, compression, etc.). Passed straight
   * through to the FSx API.
   */
  lustreConfiguration?: fsx.CreateFileSystemLustreConfiguration;
  /**
   * Windows-specific configuration (Active Directory, throughput capacity,
   * deployment type). Passed straight through to the FSx API.
   */
  windowsConfiguration?: fsx.CreateFileSystemWindowsConfiguration;
  /**
   * NetApp ONTAP-specific configuration. Passed straight through to the FSx
   * API.
   */
  ontapConfiguration?: fsx.CreateFileSystemOntapConfiguration;
  /**
   * OpenZFS-specific configuration. Passed straight through to the FSx API.
   */
  openZFSConfiguration?: fsx.CreateFileSystemOpenZFSConfiguration;
  /**
   * Tags to apply to the file system. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface FileSystem extends Resource<
  "AWS.FSx.FileSystem",
  FileSystemProps,
  {
    /** The generated ID of the file system, e.g. `fs-0123456789abcdef0`. */
    fileSystemId: string;
    /** The ARN of the file system. */
    fileSystemArn: string;
    /** The engine of the file system: `LUSTRE`, `WINDOWS`, `ONTAP`, or `OPENZFS`. */
    fileSystemType: fsx.FileSystemType;
    /** The DNS name clients mount, e.g. `fs-....fsx.us-west-2.amazonaws.com`. */
    dnsName: string | undefined;
    /** The VPC the file system's network interfaces live in. */
    vpcId: string | undefined;
  },
  {},
  Providers
> {}

/**
 * An Amazon FSx file system — fully-managed shared storage for Lustre,
 * Windows File Server, NetApp ONTAP, or OpenZFS.
 *
 * FSx file systems take several minutes to provision. The file system id,
 * ARN, and DNS name are returned as soon as `CreateFileSystem` accepts the
 * request; the file system then transitions `CREATING` → `AVAILABLE`
 * asynchronously. Create is idempotent on a deterministic client request
 * token derived from the app, stage, and logical id; if state is lost, the
 * file system is re-discovered by its internal Alchemy tags.
 *
 * @resource
 * @section Creating File Systems
 * @example Lustre scratch file system (cheapest / fastest)
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const scratch = yield* AWS.FSx.FileSystem("Scratch", {
 *   fileSystemType: "LUSTRE",
 *   storageCapacity: 1200,
 *   subnetIds: [subnetId],
 *   lustreConfiguration: { DeploymentType: "SCRATCH_2" },
 * });
 * ```
 *
 * @example Persistent Lustre with S3 data repository
 * ```typescript
 * const files = yield* AWS.FSx.FileSystem("Files", {
 *   fileSystemType: "LUSTRE",
 *   storageCapacity: 1200,
 *   subnetIds: [subnetId],
 *   lustreConfiguration: {
 *     DeploymentType: "PERSISTENT_2",
 *     PerUnitStorageThroughput: 125,
 *     DataCompressionType: "LZ4",
 *   },
 * });
 * ```
 *
 * @example OpenZFS file system
 * ```typescript
 * const zfs = yield* AWS.FSx.FileSystem("Zfs", {
 *   fileSystemType: "OPENZFS",
 *   storageCapacity: 64,
 *   subnetIds: [subnetId],
 *   openZFSConfiguration: {
 *     DeploymentType: "SINGLE_AZ_1",
 *     ThroughputCapacity: 64,
 *   },
 * });
 * ```
 */
export const FileSystem = Resource<FileSystem>("AWS.FSx.FileSystem");

const fsxTagsToRecord = (
  tags: readonly fsx.Tag[] | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((t) => [t.Key, t.Value]));

const deleteConfigFor = (
  type: fsx.FileSystemType,
): Partial<fsx.DeleteFileSystemRequest> => {
  switch (type) {
    case "LUSTRE":
      return { LustreConfiguration: { SkipFinalBackup: true } };
    case "WINDOWS":
      return { WindowsConfiguration: { SkipFinalBackup: true } };
    case "OPENZFS":
      return {
        OpenZFSConfiguration: {
          SkipFinalBackup: true,
          Options: ["DELETE_CHILD_VOLUMES_AND_SNAPSHOTS"],
        },
      };
    default:
      // ONTAP has no file-system-level skip-final-backup option; volumes and
      // SVMs must be torn down first.
      return {};
  }
};

export const FileSystemProvider = () =>
  Provider.effect(
    FileSystem,
    Effect.gen(function* () {
      const createToken = Effect.fn(function* (id: string) {
        return yield* createPhysicalName({ id, maxLength: 63 });
      });

      const fileSystemArnOf = Effect.fn(function* (fileSystemId: string) {
        const { accountId, region } = yield* AWSEnvironment.current;
        return `arn:aws:fsx:${region}:${accountId}:file-system/${fileSystemId}`;
      });

      const findById = Effect.fn(function* (fileSystemId: string) {
        return yield* fsx
          .describeFileSystems({ FileSystemIds: [fileSystemId] })
          .pipe(
            Effect.map((r) => r.FileSystems?.[0]),
            Effect.catchTag("FileSystemNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const listAll = fsx.describeFileSystems.pages({}).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) => page.FileSystems ?? []),
        ),
      );

      // FSx has no creation-token lookup, so recover lost state by scanning
      // every file system and matching our internal Alchemy tags.
      const findByTags = Effect.fn(function* (id: string) {
        const internalTags = yield* createInternalTags(id);
        const all = yield* listAll;
        return all.find((fs) => {
          const tags = fsxTagsToRecord(fs.Tags);
          return Object.entries(internalTags).every(([k, v]) => tags[k] === v);
        });
      });

      return FileSystem.Provider.of({
        stables: ["fileSystemId", "fileSystemArn", "fileSystemType"],

        list: () =>
          Effect.gen(function* () {
            const systems = yield* listAll;
            return yield* Effect.forEach(systems, (fs) =>
              Effect.gen(function* () {
                return {
                  fileSystemId: fs.FileSystemId!,
                  fileSystemArn:
                    fs.ResourceARN ??
                    (yield* fileSystemArnOf(fs.FileSystemId!)),
                  fileSystemType: fs.FileSystemType ?? "LUSTRE",
                  dnsName: fs.DNSName,
                  vpcId: fs.VpcId,
                };
              }),
            );
          }),

        read: Effect.fn(function* ({ id, output }) {
          const fs = output?.fileSystemId
            ? yield* findById(output.fileSystemId)
            : yield* findByTags(id);
          if (fs === undefined || fs.Lifecycle === "DELETING") {
            return undefined;
          }
          const attrs = {
            fileSystemId: fs.FileSystemId!,
            fileSystemArn:
              fs.ResourceARN ?? (yield* fileSystemArnOf(fs.FileSystemId!)),
            fileSystemType: fs.FileSystemType ?? "LUSTRE",
            dnsName: fs.DNSName,
            vpcId: fs.VpcId,
          };
          return (yield* hasAlchemyTags(id, fsxTagsToRecord(fs.Tags)))
            ? attrs
            : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          const replaced =
            news.fileSystemType !== olds.fileSystemType ||
            news.kmsKeyId !== olds.kmsKeyId ||
            (news.storageType ?? "SSD") !== (olds.storageType ?? "SSD") ||
            news.fileSystemTypeVersion !== olds.fileSystemTypeVersion ||
            JSON.stringify(news.subnetIds) !== JSON.stringify(olds.subnetIds) ||
            // storage capacity can only be increased in place
            (news.storageCapacity !== undefined &&
              olds.storageCapacity !== undefined &&
              news.storageCapacity < olds.storageCapacity);
          if (replaced) {
            return { action: "replace" } as const;
          }
          // undefined → default update path (storage-capacity increase, tags)
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);

          // 1. OBSERVE — cloud state is authoritative; output is only a cache.
          let fs = output?.fileSystemId
            ? yield* findById(output.fileSystemId)
            : yield* findByTags(id);
          if (fs?.Lifecycle === "DELETING") {
            fs = undefined;
          }

          // 2. ENSURE — create if missing. CreateFileSystem is idempotent on
          //    the deterministic client request token.
          if (fs === undefined) {
            const token = yield* createToken(id);
            fs = yield* fsx
              .createFileSystem({
                ClientRequestToken: token,
                FileSystemType: news.fileSystemType,
                StorageCapacity: news.storageCapacity,
                StorageType: news.storageType,
                SubnetIds: news.subnetIds,
                SecurityGroupIds: news.securityGroupIds,
                KmsKeyId: news.kmsKeyId,
                FileSystemTypeVersion: news.fileSystemTypeVersion,
                LustreConfiguration: news.lustreConfiguration,
                WindowsConfiguration: news.windowsConfiguration,
                OntapConfiguration: news.ontapConfiguration,
                OpenZFSConfiguration: news.openZFSConfiguration,
                Tags: Object.entries({ ...news.tags, ...internalTags }).map(
                  ([Key, Value]) => ({ Key, Value }),
                ),
              })
              .pipe(Effect.map((r) => r.FileSystem!));
          }

          const fileSystemId = fs.FileSystemId!;

          // 3a. SYNC storage capacity — only an increase is valid, and only
          //     while the file system is settled. Skip during CREATING.
          if (
            fs.Lifecycle === "AVAILABLE" &&
            news.storageCapacity !== undefined &&
            fs.StorageCapacity !== undefined &&
            news.storageCapacity > fs.StorageCapacity
          ) {
            yield* fsx.updateFileSystem({
              FileSystemId: fileSystemId,
              StorageCapacity: news.storageCapacity,
            });
          }

          // 3b. SYNC tags — diff against OBSERVED cloud tags so adoption
          //     converges.
          const observedTags = fsxTagsToRecord(fs.Tags);
          const { upsert, removed } = diffTags(observedTags, {
            ...news.tags,
            ...internalTags,
          });
          if (upsert.length > 0) {
            yield* fsx.tagResource({
              ResourceARN: fs.ResourceARN,
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* fsx.untagResource({
              ResourceARN: fs.ResourceARN,
              TagKeys: removed,
            });
          }

          yield* session.note(fileSystemId);
          return {
            fileSystemId,
            fileSystemArn:
              fs.ResourceARN ?? (yield* fileSystemArnOf(fileSystemId)),
            fileSystemType: fs.FileSystemType ?? news.fileSystemType,
            dnsName: fs.DNSName,
            vpcId: fs.VpcId,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* fsx
            .deleteFileSystem({
              FileSystemId: output.fileSystemId,
              ...deleteConfigFor(output.fileSystemType),
            })
            .pipe(Effect.catchTag("FileSystemNotFound", () => Effect.void));
        }),
      });
    }),
  );
