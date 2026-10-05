import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { DeleteNotConfirmed } from "../Errors.ts";
import type { Providers } from "../Providers.ts";
import {
  listAlchemyBuckets,
  toFolderName,
  withTrailingSlash,
} from "./internal.ts";

export type ManagedProps = {
  /**
   * Name of the uniform-access bucket that contains this managed folder.
   * Immutable — changing it replaces the folder.
   */
  bucketName: string;
  /**
   * Managed folder path. A trailing slash is added if omitted. If
   * omitted entirely, a unique name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the folder.
   */
  managedFolderName?: string;
};

export type Managed = Resource<
  "GCP.Storage.Managed",
  ManagedProps,
  {
    /** Parent bucket name. */
    bucketName: string;
    /** Managed folder path, including the trailing slash. */
    managedFolderName: string;
    /** Server-assigned id (`{bucket}/{folder}`). */
    id: string | undefined;
    /** Metadata generation. */
    metageneration: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** GCS self-link. */
    selfLink: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Storage managed folder.
 *
 * Managed folders provide IAM on an object-name prefix in a bucket with
 * uniform bucket-level access. Identity is `(bucket, folder name)`.
 * Managed folders have no mutable fields and no labels, so `list` /
 * `pnpm nuke:gcp` discover them by enumerating alchemy-labeled buckets.
 *
 * ### Creating a Managed Folder
 * **Example:** Generated name
 * ```typescript
 * const bucket = yield* GCP.Storage.Bucket("assets", {
 *   uniformBucketLevelAccess: true,
 *   forceDestroy: true,
 * });
 * const folder = yield* GCP.Storage.Managed("team", {
 *   bucketName: bucket.bucketName,
 * });
 * ```
 *
 * **Example:** Explicit path
 * ```typescript
 * const folder = yield* GCP.Storage.Managed("team", {
 *   bucketName: bucket.bucketName,
 *   managedFolderName: "teams/payments/",
 * });
 * ```
 *
 * @resource
 * @category Storage
 */
export const Managed = Resource<Managed>("GCP.Storage.Managed");

export class ManagedNotResolved extends Data.TaggedError(
  "GCP.Storage.ManagedNotResolved",
)<{
  bucketName: string;
  managedFolderName: string;
}> {}

const toAttrs = (folder: storage.ManagedFolder, bucketName: string) => ({
  bucketName: folder.bucket ?? bucketName,
  managedFolderName: withTrailingSlash(folder.name ?? ""),
  id: folder.id,
  metageneration: folder.metageneration,
  createTime: folder.createTime,
  updateTime: folder.updateTime,
  selfLink: folder.selfLink,
});

const getByName = (bucketName: string, managedFolderName: string) =>
  storage
    .getManagedFolders({
      bucket: bucketName,
      managedFolder: managedFolderName,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOnBucket = (bucketName: string) =>
  storage.listManagedFolders.items({ bucket: bucketName, pageSize: 1000 }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as storage.ManagedFolder[]),
    ),
  );

const waitUntilGone = (bucketName: string, managedFolderName: string) =>
  getByName(bucketName, managedFolderName).pipe(
    Effect.map((existing) =>
      existing === undefined ? ("gone" as const) : ("found" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 30,
    }),
    Effect.flatMap((status): Effect.Effect<void, DeleteNotConfirmed> =>
      status === "gone"
        ? Effect.void
        : Effect.fail(
            new DeleteNotConfirmed({
              resource: `${bucketName}/managedFolders/${managedFolderName}`,
            }),
          ),
    ),
  );

export const ManagedProvider = () =>
  Provider.succeed(Managed, {
    stables: [
      "bucketName",
      "managedFolderName",
      "id",
      "selfLink",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousBucket = olds?.bucketName ?? output?.bucketName;
      if (previousBucket !== undefined && news.bucketName !== previousBucket) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousName = olds?.managedFolderName ?? output?.managedFolderName;
      if (
        news.managedFolderName !== undefined &&
        previousName !== undefined &&
        withTrailingSlash(news.managedFolderName) !==
          withTrailingSlash(previousName)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const bucketName = olds?.bucketName ?? output?.bucketName;
      if (!bucketName) return undefined;
      const managedFolderName = yield* toFolderName(
        id,
        olds?.managedFolderName,
        output?.managedFolderName,
      );
      const existing = yield* getByName(bucketName, managedFolderName);
      if (existing === undefined) return undefined;
      return toAttrs(existing, bucketName);
    }),

    list: () =>
      Effect.gen(function* () {
        const buckets = yield* listAlchemyBuckets();
        const pages = yield* Effect.forEach(
          buckets,
          (bucket) => {
            const bucketName = bucket.name;
            if (
              !bucketName ||
              bucket.iamConfiguration?.uniformBucketLevelAccess?.enabled !==
                true
            ) {
              return Effect.succeed([] as Array<Managed["Attributes"]>);
            }
            return listOnBucket(bucketName).pipe(
              Effect.map((items) =>
                items.map((item) => toAttrs(item, bucketName)),
              ),
            );
          },
          { concurrency: 8 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const bucketName = news.bucketName;
      const managedFolderName = yield* toFolderName(
        id,
        news.managedFolderName,
        output?.managedFolderName,
      );

      let current = yield* getByName(bucketName, managedFolderName);

      if (current === undefined) {
        const created = yield* storage
          .insertManagedFolders({
            bucket: bucketName,
            body: { name: managedFolderName },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getByName(bucketName, managedFolderName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined || !(current.name ?? current.id)) {
        return yield* new ManagedNotResolved({
          bucketName,
          managedFolderName,
        });
      }

      return toAttrs(current, bucketName);
    }),

    delete: Effect.fn(function* ({ output }) {
      const bucketName = output.bucketName;
      const managedFolderName = output.managedFolderName;
      if (!bucketName || !managedFolderName) return;
      yield* storage
        .deleteManagedFolders({
          bucket: bucketName,
          managedFolder: managedFolderName,
          allowNonEmpty: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(bucketName, managedFolderName);
    }),
  });
