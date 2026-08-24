import * as s3files from "@distilled.cloud/aws/s3files";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  retryWhileConflict,
  S3FilesNotConverged,
  toTagList,
  toTagRecord,
  untilSettled,
} from "./internal.ts";

/**
 * POSIX identity enforced for all file system operations made through an
 * access point.
 */
export interface AccessPointPosixUser {
  /**
   * POSIX user id.
   */
  uid: number;
  /**
   * POSIX group id.
   */
  gid: number;
  /**
   * Secondary POSIX group ids.
   */
  secondaryGids?: number[];
}

/**
 * Ownership and permissions applied when the access point's root directory
 * is created on first use.
 */
export interface AccessPointCreationPermissions {
  /**
   * POSIX user id that owns the root directory.
   */
  ownerUid: number;
  /**
   * POSIX group id that owns the root directory.
   */
  ownerGid: number;
  /**
   * POSIX permission mode for the root directory (e.g. `"0755"`).
   */
  permissions: string;
}

/**
 * Root directory the access point exposes as its file system root.
 */
export interface AccessPointRootDirectory {
  /**
   * Path within the file system to expose as the access point root.
   * @default "/"
   */
  path?: string;
  /**
   * Ownership and mode applied if the service creates the root directory.
   */
  creationPermissions?: AccessPointCreationPermissions;
}

