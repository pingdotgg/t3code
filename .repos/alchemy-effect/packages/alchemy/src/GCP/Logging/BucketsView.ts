import * as logging from "@distilled.cloud/gcp/logging_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { listProjectBuckets } from "./operations.ts";
import {
  encodeDescription,
  hasOwnershipMarker,
  lastSegment,
  parseDescription,
} from "./ownership.ts";

const MAX_NAME_LENGTH = 100;
const DEFAULT_LOCATION = "global";

export type BucketsViewProps = {
  /**
   * Parent log bucket. Full name
   * `projects/{project}/locations/{location}/buckets/{bucket}` or the
   * bucket id (combined with `location`). Immutable — changing it
   * replaces the view.
   */
  bucket: string;
  /**
   * View id (the `{view}` segment of
   * `.../buckets/{bucket}/views/{view}`). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Limited to 100
   * characters: letters, digits, underscores, hyphens. Immutable —
   * changing it replaces the view.
   */
  viewId?: string;
  /**
   * Bucket location used when `bucket` is a bare id. Immutable — changing
   * it replaces the view.
   * @default "global"
   */
  location?: string;
  /**
   * Filter restricting which log entries in the bucket are visible.
   * Must be a conjunction of `SOURCE()`, `resource.type`, and
   * `LOG_ID()` (and their `NOT` negations). Empty shows every entry.
   */
  filter?: string;
  /**
   * Human-readable description. Log views have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
};

export type BucketsView = Resource<
  "GCP.Logging.BucketsView",
  BucketsViewProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/buckets/{bucket}/views/{viewId}`. */
    name: string;
    /** View id (last path segment). */
    viewId: string;
    /** Parent log bucket resource name. */
    bucket: string;
    /** Bucket id. */
    bucketId: string;
    /** Project id. */
    project: string;
    /** Location of the parent bucket. */
    location: string;
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
 * A Cloud Logging view over log entries in a log bucket.
 *
 * A bucket may contain at most 30 views. Log views have no labels field,
 * so Alchemy stamps ownership into the description for `list` / nuke.
 * `viewId` and the parent bucket are identity — changing either replaces
 * the view. Filter and description update in place.
 *
 * ### Creating a View
 * **Example:** Generated name over a custom bucket
 * ```typescript
 * const bucket = yield* GCP.Logging.LogBucket("AppLogs", {
 *   description: "application logs",
 * });
 * const view = yield* GCP.Logging.BucketsView("Stdout", {
 *   bucket: bucket.name,
 *   filter: 'LOG_ID("stdout")',
 *   description: "stdout only",
 * });
 * ```
 *
 * **Example:** Named view
 * ```typescript
 * const view = yield* GCP.Logging.BucketsView("Stdout", {
 *   bucket: bucket.name,
 *   viewId: "stdout",
 *   filter: 'LOG_ID("stdout")',
 * });
 * ```
 *
 * ### Updating a View
 * **Example:** Change the filter
 * ```typescript
 * const view = yield* GCP.Logging.BucketsView("Stdout", {
 *   bucket: bucket.name,
 *   filter: 'LOG_ID("stderr")',
 *   description: "stderr only",
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const BucketsView = Resource<BucketsView>("GCP.Logging.BucketsView");

export class BucketsViewNotResolved extends Data.TaggedError(
  "GCP.Logging.BucketsViewNotResolved",
)<{
  name: string;
}> {}

const parseViewName = (name: string) => {
  const match = name.match(
    /^projects\/([^/]+)\/locations\/([^/]+)\/buckets\/([^/]+)\/views\/([^/]+)$/,
  );
  if (!match) return undefined;
  return {
    project: match[1]!,
    location: match[2]!,
    bucketId: match[3]!,
    viewId: match[4]!,
  };
};

const parseBucket = (bucket: string, project: string, location: string) => {
  const match = bucket.match(
    /^(projects\/([^/]+)\/locations\/([^/]+)\/buckets\/([^/]+))$/,
  );
  if (match) {
    return {
      name: match[1]!,
      project: match[2]!,
      location: match[3]!,
      bucketId: match[4]!,
    };
  }
  return {
    name: `projects/${project}/locations/${location}/buckets/${bucket}`,
    project,
    location,
    bucketId: lastSegment(bucket),
  };
};

const resourceName = (
  project: string,
  location: string,
  bucketId: string,
  viewId: string,
) =>
  `projects/${project}/locations/${location}/buckets/${bucketId}/views/${viewId}`;

const viewIdOf = (view: logging.LogView, fallback?: string) => {
  const parsed = parseViewName(view.name ?? "");
  return parsed?.viewId ?? fallback ?? lastSegment(view.name ?? "");
};

const toId = (id: string, viewId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (viewId !== undefined) return viewId;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    return /^[a-z0-9]/.test(generated)
      ? generated
      : `v${generated}`.slice(0, MAX_NAME_LENGTH);
  });

const toAttrs = (
  view: logging.LogView,
  project: string,
  location: string,
  bucketId: string,
) => {
  const viewId = viewIdOf(view);
  const parsed = parseDescription(view.description);
  const parsedName = parseViewName(view.name ?? "");
  const resolvedLocation = parsedName?.location ?? location;
  const resolvedBucketId = parsedName?.bucketId ?? bucketId;
  const resolvedProject = parsedName?.project ?? project;
  return {
    name:
      view.name ??
      (viewId
        ? resourceName(
            resolvedProject,
            resolvedLocation,
            resolvedBucketId,
            viewId,
          )
        : ""),
    viewId,
    bucket: `projects/${resolvedProject}/locations/${resolvedLocation}/buckets/${resolvedBucketId}`,
    bucketId: resolvedBucketId,
    project: resolvedProject,
    location: resolvedLocation,
    filter: view.filter,
    description: parsed.description,
    createTime: view.createTime,
    updateTime: view.updateTime,
  };
};

const getByName = (name: string) =>
  logging
    .getProjectsLocationsBucketsViews({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const BucketsViewProvider = () =>
  Provider.succeed(BucketsView, {
    stables: ["name", "viewId", "bucket", "bucketId", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.viewId ?? output?.viewId;
      const idChanged =
        previousId !== undefined &&
        news.viewId !== undefined &&
        news.viewId !== previousId;
      const previousBucket = olds?.bucket ?? output?.bucket;
      const bucketChanged =
        previousBucket !== undefined &&
        news.bucket.includes("/buckets/") &&
        news.bucket !== previousBucket;
      if (!idChanged && !bucketChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = olds?.location ?? output?.location ?? DEFAULT_LOCATION;
      const parent = parseBucket(
        olds?.bucket ?? output?.bucket ?? "",
        env.project,
        location,
      );
      const viewId = yield* toId(id, olds?.viewId, output?.viewId);
      const name =
        output?.name ??
        resourceName(parent.project, parent.location, parent.bucketId, viewId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(
        existing,
        parent.project,
        parent.location,
        parent.bucketId,
      );
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const buckets = yield* listProjectBuckets();
        const pages = yield* Effect.forEach(
          buckets,
          (bucket) =>
            logging.listProjectsLocationsBucketsViews
              .pages({
                parent: bucket.name!,
                pageSize: 1000,
              })
              .pipe(
                Stream.flatMap((page) => Stream.fromIterable(page.views ?? [])),
                Stream.filter((view) => hasOwnershipMarker(view.description)),
                Stream.map((view) => {
                  const parsed = parseViewName(view.name ?? "");
                  return toAttrs(
                    view,
                    parsed?.project ?? env.project,
                    parsed?.location ?? DEFAULT_LOCATION,
                    parsed?.bucketId ?? lastSegment(bucket.name ?? ""),
                  );
                }),
                Stream.runCollect,
                Effect.map((chunk) => Array.from(chunk)),
                Effect.catchTag("NotFound", () =>
                  Effect.succeed([] as ReturnType<typeof toAttrs>[]),
                ),
              ),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = news.location ?? output?.location ?? DEFAULT_LOCATION;
      const parent = parseBucket(news.bucket, env.project, location);
      const viewId = yield* toId(id, news.viewId, output?.viewId);
      const name = resourceName(
        parent.project,
        parent.location,
        parent.bucketId,
        viewId,
      );
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* logging
          .createProjectsLocationsBucketsViews({
            parent: parent.name,
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
        return yield* new BucketsViewNotResolved({ name });
      }

      const filterChanged = (current.filter ?? "") !== (news.filter ?? "");
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const updateMask = [
        filterChanged ? "filter" : undefined,
        descriptionChanged ? "description" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* logging.patchProjectsLocationsBucketsViews({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body: {
            filter: news.filter ?? "",
            description: desiredDescription,
          },
        });
      }

      return toAttrs(current, parent.project, parent.location, parent.bucketId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* logging
        .deleteProjectsLocationsBucketsViews({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
