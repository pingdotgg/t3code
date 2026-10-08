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

export type FolderProps = {
  /**
   * Name of the hierarchical-namespace bucket that contains this folder.
   * Immutable — changing it replaces the folder.
   */
  bucketName: string;
  /**
   * Folder path. A trailing slash is added if omitted. If omitted
   * entirely, a unique name is generated from the stack, stage, and
   * logical id. Immutable — changing it replaces the folder.
   */
  folderName?: string;
};

export type Folder = Resource<
  "GCP.Storage.Folder",
  FolderProps,
  {
    /** Parent bucket name. */
    bucketName: string;
    /** Folder path, including the trailing slash. */
    folderName: string;
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
 * A Cloud Storage folder in a hierarchical-namespace bucket.
 *
 * Folders exist only on buckets created with `hierarchicalNamespace:
 * true` (which also requires uniform bucket-level access). Identity is
 * `(bucket, folder name)`. Folders have no mutable fields and no labels,
 * so `list` / `pnpm nuke:gcp` discover them by enumerating
 * alchemy-labeled buckets.
 *
 * ### Creating a Folder
 * **Example:** Generated name
 * ```typescript
 * const bucket = yield* GCP.Storage.Bucket("tree", {
 *   hierarchicalNamespace: true,
 *   uniformBucketLevelAccess: true,
 *   forceDestroy: true,
 * });
 * const folder = yield* GCP.Storage.Folder("uploads", {
 *   bucketName: bucket.bucketName,
 * });
 * ```
 *
 * **Example:** Explicit path
 * ```typescript
 * const folder = yield* GCP.Storage.Folder("uploads", {
 *   bucketName: bucket.bucketName,
 *   folderName: "uploads/incoming/",
 * });
 * ```
 *
 * @resource
 * @category Storage
 */
export const Folder = Resource<Folder>("GCP.Storage.Folder");

export class FolderNotResolved extends Data.TaggedError(
  "GCP.Storage.FolderNotResolved",
)<{
  bucketName: string;
  folderName: string;
}> {}

const toAttrs = (folder: storage.Folder, bucketName: string) => ({
  bucketName: folder.bucket ?? bucketName,
  folderName: withTrailingSlash(folder.name ?? ""),
  id: folder.id,
  metageneration: folder.metageneration,
  createTime: folder.createTime,
  updateTime: folder.updateTime,
  selfLink: folder.selfLink,
});

const getByName = (bucketName: string, folderName: string) =>
  storage
    .getFolders({ bucket: bucketName, folder: folderName })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOnBucket = (bucketName: string) =>
  storage.listFolders.items({ bucket: bucketName, pageSize: 1000 }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => Effect.succeed([] as storage.Folder[])),
  );

const waitUntilGone = (bucketName: string, folderName: string) =>
  getByName(bucketName, folderName).pipe(
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
              resource: `${bucketName}/folders/${folderName}`,
            }),
          ),
    ),
  );

export const FolderProvider = () =>
  Provider.succeed(Folder, {
    stables: ["bucketName", "folderName", "id", "selfLink", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousBucket = olds?.bucketName ?? output?.bucketName;
      if (previousBucket !== undefined && news.bucketName !== previousBucket) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousName = olds?.folderName ?? output?.folderName;
      if (
        news.folderName !== undefined &&
        previousName !== undefined &&
        withTrailingSlash(news.folderName) !== withTrailingSlash(previousName)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const bucketName = olds?.bucketName ?? output?.bucketName;
      if (!bucketName) return undefined;
      const folderName = yield* toFolderName(
        id,
        olds?.folderName,
        output?.folderName,
      );
      const existing = yield* getByName(bucketName, folderName);
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
            if (!bucketName || bucket.hierarchicalNamespace?.enabled !== true) {
              return Effect.succeed([] as Array<Folder["Attributes"]>);
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
      const folderName = yield* toFolderName(
        id,
        news.folderName,
        output?.folderName,
      );

      let current = yield* getByName(bucketName, folderName);

      if (current === undefined) {
        const created = yield* storage
          .insertFolders({
            bucket: bucketName,
            recursive: true,
            body: { name: folderName },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getByName(bucketName, folderName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined || !(current.name ?? current.id)) {
        return yield* new FolderNotResolved({ bucketName, folderName });
      }

      return toAttrs(current, bucketName);
    }),

    delete: Effect.fn(function* ({ output }) {
      const bucketName = output.bucketName;
      const folderName = output.folderName;
      if (!bucketName || !folderName) return;
      yield* storage
        .deleteFolders({ bucket: bucketName, folder: folderName })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(bucketName, folderName);
    }),
  });
