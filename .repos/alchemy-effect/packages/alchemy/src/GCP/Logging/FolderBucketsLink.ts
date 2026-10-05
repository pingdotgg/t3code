import * as logging from "@distilled.cloud/gcp/logging_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createOwnership,
  encodeDescription,
  hasOwnershipMarker,
  lastSegment,
  ownedBy,
  parseDescription,
  parseLoggingName,
  toLinkId,
} from "./internal.ts";

export type FolderBucketsLinkProps = {
  /**
   * Full resource name of the parent analytics-enabled log bucket
   * (`{parent}/locations/{location}/buckets/{bucket}`). A bucket may
   * contain only one link. Immutable — changing it replaces the link
   * (delete first).
   */
  bucketName: string;
  /**
   * Link id (also the BigQuery dataset id). If omitted, a unique name is
   * generated. Up to 100 characters: letters, digits, and underscores.
   * Immutable — changing it replaces the link (delete first).
   */
  linkId?: string;
  /**
   * Human-readable description. Links have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes. Changing the description replaces the link.
   */
  description?: string;
};

export type FolderBucketsLink = Resource<
  "GCP.Logging.FolderBucketsLink",
  FolderBucketsLinkProps,
  {
    /** Full resource name `{bucket}/links/{linkId}`. */
    name: string;
    /** Link id (last path segment). */
    linkId: string;
    /** Parent bucket resource name. */
    bucketName: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** BigQuery dataset resource name, if created. */
    bigqueryDatasetId: string | undefined;
    /** Link lifecycle (`ACTIVE`, `CREATING`, …). */
    lifecycleState: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A BigQuery linked dataset for an analytics-enabled folder log bucket.
 *
 * Create is asynchronous and also provisions a BigQuery dataset whose id
 * matches `linkId`. A bucket may currently contain only one link. Links
 * have no labels field, so Alchemy stamps ownership into the description
 * for `list` / nuke. There is no update API — changing `linkId`,
 * `bucketName`, or `description` replaces the link (delete first).
 *
 * ### Creating a Folder Bucket Link
 * **Example:** Link an analytics bucket to BigQuery
 * ```typescript
 * const bucket = yield* GCP.Logging.FolderBucket("Analytics", {
 *   analyticsEnabled: true,
 * });
 * const link = yield* GCP.Logging.FolderBucketsLink("Bq", {
 *   bucketName: bucket.name,
 *   description: "log analytics dataset",
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const FolderBucketsLink = Resource<FolderBucketsLink>(
  "GCP.Logging.FolderBucketsLink",
);

export class FolderBucketsLinkNotResolved extends Data.TaggedError(
  "GCP.Logging.FolderBucketsLinkNotResolved",
)<{
  name: string;
}> {}

export class FolderBucketsLinkFailed extends Data.TaggedError(
  "GCP.Logging.FolderBucketsLinkFailed",
)<{
  name: string;
  state: string | undefined;
}> {}

const resourceName = (bucketName: string, linkId: string) =>
  `${bucketName}/links/${linkId}`;

const isDeleted = (link: logging.Link | undefined): link is undefined =>
  link === undefined || link.lifecycleState === "DELETE_REQUESTED";

const isPending = (state: string | undefined) =>
  state === "CREATING" || state === "UPDATING";

const toAttrs = (link: logging.Link, bucketName: string) => {
  const parsed = parseLoggingName(link.name ?? "");
  const linkId = parsed.linkId ?? lastSegment(link.name ?? "");
  const description = parseDescription(link.description);
  return {
    name: link.name ?? resourceName(bucketName, linkId),
    linkId,
    bucketName,
    description: description.description,
    bigqueryDatasetId: link.bigqueryDataset?.datasetId,
    lifecycleState: link.lifecycleState,
    createTime: link.createTime,
  };
};

const getByName = (name: string) =>
  logging
    .getFoldersLocationsBucketsLinks({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilActive = (name: string) =>
  Effect.gen(function* () {
    const link = yield* getByName(name);
    if (link === undefined || isDeleted(link)) {
      return yield* new FolderBucketsLinkNotResolved({ name });
    }
    if (link.lifecycleState === "FAILED") {
      return yield* new FolderBucketsLinkFailed({
        name,
        state: link.lifecycleState,
      });
    }
    if (isPending(link.lifecycleState)) {
      return yield* new FolderBucketsLinkNotResolved({ name });
    }
    return link;
  }).pipe(
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Logging.FolderBucketsLinkNotResolved",
      times: 10,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

export const FolderBucketsLinkProvider = () =>
  Provider.succeed(FolderBucketsLink, {
    nuke: {
      dependsOn: ["GCP.Logging.LogBucket"],
    },
    stables: ["name", "linkId", "bucketName", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.linkId ?? output?.linkId;
      const idChanged =
        previousId !== undefined &&
        news.linkId !== undefined &&
        news.linkId !== previousId;
      const previousBucket = olds?.bucketName ?? output?.bucketName;
      const bucketChanged =
        previousBucket !== undefined && news.bucketName !== previousBucket;
      const previousDescription = olds?.description ?? output?.description;
      const descriptionChanged =
        news.description !== undefined &&
        previousDescription !== undefined &&
        news.description !== previousDescription;
      if (!idChanged && !bucketChanged && !descriptionChanged) {
        return undefined;
      }
      return { action: "replace" as const, deleteFirst: true };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const linkId = yield* toLinkId(id, olds?.linkId, output?.linkId);
      const bucketName = olds?.bucketName ?? output?.bucketName;
      if (bucketName === undefined) return undefined;
      const name = output?.name ?? resourceName(bucketName, linkId);
      const existing = yield* getByName(name);
      if (isDeleted(existing)) return undefined;
      const attrs = toAttrs(existing, bucketName);
      const { labels } = parseDescription(existing.description);
      return (yield* ownedBy(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const buckets = yield* logging.listFoldersLocationsBuckets
          .pages({
            parent: `projects/${env.project}/locations/-`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.buckets ?? [])),
            Stream.filter((bucket) => bucket.analyticsEnabled === true),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
        const links: ReturnType<typeof toAttrs>[] = [];
        for (const bucket of buckets) {
          if (bucket.name === undefined) continue;
          const listed = yield* logging.listFoldersLocationsBucketsLinks
            .pages({
              parent: bucket.name,
              pageSize: 1000,
            })
            .pipe(
              Stream.flatMap((page) => Stream.fromIterable(page.links ?? [])),
              Stream.filter(
                (link) =>
                  !isDeleted(link) && hasOwnershipMarker(link.description),
              ),
              Stream.map((link) => toAttrs(link, bucket.name ?? "")),
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
              Effect.catchTag("NotFound", () =>
                Effect.succeed([] as ReturnType<typeof toAttrs>[]),
              ),
            );
          links.push(...listed);
        }
        return links;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const linkId = yield* toLinkId(id, news.linkId, output?.linkId);
      const name = resourceName(news.bucketName, linkId);
      const ownership = yield* createOwnership(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (
        current !== undefined &&
        current.lifecycleState === "DELETE_REQUESTED"
      ) {
        current = undefined;
      }

      if (current === undefined) {
        yield* logging
          .createFoldersLocationsBucketsLinks({
            parent: news.bucketName,
            linkId,
            body: { description: desiredDescription },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              Effect.succeed<logging.Operation>({ done: true }),
            ),
            Effect.asVoid,
          );
        current = yield* waitUntilActive(name);
      }

      if (isDeleted(current)) {
        return yield* new FolderBucketsLinkNotResolved({ name });
      }

      if (isPending(current.lifecycleState)) {
        current = yield* waitUntilActive(current.name ?? name);
      }

      return toAttrs(current, news.bucketName);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.lifecycleState === "DELETE_REQUESTED") return;
      yield* logging
        .deleteFoldersLocationsBucketsLinks({ name: output.name })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.asVoid,
        );
      yield* getByName(output.name).pipe(
        Effect.flatMap((link) =>
          isDeleted(link)
            ? Effect.void
            : Effect.fail(
                new FolderBucketsLinkNotResolved({ name: output.name }),
              ),
        ),
        Effect.retry({
          while: (error) =>
            error._tag === "GCP.Logging.FolderBucketsLinkNotResolved",
          times: 10,
          schedule: Schedule.spaced("3 seconds"),
        }),
      );
    }),
  });
