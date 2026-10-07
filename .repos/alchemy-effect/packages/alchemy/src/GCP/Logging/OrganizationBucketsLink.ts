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
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
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
import { waitForDeleteOperation, waitForOperation } from "./operations.ts";

export type OrganizationBucketsLinkProps = {
  /**
   * Link id (alphanumeric and underscores only). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Immutable —
   * changing it replaces the link. A log bucket may contain only one
   * link.
   */
  linkId?: string;
  /**
   * Parent organization (`organizations/{organization}` or the numeric
   * id). Defaults to the project ancestor organization. Immutable —
   * changing it replaces the link.
   */
  organization?: string;
  /**
   * Parent analytics-enabled log bucket resource name
   * (`organizations/{organization}/locations/{location}/buckets/{bucket}`).
   * Required. Immutable — changing it replaces the link.
   */
  bucket: string;
  /**
   * Location of the parent bucket. Taken from `bucket` when omitted.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable description (max 8000 characters). Links have no
   * labels field, so Alchemy ownership is stored in a `[alchemy …]`
   * prefix and stripped from attributes. The Logging API cannot update a
   * link after create.
   */
  description?: string;
};

export type OrganizationBucketsLink = Resource<
  "GCP.Logging.OrganizationBucketsLink",
  OrganizationBucketsLinkProps,
  {
    /** Full resource name `organizations/{organization}/locations/{location}/buckets/{bucket}/links/{link}`. */
    name: string;
    /** Link id (last path segment). */
    linkId: string;
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
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Linked BigQuery dataset id, if reported. */
    datasetId: string | undefined;
    /** Link lifecycle (`ACTIVE`, `CREATING`, …). */
    lifecycleState: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A BigQuery dataset link for an organization Cloud Logging bucket.
 *
 * Analytics must be enabled on the parent bucket. A bucket may contain
 * only one link. Links have no labels field, so Alchemy stamps
 * ownership into the description for `list` / nuke. The API has no
 * update method — `linkId`, organization, and bucket are identity.
 *
 * ### Creating an Organization Bucket Link
 * **Example:** Link an analytics-enabled organization bucket
 * ```typescript
 * const bucket = yield* GCP.Logging.OrganizationLogBucket("Analytics", {
 *   analyticsEnabled: true,
 * });
 * const link = yield* GCP.Logging.OrganizationBucketsLink("Bq", {
 *   bucket: bucket.name,
 *   description: "log analytics dataset",
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const OrganizationBucketsLink = Resource<OrganizationBucketsLink>(
  "GCP.Logging.OrganizationBucketsLink",
);

export class OrganizationBucketsLinkNotResolved extends Data.TaggedError(
  "GCP.Logging.OrganizationBucketsLinkNotResolved",
)<{
  name: string;
}> {}

const parseLinkName = (name: string) => {
  const match = name.match(
    /^(organizations\/[^/]+)\/locations\/([^/]+)\/buckets\/([^/]+)\/links\/([^/]+)$/,
  );
  if (!match) return undefined;
  return {
    organization: match[1]!,
    location: match[2]!,
    bucketId: match[3]!,
    linkId: match[4]!,
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

const resourceName = (bucket: string, linkId: string) =>
  `${bucket}/links/${linkId}`;

const isDeleted = (link: logging.Link | undefined): link is undefined =>
  link === undefined || link.lifecycleState === "DELETE_REQUESTED";

const isPending = (state: string | undefined) =>
  state === "CREATING" || state === "UPDATING";

const toAttrs = (
  link: logging.Link,
  fallbackBucket: string,
  project: string,
) => {
  const name = link.name ?? "";
  const parsed = parseLinkName(name);
  const bucket =
    parsed !== undefined
      ? `${parsed.organization}/locations/${parsed.location}/buckets/${parsed.bucketId}`
      : fallbackBucket;
  const bucketParsed = parseBucketName(bucket);
  const description = parseDescription(link.description);
  const organization = parsed?.organization ?? bucketParsed?.organization ?? "";
  return {
    name: name || resourceName(bucket, parsed?.linkId ?? lastSegment(name)),
    linkId: parsed?.linkId ?? lastSegment(name),
    bucket,
    bucketId: parsed?.bucketId ?? bucketParsed?.bucketId ?? "",
    organization,
    organizationId: organizationIdOf(organization),
    project,
    location: parsed?.location ?? bucketParsed?.location ?? DEFAULT_LOCATION,
    description: description.description,
    datasetId: link.bigqueryDataset?.datasetId,
    lifecycleState: link.lifecycleState,
    createTime: link.createTime,
  };
};

const getByName = (name: string) =>
  logging
    .getOrganizationsLocationsBucketsLinks({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilActive = (name: string) =>
  Effect.gen(function* () {
    const link = yield* getByName(name);
    if (isDeleted(link)) {
      return yield* new OrganizationBucketsLinkNotResolved({ name });
    }
    if (link.lifecycleState === "FAILED") {
      return yield* new OrganizationBucketsLinkNotResolved({ name });
    }
    if (isPending(link.lifecycleState)) {
      return yield* new OrganizationBucketsLinkNotResolved({ name });
    }
    return link;
  }).pipe(
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Logging.OrganizationBucketsLinkNotResolved",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilDeleted = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((link) =>
      isDeleted(link)
        ? Effect.void
        : Effect.fail(new OrganizationBucketsLinkNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Logging.OrganizationBucketsLinkNotResolved",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const OrganizationBucketsLinkProvider = () =>
  Provider.succeed(OrganizationBucketsLink, {
    stables: [
      "name",
      "linkId",
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
      const previousId = olds?.linkId ?? output?.linkId;
      const idChanged =
        previousId !== undefined &&
        news.linkId !== undefined &&
        news.linkId !== previousId;
      const previousBucket = olds?.bucket ?? output?.bucket;
      const bucketChanged =
        previousBucket !== undefined && news.bucket !== previousBucket;
      const previousOrg = olds?.organization ?? output?.organization;
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        news.organization !== previousOrg;
      if (!idChanged && !bucketChanged && !orgChanged) return undefined;
      return { action: "replace" as const, deleteFirst: true };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      yield* resolveOrganization(
        olds?.organization ?? output?.organization,
        output?.organization,
      );
      const linkId = yield* toPhysicalId(
        id,
        olds?.linkId,
        output?.linkId,
        "l",
        { delimiter: "_", underscores: true },
      );
      const bucket = olds?.bucket ?? output?.bucket ?? "";
      const name = output?.name ?? resourceName(bucket, linkId);
      const existing = yield* getByName(name);
      if (isDeleted(existing)) return undefined;
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
                  ? logging.listOrganizationsLocationsBucketsLinks
                      .pages({
                        parent: bucket.name,
                        pageSize: 1000,
                      })
                      .pipe(
                        Stream.flatMap((page) =>
                          Stream.fromIterable(page.links ?? []),
                        ),
                        Stream.filter(
                          (link) =>
                            !isDeleted(link) &&
                            hasOwnershipMarker(link.description),
                        ),
                        Stream.map((link) =>
                          toAttrs(link, bucket.name ?? "", env.project),
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
      yield* resolveOrganization(news.organization, output?.organization);
      const linkId = yield* toPhysicalId(id, news.linkId, output?.linkId, "l", {
        delimiter: "_",
        underscores: true,
      });
      const bucket = news.bucket;
      const name = resourceName(bucket, linkId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (isDeleted(current)) {
        const created = yield* logging
          .createOrganizationsLocationsBucketsLinks({
            parent: bucket,
            linkId,
            body: {
              description: desiredDescription,
            },
          })
          .pipe(
            Effect.flatMap((operation) => waitForOperation(operation)),
            Effect.flatMap(() => getByName(name)),
            Effect.catchTag("Conflict", () => getByName(name)),
          );
        current = created ?? undefined;
        if (current !== undefined && isPending(current.lifecycleState)) {
          current = yield* waitUntilActive(current.name ?? name);
        }
      }

      if (isDeleted(current)) {
        return yield* new OrganizationBucketsLinkNotResolved({ name });
      }

      return toAttrs(current, bucket, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.lifecycleState === "DELETE_REQUESTED") return;
      const operation = yield* logging
        .deleteOrganizationsLocationsBucketsLinks({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilDeleted(output.name);
    }),
  });
