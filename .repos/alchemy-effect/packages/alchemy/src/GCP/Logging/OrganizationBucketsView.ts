import * as logging from "@distilled.cloud/gcp/logging_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_BUCKET_ID,
  DEFAULT_LOCATION,
  encodeDescription,
  hasOwnershipMarker,
  lastSegment,
  organizationIdOf,
  parseDescription,
  resolveOrganization,
  toPhysicalId,
  tryResolveOrganization,
} from "./internal.ts";

export type OrganizationBucketsViewProps = {
  /**
   * View id (the last segment of the view resource name). If omitted, a
   * unique name is generated from the stack, stage, and logical id.
   * Limited to 100 characters: letters, digits, underscores, hyphens;
   * first character must be alphanumeric. Immutable — changing it
   * replaces the view.
   */
  viewId?: string;
  /**
   * Parent organization (`organizations/{organization}` or the numeric
   * id). Defaults to the project ancestor organization. Immutable —
   * changing it replaces the view.
   */
  organization?: string;
  /**
   * Parent log bucket resource name
   * (`organizations/{organization}/locations/{location}/buckets/{bucket}`).
   * If omitted, Alchemy uses the organization `_Default` bucket.
   * Immutable — changing it replaces the view.
   */
  bucket?: string;
  /**
   * Bucket id when `bucket` is omitted.
   * @default "_Default"
   */
  bucketId?: string;
  /**
   * Location of the parent bucket when `bucket` is omitted.
   * @default "global"
   */
  location?: string;
  /**
   * Filter restricting which log entries in the bucket are visible.
   * Must be a conjunction of `SOURCE()`, `resource.type`, and `LOG_ID()`.
   */
  filter?: string;
  /**
   * Human-readable description. Log views have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
};

export type OrganizationBucketsView = Resource<
  "GCP.Logging.OrganizationBucketsView",
  OrganizationBucketsViewProps,
  {
    /** Full resource name `organizations/{organization}/locations/{location}/buckets/{bucket}/views/{view}`. */
    name: string;
    /** View id (last path segment). */
    viewId: string;
    /** Parent bucket resource name. */
    bucket: string;
    /** Bucket id. */
    bucketId: string;
    /** Organization resource name. */
    organization: string;
    /** Organization id. */
    organizationId: string;
    /** Project id of the deploying stack. */
    project: string;
    /** Location of the parent bucket. */
    location: string;
    /** View filter. */
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
 * A Cloud Logging view over log entries in an organization log bucket.
 *
 * Views have no labels field, so Alchemy stamps ownership into the
 * description for `list` / nuke. `viewId`, organization, and the parent
 * bucket are identity — changing any replaces the view.
 *
 * ### Creating an Organization View
 * **Example:** View on the organization `_Default` bucket
 * ```typescript
 * const view = yield* GCP.Logging.OrganizationBucketsView("Errors", {
 *   filter: 'resource.type = "gce_instance"',
 *   description: "compute instance logs",
 * });
 * ```
 *
 * **Example:** Named view on a custom organization bucket
 * ```typescript
 * const view = yield* GCP.Logging.OrganizationBucketsView("Errors", {
 *   viewId: "app-errors",
 *   bucket: bucket.name,
 *   filter: 'resource.type = "gce_instance"',
 * });
 * ```
 *
 * ### Updating an Organization View
 * **Example:** Change the filter
 * ```typescript
 * const view = yield* GCP.Logging.OrganizationBucketsView("Errors", {
 *   bucket: bucket.name,
 *   filter: 'resource.type = "gce_instance" AND LOG_ID("syslog")',
 *   description: "syslog from compute",
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const OrganizationBucketsView = Resource<OrganizationBucketsView>(
  "GCP.Logging.OrganizationBucketsView",
);

export class OrganizationBucketsViewNotResolved extends Data.TaggedError(
  "GCP.Logging.OrganizationBucketsViewNotResolved",
)<{
  name: string;
}> {}

const parseViewName = (name: string) => {
  const match = name.match(
    /^(organizations\/[^/]+)\/locations\/([^/]+)\/buckets\/([^/]+)\/views\/([^/]+)$/,
  );
  if (!match) return undefined;
  return {
    organization: match[1]!,
    location: match[2]!,
    bucketId: match[3]!,
    viewId: match[4]!,
  };
};

const parseBucketName = (name: string) => {
  const match = name.match(
    /^(organizations\/[^/]+)\/locations\/([^/]+)\/buckets\/([^/]+)$/,
  );
  if (!match) return undefined;
  return {
    organization: match[1]!,
    location: match[2]!,
    bucketId: match[3]!,
  };
};

const parentBucket = (
  organization: string,
  location: string,
  bucketId: string,
  bucket?: string,
) => bucket ?? `${organization}/locations/${location}/buckets/${bucketId}`;

const resourceName = (bucket: string, viewId: string) =>
  `${bucket}/views/${viewId}`;

const toAttrs = (
  view: logging.LogView,
  fallbackBucket: string,
  project: string,
) => {
  const name = view.name ?? "";
  const parsed = parseViewName(name);
  const bucket =
    parsed !== undefined
      ? `${parsed.organization}/locations/${parsed.location}/buckets/${parsed.bucketId}`
      : fallbackBucket;
  const bucketParsed = parseBucketName(bucket);
  const description = parseDescription(view.description);
  const organization = parsed?.organization ?? bucketParsed?.organization ?? "";
  return {
    name: name || resourceName(bucket, parsed?.viewId ?? lastSegment(name)),
    viewId: parsed?.viewId ?? lastSegment(name),
    bucket,
    bucketId: parsed?.bucketId ?? bucketParsed?.bucketId ?? "",
    organization,
    organizationId: organizationIdOf(organization),
    project,
    location: parsed?.location ?? bucketParsed?.location ?? DEFAULT_LOCATION,
    filter: view.filter,
    description: description.description,
    createTime: view.createTime,
    updateTime: view.updateTime,
  };
};

const getByName = (name: string) =>
  logging
    .getOrganizationsLocationsBucketsViews({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const resolveParent = (
  organization: string,
  news: Pick<OrganizationBucketsViewProps, "bucket" | "bucketId" | "location">,
  output?: { bucket?: string; bucketId?: string; location?: string },
) => {
  const location = news.location ?? output?.location ?? DEFAULT_LOCATION;
  const bucketId = news.bucketId ?? output?.bucketId ?? DEFAULT_BUCKET_ID;
  return parentBucket(
    organization,
    location,
    bucketId,
    news.bucket ?? output?.bucket,
  );
};

export const OrganizationBucketsViewProvider = () =>
  Provider.succeed(OrganizationBucketsView, {
    stables: [
      "name",
      "viewId",
      "bucket",
      "bucketId",
      "organization",
      "organizationId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.viewId ?? output?.viewId;
      const idChanged =
        previousId !== undefined &&
        news.viewId !== undefined &&
        news.viewId !== previousId;
      const previousBucket = olds?.bucket ?? output?.bucket;
      const bucketChanged =
        news.bucket !== undefined &&
        previousBucket !== undefined &&
        news.bucket !== previousBucket;
      const previousLocation = olds?.location ?? output?.location;
      const locationChanged =
        previousLocation !== undefined &&
        news.location !== undefined &&
        news.location !== previousLocation;
      const previousBucketId = olds?.bucketId ?? output?.bucketId;
      const bucketIdChanged =
        previousBucketId !== undefined &&
        news.bucketId !== undefined &&
        news.bucketId !== previousBucketId;
      const previousOrg = olds?.organization ?? output?.organization;
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        news.organization !== previousOrg;
      if (
        !idChanged &&
        !bucketChanged &&
        !locationChanged &&
        !bucketIdChanged &&
        !orgChanged
      ) {
        return undefined;
      }
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        olds?.organization ?? output?.organization,
        output?.organization,
      );
      const viewId = yield* toPhysicalId(id, olds?.viewId, output?.viewId, "v");
      const bucket = resolveParent(organization, olds ?? {}, output);
      const name = output?.name ?? resourceName(bucket, viewId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, bucket, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const organization = yield* tryResolveOrganization();
        if (organization === undefined) return [];
        return yield* logging.listOrganizationsLocationsBuckets
          .pages({
            parent: `${organization}/locations/-`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.buckets ?? [])),
            Stream.flatMap(
              (bucket) =>
                bucket.name
                  ? logging.listOrganizationsLocationsBucketsViews
                      .pages({
                        parent: bucket.name,
                        pageSize: 1000,
                      })
                      .pipe(
                        Stream.flatMap((page) =>
                          Stream.fromIterable(page.views ?? []),
                        ),
                        Stream.filter((view) =>
                          hasOwnershipMarker(view.description),
                        ),
                        Stream.map((view) =>
                          toAttrs(view, bucket.name ?? "", env.project),
                        ),
                        Stream.catchTag("NotFound", () => Stream.empty),
                      )
                  : Stream.empty,
              { concurrency: 4 },
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        news.organization,
        output?.organization,
      );
      const viewId = yield* toPhysicalId(id, news.viewId, output?.viewId, "v");
      const bucket = resolveParent(organization, news, output);
      const name = resourceName(bucket, viewId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* logging
          .createOrganizationsLocationsBucketsViews({
            parent: bucket,
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
        return yield* new OrganizationBucketsViewNotResolved({ name });
      }

      const filterChanged = (current.filter ?? "") !== (news.filter ?? "");
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const updateMask = [
        filterChanged ? "filter" : undefined,
        descriptionChanged ? "description" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* logging.patchOrganizationsLocationsBucketsViews({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body: {
            filter: news.filter ?? "",
            description: desiredDescription,
          },
        });
      }

      return toAttrs(current, bucket, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* logging
        .deleteOrganizationsLocationsBucketsViews({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
