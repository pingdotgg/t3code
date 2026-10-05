import * as logging from "@distilled.cloud/gcp/logging_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
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
  toPhysicalId,
} from "./internal.ts";

export type LocationsBucketsViewProps = {
  /**
   * Full resource name of the parent log bucket
   * (`{parent}/locations/{location}/buckets/{bucket}`). Immutable —
   * changing it replaces the view.
   */
  bucketName: string;
  /**
   * View id (the `{view}` segment of `{bucket}/views/{view}`). If omitted,
   * a unique name is generated from the stack, stage, and logical id.
   * Limited to 100 characters: letters, digits, underscores, hyphens.
   * Immutable — changing it replaces the view.
   */
  viewId?: string;
  /**
   * Filter that restricts which log entries in the bucket are visible.
   * Must be a logical conjunction of `SOURCE()`, `resource.type`, and
   * `LOG_ID()`, optionally negated with `NOT`.
   */
  filter?: string;
  /**
   * Human-readable description. Log views have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
};

export type LocationsBucketsView = Resource<
  "GCP.Logging.LocationsBucketsView",
  LocationsBucketsViewProps,
  {
    /** Full resource name `{bucket}/views/{viewId}`. */
    name: string;
    /** View id (last path segment). */
    viewId: string;
    /** Parent bucket resource name. */
    bucketName: string;
    /** View filter, if set. */
    filter: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Logging view over log entries in a log bucket, managed through
 * the generic locations APIs.
 *
 * A bucket may contain at most 30 views. Views have no labels field, so
 * Alchemy stamps ownership into the description for `list` / nuke.
 * `viewId` and `bucketName` are identity — changing either replaces the
 * view.
 *
 * ### Creating a Locations Bucket View
 * **Example:** View over stdout
 * ```typescript
 * const bucket = yield* GCP.Logging.LocationsBucket("AppLogs", {
 *   description: "application logs",
 * });
 * const view = yield* GCP.Logging.LocationsBucketsView("Stdout", {
 *   bucketName: bucket.name,
 *   filter: 'LOG_ID("stdout")',
 *   description: "stdout only",
 * });
 * ```
 *
 * **Example:** Named view
 * ```typescript
 * const view = yield* GCP.Logging.LocationsBucketsView("Stdout", {
 *   bucketName: bucket.name,
 *   viewId: "stdout",
 *   filter: 'LOG_ID("stdout")',
 * });
 * ```
 *
 * ### Updating a Locations Bucket View
 * **Example:** Change the filter
 * ```typescript
 * const view = yield* GCP.Logging.LocationsBucketsView("Stdout", {
 *   bucketName: bucket.name,
 *   filter: 'LOG_ID("stderr")',
 *   description: "stderr only",
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const LocationsBucketsView = Resource<LocationsBucketsView>(
  "GCP.Logging.LocationsBucketsView",
);

export class LocationsBucketsViewNotResolved extends Data.TaggedError(
  "GCP.Logging.LocationsBucketsViewNotResolved",
)<{
  name: string;
}> {}

const resourceName = (bucketName: string, viewId: string) =>
  `${bucketName}/views/${viewId}`;

const toAttrs = (view: logging.LogView, bucketName: string) => {
  const parsed = parseLoggingName(view.name ?? "");
  const viewId = parsed.viewId ?? lastSegment(view.name ?? "");
  const description = parseDescription(view.description);
  return {
    name: view.name ?? resourceName(bucketName, viewId),
    viewId,
    bucketName,
    filter: view.filter,
    description: description.description,
    createTime: view.createTime,
    updateTime: view.updateTime,
  };
};

const getByName = (name: string) =>
  logging
    .getLocationsBucketsViews({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const LocationsBucketsViewProvider = () =>
  Provider.succeed(LocationsBucketsView, {
    stables: ["name", "viewId", "bucketName", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.viewId ?? output?.viewId;
      const idChanged =
        previousId !== undefined &&
        news.viewId !== undefined &&
        news.viewId !== previousId;
      const previousBucket = olds?.bucketName ?? output?.bucketName;
      const bucketChanged =
        previousBucket !== undefined && news.bucketName !== previousBucket;
      if (!idChanged && !bucketChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const viewId = yield* toPhysicalId(id, olds?.viewId, output?.viewId, "v");
      const bucketName = olds?.bucketName ?? output?.bucketName;
      if (bucketName === undefined) return undefined;
      const name = output?.name ?? resourceName(bucketName, viewId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, bucketName);
      const { labels } = parseDescription(existing.description);
      return (yield* ownedBy(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const buckets = yield* logging.listLocationsBuckets
          .pages({
            parent: `projects/${env.project}/locations/-`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.buckets ?? [])),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
        const views: ReturnType<typeof toAttrs>[] = [];
        for (const bucket of buckets) {
          if (bucket.name === undefined) continue;
          const listed = yield* logging.listLocationsBucketsViews
            .pages({
              parent: bucket.name,
              pageSize: 1000,
            })
            .pipe(
              Stream.flatMap((page) => Stream.fromIterable(page.views ?? [])),
              Stream.filter((view) => hasOwnershipMarker(view.description)),
              Stream.map((view) => toAttrs(view, bucket.name ?? "")),
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
              Effect.catchTag("NotFound", () =>
                Effect.succeed([] as ReturnType<typeof toAttrs>[]),
              ),
            );
          views.push(...listed);
        }
        return views;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const viewId = yield* toPhysicalId(id, news.viewId, output?.viewId, "v");
      const name = resourceName(news.bucketName, viewId);
      const ownership = yield* createOwnership(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* logging
          .createLocationsBucketsViews({
            parent: news.bucketName,
            viewId,
            body: {
              filter: news.filter,
              description: desiredDescription,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new LocationsBucketsViewNotResolved({ name });
      }

      const filterChanged = (current.filter ?? "") !== (news.filter ?? "");
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const updateMask = [
        filterChanged ? "filter" : undefined,
        descriptionChanged ? "description" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* logging.patchLocationsBucketsViews({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body: {
            filter: news.filter ?? "",
            description: desiredDescription,
          },
        });
      }

      return toAttrs(current, news.bucketName);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* logging
        .deleteLocationsBucketsViews({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