export interface AccessPointProps {
  /**
   * Id of the {@link FileSystem} the access point attaches to. Changing it
   * replaces the access point.
   */
  fileSystemId: string;
  /**
   * POSIX identity enforced for all operations through the access point.
   * Immutable — changing it replaces the access point.
   */
  posixUser?: AccessPointPosixUser;
  /**
   * Root directory the access point exposes. Immutable — changing it
   * replaces the access point.
   */
  rootDirectory?: AccessPointRootDirectory;
  /**
   * Tags to apply to the access point. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface AccessPoint extends Resource<
  "AWS.S3Files.AccessPoint",
  AccessPointProps,
  {
    /**
     * Unique ID of the access point.
     */
    accessPointId: string;
    /**
     * ARN of the access point.
     */
    accessPointArn: string;
    /**
     * ID of the file system the access point attaches to.
     */
    fileSystemId: string;
    /**
     * Current lifecycle status of the access point (e.g. `AVAILABLE`).
     */
    status: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon S3 File System Access Point — application-specific access to a
 * {@link FileSystem} with POSIX user identity and root directory
 * enforcement, for managing shared datasets in multi-tenant scenarios.
 *
 * @resource
 * @section Creating an Access Point
 * @example Basic Access Point
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const accessPoint = yield* AWS.S3Files.AccessPoint("AppAccess", {
 *   fileSystemId: fs.fileSystemId,
 * });
 * ```
 *
 * @example Access Point with POSIX Identity and Root Directory
 * ```typescript
 * const accessPoint = yield* AWS.S3Files.AccessPoint("AppAccess", {
 *   fileSystemId: fs.fileSystemId,
 *   posixUser: { uid: 1000, gid: 1000 },
 *   rootDirectory: {
 *     path: "/app",
 *     creationPermissions: { ownerUid: 1000, ownerGid: 1000, permissions: "0755" },
 *   },
 * });
 * ```
 */
export const AccessPoint = Resource<AccessPoint>("AWS.S3Files.AccessPoint");

const replacementKey = (props: Partial<AccessPointProps>) =>
  JSON.stringify({
    fileSystemId: props.fileSystemId,
    posixUser: props.posixUser,
    rootDirectory: props.rootDirectory,
  });

export const AccessPointProvider = () =>
  Provider.effect(
    AccessPoint,
    Effect.gen(function* () {
      const observe = (accessPointId: string) =>
        s3files
          .getAccessPoint({ accessPointId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const toAttributes = (ap: s3files.GetAccessPointResponse) => ({
        accessPointId: ap.accessPointId,
        accessPointArn: ap.accessPointArn,
        fileSystemId: ap.fileSystemId,
        status: ap.status,
      });

      // State-loss / conflict fallback: scan the parent file system's access
      // points for the one carrying this logical id's Alchemy tags.
      const findByAlchemyTags = Effect.fn(function* (
        id: string,
        fileSystemId: string,
      ) {
        const accessPoints = yield* s3files.listAccessPoints
          .items({ fileSystemId })
          .pipe(
            Stream.runCollect,
            Effect.map((c) => Array.from(c)),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed([] as s3files.ListAccessPointsDescription[]),
            ),
          );
        for (const item of accessPoints) {
          const ap = yield* observe(item.accessPointId);
          if (
            ap !== undefined &&
            (yield* hasAlchemyTags(id, toTagRecord(ap.tags)))
          ) {
            return ap;
          }
        }
        return undefined;
      });

      const syncTags = Effect.fn(function* (
        accessPointId: string,
        current: Record<string, string>,
        desired: Record<string, string>,
      ) {
        const { upsert, removed } = diffTags(current, desired);
        if (upsert.length > 0) {
          yield* s3files.tagResource({
            resourceId: accessPointId,
            tags: upsert.map((t) => ({ key: t.Key, value: t.Value })),
          });
        }
        if (removed.length > 0) {
          yield* s3files.untagResource({
            resourceId: accessPointId,
            tagKeys: removed,
          });
        }
      });

      return AccessPoint.Provider.of({
        stables: ["accessPointId", "accessPointArn", "fileSystemId"],
        list: () =>
          Effect.gen(function* () {
            const fileSystems = yield* s3files.listFileSystems.items({}).pipe(
              Stream.runCollect,
              Effect.map((c) => Array.from(c)),
            );
            const out: {
              accessPointId: string;
              accessPointArn: string;
              fileSystemId: string;
              status: string;
            }[] = [];
            for (const fs of fileSystems) {
              const accessPoints = yield* s3files.listAccessPoints
                .items({ fileSystemId: fs.fileSystemId })
                .pipe(
                  Stream.runCollect,
                  Effect.map((c) => Array.from(c)),
                  // the parent can vanish between list and enumerate
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed([] as s3files.ListAccessPointsDescription[]),
                  ),
                );
              for (const ap of accessPoints) {
                out.push({
                  accessPointId: ap.accessPointId,
                  accessPointArn: ap.accessPointArn,
                  fileSystemId: ap.fileSystemId,
                  status: ap.status,
                });
              }
            }
            return out;
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const found =
            output?.accessPointId !== undefined
              ? yield* observe(output.accessPointId)
              : olds?.fileSystemId !== undefined
                ? yield* findByAlchemyTags(id, olds.fileSystemId)
                : undefined;
          if (found === undefined) return undefined;
          const attrs = toAttributes(found);
          return (yield* hasAlchemyTags(id, toTagRecord(found.tags)))
            ? attrs
            : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          // There is no UpdateAccessPoint API — everything except tags is
          // fixed at create time.
          if (replacementKey(olds ?? {}) !== replacementKey(news ?? {})) {
            return { action: "replace" } as const;
          }
          // fall through: engine default update (tags sync)
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const clientToken = yield* Effect.sync(() => crypto.randomUUID());
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative; output only caches
          //    the server-assigned access point id.
          let live =
            output?.accessPointId !== undefined
              ? yield* observe(output.accessPointId)
              : yield* findByAlchemyTags(id, news.fileSystemId);

          // 2. ENSURE — create when missing; a concurrent create surfaces
          //    as ConflictException, which we treat as a race and re-find.
          if (live === undefined) {
            const created = yield* s3files
              .createAccessPoint({
                fileSystemId: news.fileSystemId,
                posixUser: news.posixUser,
                rootDirectory: news.rootDirectory,
                clientToken,
                tags: toTagList(desiredTags),
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  Effect.succeed(undefined),
                ),
              );
            live =
              created !== undefined
                ? yield* observe(created.accessPointId)
                : yield* findByAlchemyTags(id, news.fileSystemId);
          }
          if (live === undefined) {
            return yield* Effect.fail(
              new S3FilesNotConverged({
                resource: `access point on ${news.fileSystemId}`,
                status: undefined,
              }),
            );
          }
          const accessPointId = live.accessPointId;

          // Wait (bounded) for the access point to leave `creating`.
          const settled = yield* untilSettled(
            observe(accessPointId),
            (ap) => ap === undefined || ap.status !== "creating",
          );
          if (settled === undefined || settled.status !== "available") {
            return yield* Effect.fail(
              new S3FilesNotConverged({
                resource: accessPointId,
                status: settled?.status,
              }),
            );
          }

          // 3. SYNC TAGS — diff against observed cloud tags so adoption and
          //    drift converge (create-time tags only apply on first create).
          yield* syncTags(
            accessPointId,
            toTagRecord(settled.tags),
            desiredTags,
          );

          // 4. RETURN fresh attributes.
          yield* session.note(accessPointId);
          return toAttributes(settled);
        }),
        delete: Effect.fn(function* ({ output }) {
          // Idempotent: gone or already deleting counts as success.
          const live = yield* observe(output.accessPointId);
          if (
            live === undefined ||
            live.status === "deleting" ||
            live.status === "deleted"
          ) {
            return;
          }
          yield* retryWhileConflict(
            s3files.deleteAccessPoint({
              accessPointId: output.accessPointId,
            }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      });
    }),
  );
