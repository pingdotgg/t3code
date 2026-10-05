import * as logging from "@distilled.cloud/gcp/logging_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  listProjectBuckets,
  waitForDeleteOperation,
  waitForOperation,
} from "./operations.ts";
import {
  encodeDescription,
  hasOwnershipMarker,
  lastSegment,
  parseDescription,
} from "./ownership.ts";

const MAX_NAME_LENGTH = 100;
const DEFAULT_LOCATION = "global";

export type BucketsLinkProps = {
  /**
   * Parent analytics-enabled log bucket. Full name
   * `projects/{project}/locations/{location}/buckets/{bucket}` or the
   * bucket id (combined with `location`). A bucket may have at most one
   * link. Immutable — changing it replaces the link (delete-first).
   */
  bucket: string;
  /**
   * Link id (the `{link}` segment of
   * `.../buckets/{bucket}/links/{link}`). Also used as the BigQuery
   * dataset id, so it may contain only letters, digits, and underscores
   * and must start with a letter. If omitted, a unique name is generated.
   * Immutable — changing it replaces the link.
   */
  linkId?: string;
  /**
   * Bucket location used when `bucket` is a bare id. Immutable — changing
   * it replaces the link.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable description (max 8000 characters). Links have no
   * labels field and no update API, so Alchemy stamps ownership into the
   * description at create and cannot change it in place.
   */
  description?: string;
};

export type BucketsLink = Resource<
  "GCP.Logging.BucketsLink",
  BucketsLinkProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/buckets/{bucket}/links/{linkId}`. */
    name: string;
    /** Link id (last path segment). */
    linkId: string;
    /** Parent log bucket resource name. */
    bucket: string;
    /** Bucket id. */
    bucketId: string;
    /** Project id. */
    project: string;
    /** Location of the parent bucket. */
    location: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** BigQuery dataset id created for this link. */
    datasetId: string | undefined;
    /** Link lifecycle (`ACTIVE`, `DELETE_REQUESTED`, …). */
    lifecycleState: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Logging link that creates a BigQuery dataset over an
 * analytics-enabled log bucket.
 *
 * A bucket may have only one link. Create and delete are long-running
 * operations; the matching BigQuery dataset is created and deleted with
 * the link. Links have no update API and no labels field — Alchemy
 * stamps ownership into the description at create. `linkId` and the
 * parent bucket are identity; replacement is delete-first because a
 * bucket cannot hold two links.
 *
 * ### Creating a Link
 * **Example:** Link an analytics bucket to BigQuery
 * ```typescript
 * const bucket = yield* GCP.Logging.LogBucket("AppLogs", {
 *   analyticsEnabled: true,
 *   description: "analytics logs",
 * });
 * const link = yield* GCP.Logging.BucketsLink("Analytics", {
 *   bucket: bucket.name,
 *   description: "bigquery analytics",
 * });
 * ```
 *
 * **Example:** Named link
 * ```typescript
 * const link = yield* GCP.Logging.BucketsLink("Analytics", {
 *   bucket: bucket.name,
 *   linkId: "app_logs",
 *   description: "bigquery analytics",
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const BucketsLink = Resource<BucketsLink>("GCP.Logging.BucketsLink");

export class BucketsLinkNotResolved extends Data.TaggedError(
  "GCP.Logging.BucketsLinkNotResolved",
)<{
  name: string;
}> {}

export class BucketsLinkFailed extends Data.TaggedError(
  "GCP.Logging.BucketsLinkFailed",
)<{
  name: string;
  state: string | undefined;
}> {}

export class BucketsLinkStillExists extends Data.TaggedError(
  "GCP.Logging.BucketsLinkStillExists",
)<{
  name: string;
}> {}

const parseLinkName = (name: string) => {
  const match = name.match(
    /^projects\/([^/]+)\/locations\/([^/]+)\/buckets\/([^/]+)\/links\/([^/]+)$/,
  );
  if (!match) return undefined;
  return {
    project: match[1]!,
    location: match[2]!,
    bucketId: match[3]!,
    linkId: match[4]!,
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
  linkId: string,
) =>
  `projects/${project}/locations/${location}/buckets/${bucketId}/links/${linkId}`;

const linkIdOf = (link: logging.Link, fallback?: string) => {
  const parsed = parseLinkName(link.name ?? "");
  return parsed?.linkId ?? fallback ?? lastSegment(link.name ?? "");
};

const toId = (id: string, linkId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (linkId !== undefined) return linkId;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
      delimiter: "_",
    });
    const cleaned = generated.replace(/-/g, "_").replace(/[^a-z0-9_]/g, "_");
    return /^[a-z]/.test(cleaned)
      ? cleaned
      : `l${cleaned}`.slice(0, MAX_NAME_LENGTH);
  });

const isDeleted = (link: logging.Link | undefined): link is undefined =>
  link === undefined || link.lifecycleState === "DELETE_REQUESTED";

const isPending = (state: string | undefined) =>
  state === "CREATING" || state === "UPDATING";

