import * as efs from "@distilled.cloud/aws/efs";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface AccessPointPosixUser {
  /** POSIX user ID applied to all file-system requests through this access point. */
  uid: number;
  /** POSIX group ID applied to all file-system requests through this access point. */
  gid: number;
  /** Secondary POSIX group IDs. */
  secondaryGids?: number[];
}

export interface AccessPointRootDirectory {
  /**
   * Path on the file system to expose as the access point's root.
   * @default "/"
   */
  path?: string;
  /**
   * Ownership and permissions EFS applies when it creates the root directory
   * on first mount. Required if `path` does not already exist on the file
   * system (which is always the case for a freshly created file system).
   */
  creationInfo?: {
    /** POSIX user ID that owns the created root directory. */
    ownerUid: number;
    /** POSIX group ID that owns the created root directory. */
    ownerGid: number;
    /** Octal permissions of the created root directory, e.g. `"750"`. */
    permissions: string;
  };
}

export interface AccessPointProps {
  /**
   * ID of the EFS file system the access point exposes
   * (e.g. `fileSystem.fileSystemId`). Cannot be changed after creation
   * (replacement).
   */
  fileSystemId: string;
  /**
   * POSIX identity enforced for all requests through this access point.
   * Cannot be changed after creation (replacement).
   */
  posixUser?: AccessPointPosixUser;
  /**
   * Directory on the file system exposed as the access point's root,
   * optionally created on first mount with the given ownership/permissions.
   * Cannot be changed after creation (replacement).
   */
  rootDirectory?: AccessPointRootDirectory;
  /**
   * Tags to apply to the access point. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface AccessPoint extends Resource<
  "AWS.EFS.AccessPoint",
  AccessPointProps,
  {
    /** The ID of the access point (e.g. `fsap-0123456789abcdef0`). */
    accessPointId: string;
    /** The ARN of the access point. */
    accessPointArn: string;
    /** The ID of the EFS file system the access point belongs to. */
    fileSystemId: string;
  },
  {},
  Providers
> {}

/**
 * An Amazon EFS access point — an application-specific entry point into a
 * file system that enforces a POSIX identity and a root directory.
 *
 * Access points are how Lambda (and other serverless compute) mounts EFS:
 * pass `accessPoint.accessPointArn` to a Lambda Function's
 * `fileSystemConfigs`. The POSIX user and root directory are immutable —
 * changing them replaces the access point.
 * @resource
 * @section Creating Access Points
 * @example Access point with a POSIX identity and auto-created root
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const files = yield* AWS.EFS.FileSystem("Files");
 * const accessPoint = yield* AWS.EFS.AccessPoint("FilesAccess", {
 *   fileSystemId: files.fileSystemId,
 *   posixUser: { uid: 1000, gid: 1000 },
 *   rootDirectory: {
 *     path: "/app",
 *     creationInfo: { ownerUid: 1000, ownerGid: 1000, permissions: "750" },
 *   },
 * });
 * ```
 *
 * @section Mounting into Lambda
 * @example Mount at /mnt/files
 * ```typescript
 * const fn = yield* AWS.Lambda.Function("Api", {
 *   main: "./src/handler.ts",
 *   vpc: { subnetIds: [subnetId], securityGroupIds: [securityGroupId] },
 *   fileSystemConfigs: [
 *     { arn: accessPoint.accessPointArn, localMountPath: "/mnt/files" },
 *   ],
 * });
 * ```
 */
export const AccessPoint = Resource<AccessPoint>("AWS.EFS.AccessPoint");

/**
 * Internal marker error used to drive the bounded wait for an access point
 * to reach the `available` lifecycle state.
 */
export class AccessPointNotAvailable extends Data.TaggedError(
  "AccessPointNotAvailable",
)<{ accessPointId: string; state: string }> {}

/**
 * Access points settle to `available` in seconds. Bounded poll (~60s),
 * explicitly typed so declaration emit never widens the provider layer
 * (see PATTERNS §7).
 */
const retryUntilAccessPointAvailable = <E extends { _tag: string }, R>(
  self: Effect.Effect<efs.AccessPointDescription, E, R>,
): Effect.Effect<efs.AccessPointDescription, E | AccessPointNotAvailable, R> =>
  Effect.retry(
    Effect.flatMap(self, (ap) =>
      ap.LifeCycleState === "available"
        ? Effect.succeed(ap)
        : Effect.fail(
            new AccessPointNotAvailable({
              accessPointId: ap.AccessPointId ?? "",
              state: ap.LifeCycleState ?? "unknown",
            }),
          ),
    ),
    {
      while: (e) => e._tag === "AccessPointNotAvailable",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(30),
      ]),
    },
  );

const efsTagsToRecord = (
  tags: readonly efs.Tag[] | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((t) => [t.Key, t.Value]));

const toWirePosixUser = (
  posixUser: AccessPointPosixUser | undefined,
): efs.PosixUser | undefined =>
  posixUser === undefined
    ? undefined
    : {
        Uid: posixUser.uid,
        Gid: posixUser.gid,
        ...(posixUser.secondaryGids !== undefined
          ? { SecondaryGids: posixUser.secondaryGids }
          : {}),
      };

const toWireRootDirectory = (
  rootDirectory: AccessPointRootDirectory | undefined,
): efs.RootDirectory | undefined =>
  rootDirectory === undefined
    ? undefined
    : {
        ...(rootDirectory.path !== undefined
          ? { Path: rootDirectory.path }
          : {}),
        ...(rootDirectory.creationInfo !== undefined
          ? {
              CreationInfo: {
                OwnerUid: rootDirectory.creationInfo.ownerUid,
                OwnerGid: rootDirectory.creationInfo.ownerGid,
                Permissions: rootDirectory.creationInfo.permissions,
              },
            }
          : {}),
      };