const toAttrs = (
  link: logging.Link,
  project: string,
  location: string,
  bucketId: string,
) => {
  const linkId = linkIdOf(link);
  const parsed = parseDescription(link.description);
  const parsedName = parseLinkName(link.name ?? "");
  const resolvedLocation = parsedName?.location ?? location;
  const resolvedBucketId = parsedName?.bucketId ?? bucketId;
  const resolvedProject = parsedName?.project ?? project;
  return {
    name:
      link.name ??
      (linkId
        ? resourceName(
            resolvedProject,
            resolvedLocation,
            resolvedBucketId,
            linkId,
          )
        : ""),
    linkId,
    bucket: `projects/${resolvedProject}/locations/${resolvedLocation}/buckets/${resolvedBucketId}`,
    bucketId: resolvedBucketId,
    project: resolvedProject,
    location: resolvedLocation,
    description: parsed.description,
    datasetId: link.bigqueryDataset?.datasetId,
    lifecycleState: link.lifecycleState,
    createTime: link.createTime,
  };
};

const isValidLinkName = (name: string) =>
  /^projects\/[^/]+\/locations\/[^/]+\/buckets\/[^/]+\/links\/[^/]+$/.test(
    name,
  );

const getByName = (name: string) =>
  !isValidLinkName(name)
    ? Effect.succeed(undefined)
    : logging
        .getProjectsLocationsBucketsLinks({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilActive = (name: string) =>
  Effect.gen(function* () {
    const link = yield* getByName(name);
    if (isDeleted(link)) {
      return yield* new BucketsLinkNotResolved({ name });
    }
    if (link.lifecycleState === "FAILED") {
      return yield* new BucketsLinkFailed({
        name,
        state: link.lifecycleState,
      });
    }
    if (isPending(link.lifecycleState)) {
      return yield* new BucketsLinkNotResolved({ name });
    }
    return link;
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "GCP.Logging.BucketsLinkNotResolved",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
    Effect.catchTag("GCP.Logging.BucketsLinkNotResolved", () =>
      Effect.fail(
        new BucketsLinkFailed({
          name,
          state: "PENDING",
        }),
      ),
    ),
  );

const waitUntilDeleted = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((link) =>
      isDeleted(link)
        ? Effect.void
        : Effect.fail(new BucketsLinkStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Logging.BucketsLinkStillExists",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
    Effect.catchTag("GCP.Logging.BucketsLinkStillExists", () => Effect.void),
  );

export const BucketsLinkProvider = () =>
  Provider.succeed(BucketsLink, {
    nuke: {
      dependsOn: ["GCP.Logging.LogBucket"],
    },
    stables: [
      "name",
      "linkId",
      "bucket",
      "bucketId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.linkId ?? output?.linkId;
      const idChanged =
        previousId !== undefined &&
        news.linkId !== undefined &&
        news.linkId !== previousId;
      const previousBucket = olds?.bucket ?? output?.bucket;
      const bucketChanged =
        previousBucket !== undefined &&
        news.bucket.includes("/buckets/") &&
        news.bucket !== previousBucket;
      if (!idChanged && !bucketChanged) return undefined;
      return { action: "replace" as const, deleteFirst: true };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = olds?.location ?? output?.location ?? DEFAULT_LOCATION;
      const parent = parseBucket(
        olds?.bucket ?? output?.bucket ?? "",
        env.project,
        location,
      );
      const linkId = yield* toId(id, olds?.linkId, output?.linkId);
      const name =
        output?.name ??
        resourceName(parent.project, parent.location, parent.bucketId, linkId);
      const existing = yield* getByName(name);
      if (isDeleted(existing)) return undefined;
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
            logging.listProjectsLocationsBucketsLinks
              .pages({
                parent: bucket.name!,
                pageSize: 1000,
              })
              .pipe(
                Stream.flatMap((page) => Stream.fromIterable(page.links ?? [])),
                Stream.filter(
                  (link) =>
                    !isDeleted(link) && hasOwnershipMarker(link.description),
                ),
                Stream.map((link) => {
                  const parsed = parseLinkName(link.name ?? "");
                  return toAttrs(
                    link,
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
      if (parent.bucketId.length === 0) {
        return yield* new BucketsLinkNotResolved({
          name: parent.name,
        });
      }
      const linkId = yield* toId(id, news.linkId, output?.linkId);
      const name = resourceName(
        parent.project,
        parent.location,
        parent.bucketId,
        linkId,
      );
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (
        current !== undefined &&
        current.lifecycleState === "DELETE_REQUESTED"
      ) {
        yield* waitUntilDeleted(current.name ?? name);
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* logging
          .createProjectsLocationsBucketsLinks({
            parent: parent.name,
            linkId,
            body: { description: desiredDescription },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilActive(name);
      }

      if (isDeleted(current)) {
        return yield* new BucketsLinkNotResolved({ name });
      }

      return toAttrs(current, parent.project, parent.location, parent.bucketId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.lifecycleState === "DELETE_REQUESTED") return;
      const names = isValidLinkName(output.name)
        ? [output.name]
        : output.linkId
          ? yield* listProjectBuckets().pipe(
              Effect.map((buckets) =>
                buckets.flatMap((bucket) =>
                  bucket.name ? [`${bucket.name}/links/${output.linkId}`] : [],
                ),
              ),
            )
          : [];
      yield* Effect.forEach(
        names,
        (name) =>
          logging.deleteProjectsLocationsBucketsLinks({ name }).pipe(
            Effect.flatMap((operation) => waitForDeleteOperation(operation)),
            Effect.catchTag(["NotFound", "BadRequest"], () => Effect.void),
            Effect.flatMap(() => waitUntilDeleted(name)),
          ),
        { concurrency: 4 },
      );
    }),
  });