export const AccessPointProvider = () =>
  Provider.effect(
    AccessPoint,
    Effect.gen(function* () {
      const createToken = Effect.fn(function* (id: string) {
        return yield* createPhysicalName({ id, maxLength: 64 });
      });

      const findById = Effect.fn(function* (accessPointId: string) {
        return yield* efs
          .describeAccessPoints({ AccessPointId: accessPointId })
          .pipe(
            Effect.map((r) => r.AccessPoints?.[0]),
            Effect.catchTag("AccessPointNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const findByToken = Effect.fn(function* (
        fileSystemId: string,
        token: string,
      ) {
        return yield* efs
          .describeAccessPoints({ FileSystemId: fileSystemId })
          .pipe(
            Effect.map((r) =>
              r.AccessPoints?.find((ap) => ap.ClientToken === token),
            ),
            Effect.catchTag("FileSystemNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return AccessPoint.Provider.of({
        stables: ["accessPointId", "accessPointArn", "fileSystemId"],

        // Access points are only enumerable per file system, so walk every
        // file system in the account/region.
        list: () =>
          Effect.gen(function* () {
            const systems = yield* efs.describeFileSystems.items({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
            );
            const perSystem = yield* Effect.forEach(
              systems,
              (fs) =>
                efs
                  .describeAccessPoints({ FileSystemId: fs.FileSystemId })
                  .pipe(
                    Effect.map((r) =>
                      (r.AccessPoints ?? [])
                        .filter(
                          (ap) =>
                            ap.AccessPointId !== undefined &&
                            ap.LifeCycleState !== "deleted",
                        )
                        .map((ap) => ({
                          accessPointId: ap.AccessPointId!,
                          accessPointArn: ap.AccessPointArn!,
                          fileSystemId: ap.FileSystemId!,
                        })),
                    ),
                    Effect.catchTag("FileSystemNotFound", () =>
                      Effect.succeed([]),
                    ),
                  ),
              { concurrency: 5 },
            );
            return perSystem.flat();
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const ap = output?.accessPointId
            ? yield* findById(output.accessPointId)
            : olds?.fileSystemId
              ? yield* findByToken(olds.fileSystemId, yield* createToken(id))
              : undefined;
          if (
            ap?.AccessPointId === undefined ||
            ap.LifeCycleState === "deleted"
          ) {
            return undefined;
          }
          const attrs = {
            accessPointId: ap.AccessPointId,
            accessPointArn: ap.AccessPointArn!,
            fileSystemId: ap.FileSystemId!,
          };
          return (yield* hasAlchemyTags(id, efsTagsToRecord(ap.Tags)))
            ? attrs
            : Unowned(attrs);
        }),

        // posixUser, rootDirectory, and the file system are all immutable on
        // an access point — any change replaces it. Only tags update in
        // place.
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news) || olds === undefined) return undefined;
          if (
            news.fileSystemId !== olds.fileSystemId ||
            !deepEqual(news.posixUser, olds.posixUser) ||
            !deepEqual(news.rootDirectory, olds.rootDirectory)
          ) {
            return { action: "replace" } as const;
          }
          // undefined → default update path (tag sync)
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const token = yield* createToken(id);
          const internalTags = yield* createInternalTags(id);

          // 1. OBSERVE — output.accessPointId is only a cache; the client
          //    token is the deterministic identity within the file system.
          let ap = output?.accessPointId
            ? yield* findById(output.accessPointId)
            : yield* findByToken(news.fileSystemId, token);
          if (ap?.LifeCycleState === "deleted") {
            ap = undefined;
          }

          // 2. ENSURE — create if missing. CreateAccessPoint is idempotent
          //    on the client token; a concurrent identical create surfaces
          //    the typed AccessPointAlreadyExists which we resolve by
          //    describing the winner.
          if (ap === undefined) {
            ap = yield* efs
              .createAccessPoint({
                ClientToken: token,
                FileSystemId: news.fileSystemId,
                PosixUser: toWirePosixUser(news.posixUser),
                RootDirectory: toWireRootDirectory(news.rootDirectory),
                Tags: Object.entries({ ...news.tags, ...internalTags }).map(
                  ([Key, Value]) => ({ Key, Value }),
                ),
              })
              .pipe(
                Effect.catchTag("AccessPointAlreadyExists", (e) =>
                  efs
                    .describeAccessPoints({ AccessPointId: e.AccessPointId })
                    .pipe(Effect.map((r) => r.AccessPoints![0])),
                ),
              );
          }

          const accessPointId = ap.AccessPointId!;

          ap = yield* retryUntilAccessPointAvailable(
            efs
              .describeAccessPoints({ AccessPointId: accessPointId })
              .pipe(Effect.map((r) => r.AccessPoints![0])),
          );

          // 3. SYNC tags — diff against OBSERVED cloud tags so adoption
          //    converges.
          const observedTags = efsTagsToRecord(ap.Tags);
          const { upsert, removed } = diffTags(observedTags, {
            ...news.tags,
            ...internalTags,
          });
          if (upsert.length > 0) {
            yield* efs.tagResource({ ResourceId: accessPointId, Tags: upsert });
          }
          if (removed.length > 0) {
            yield* efs.untagResource({
              ResourceId: accessPointId,
              TagKeys: removed,
            });
          }

          yield* session.note(accessPointId);
          return {
            accessPointId,
            accessPointArn: ap.AccessPointArn!,
            fileSystemId: ap.FileSystemId!,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* efs
            .deleteAccessPoint({ AccessPointId: output.accessPointId })
            .pipe(Effect.catchTag("AccessPointNotFound", () => Effect.void));
        }),
      });
    }),
  );
