import * as observability from "@distilled.cloud/gcp/observability_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeDescription,
  hasOwnershipMarker,
  linkResourceName,
  listLinksAt,
  listProjectDatasets,
  parseDescription,
  parseLinkName,
  resolveDatasetParent,
  toLinkId,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

export type BucketsDatasetsLinkProps = {
  /**
   * Parent observability dataset. Full name
   * `projects/{project}/locations/{location}/buckets/{bucket}/datasets/{dataset}`
   * or the dataset id (combined with `bucket` and `location`). A dataset
   * may have at most one link. Immutable — changing it replaces the
   * link (delete-first).
   */
  dataset: string;
  /**
   * Parent bucket used when `dataset` is a bare id. Full name or the
   * bucket id. Defaults to `_Trace`. Immutable — changing it replaces
   * the link.
   */
  bucket?: string;
  /**
   * Bucket location used when `dataset` is a bare id. Immutable —
   * changing it replaces the link.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Link id (the `{link}` segment of
   * `.../datasets/{dataset}/links/{link}`). Also used as the linked
   * BigQuery dataset id, so it may contain only letters, digits, and
   * underscores and must start with a letter. If omitted, a unique name
   * is generated. Immutable — changing it replaces the link.
   */
  linkId?: string;
  /**
   * User-friendly display name.
   */
  displayName?: string;
  /**
   * Human-readable description (max 8000 characters). Links have no
   * labels field, so Alchemy stamps ownership into the description for
   * `list` / nuke.
   */
  description?: string;
};

export type BucketsDatasetsLink = Resource<
  "GCP.Observability.BucketsDatasetsLink",
  BucketsDatasetsLinkProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/buckets/{bucket}/datasets/{dataset}/links/{linkId}`. */
    name: string;
    /** Link id (last path segment). */
    linkId: string;
    /** Parent dataset resource name. */
    dataset: string;
    /** Dataset id. */
    datasetId: string;
    /** Parent bucket resource name. */
    bucket: string;
    /** Bucket id. */
    bucketId: string;
    /** Project id. */
    project: string;
    /** Location of the parent bucket. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Observability dataset link that creates a linked BigQuery
 * dataset over an observability analytics dataset (typically
 * `_Trace/Spans`).
 *
 * A dataset may have only one link. Create, update, and delete are
 * long-running operations. Links have no labels field — Alchemy stamps
 * ownership into the description. `linkId` and the parent dataset are
 * identity; replacement is delete-first because a dataset cannot hold
 * two links.
 *
 * ### Creating a Link
 * **Example:** Link the default trace dataset to BigQuery
 * ```typescript
 * const link = yield* GCP.Observability.BucketsDatasetsLink("Analytics", {
 *   dataset:
 *     "projects/my-project/locations/us-central1/buckets/_Trace/datasets/Spans",
 *   description: "bigquery analytics",
 * });
 * ```
 *
 * **Example:** Named link from bucket and dataset ids
 * ```typescript
 * const link = yield* GCP.Observability.BucketsDatasetsLink("Analytics", {
 *   bucket: "_Trace",
 *   dataset: "Spans",
 *   linkId: "trace_spans",
 *   displayName: "Trace spans",
 * });
 * ```
 *
 * ### Updating a Link
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Change the description
 * ```typescript
 * const link = yield* GCP.Observability.BucketsDatasetsLink("Analytics", {
 *   dataset:
 *     "projects/my-project/locations/us-central1/buckets/_Trace/datasets/Spans",
 *   description: "updated analytics",
 * });
 * ```
 *
 * @resource
 * @category Observability
 */
export const BucketsDatasetsLink = Resource<BucketsDatasetsLink>(
  "GCP.Observability.BucketsDatasetsLink",
);

export class BucketsDatasetsLinkNotResolved extends Data.TaggedError(
  "GCP.Observability.BucketsDatasetsLinkNotResolved",
)<{
  name: string;
}> {}

export class BucketsDatasetsLinkStillExists extends Data.TaggedError(
  "GCP.Observability.BucketsDatasetsLinkStillExists",
)<{
  name: string;
}> {}

const isValidLinkName = (name: string) => parseLinkName(name) !== undefined;

const toAttrs = (
  link: observability.Link,
  project: string,
  location: string,
  bucketId: string,
  datasetId: string,
) => {
  const parsedName = parseLinkName(link.name ?? "");
  const parsed = parseDescription(link.description);
  const linkId = parsedName?.linkId ?? (link.name ?? "").split("/").pop() ?? "";
  const resolvedProject = parsedName?.project ?? project;
  const resolvedLocation = parsedName?.location ?? location;
  const resolvedBucketId = parsedName?.bucketId ?? bucketId;
  const resolvedDatasetId = parsedName?.datasetId ?? datasetId;
  return {
    name:
      link.name ??
      (linkId
        ? linkResourceName(
            resolvedProject,
            resolvedLocation,
            resolvedBucketId,
            resolvedDatasetId,
            linkId,
          )
        : ""),
    linkId,
    dataset: `projects/${resolvedProject}/locations/${resolvedLocation}/buckets/${resolvedBucketId}/datasets/${resolvedDatasetId}`,
    datasetId: resolvedDatasetId,
    bucket: `projects/${resolvedProject}/locations/${resolvedLocation}/buckets/${resolvedBucketId}`,
    bucketId: resolvedBucketId,
    project: resolvedProject,
    location: resolvedLocation,
    displayName: link.displayName,
    description: parsed.description,
    createTime: link.createTime,
  };
};

const getByName = (name: string) =>
  !isValidLinkName(name)
    ? Effect.succeed(undefined)
    : observability
        .getProjectsLocationsBucketsDatasetsLinks({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilPresent = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((link) =>
      link
        ? Effect.succeed(link)
        : Effect.fail(new BucketsDatasetsLinkNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Observability.BucketsDatasetsLinkNotResolved",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

const waitUntilDeleted = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((link) =>
      link === undefined
        ? Effect.void
        : Effect.fail(new BucketsDatasetsLinkStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Observability.BucketsDatasetsLinkStillExists",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
    Effect.catchTag(
      "GCP.Observability.BucketsDatasetsLinkStillExists",
      () => Effect.void,
    ),
  );

export const BucketsDatasetsLinkProvider = () =>
  Provider.succeed(BucketsDatasetsLink, {
    stables: [
      "name",
      "linkId",
      "dataset",
      "datasetId",
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
      const previousDataset = olds?.dataset ?? output?.dataset;
      const datasetChanged =
        previousDataset !== undefined &&
        news.dataset.includes("/datasets/") &&
        news.dataset !== previousDataset;
      const previousBucket = olds?.bucket ?? output?.bucket;
      const bucketChanged =
        previousBucket !== undefined &&
        news.bucket !== undefined &&
        news.bucket.includes("/buckets/") &&
        news.bucket !== previousBucket;
      if (!idChanged && !datasetChanged && !bucketChanged) return undefined;
      return { action: "replace" as const, deleteFirst: true };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = olds?.location ?? output?.location ?? env.region;
      const parent = resolveDatasetParent(
        olds?.dataset ?? output?.dataset ?? "",
        olds?.bucket ?? output?.bucket,
        location,
        env.project,
      );
      const linkId = yield* toLinkId(id, olds?.linkId, output?.linkId);
      const name =
        output?.name ??
        linkResourceName(
          parent.project,
          parent.location,
          parent.bucketId,
          parent.datasetId,
          linkId,
        );
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(
        existing,
        parent.project,
        parent.location,
        parent.bucketId,
        parent.datasetId,
      );
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const datasets = yield* listProjectDatasets();
        const pages = yield* Effect.forEach(
          datasets,
          (dataset) =>
            listLinksAt(dataset.name!).pipe(
              Effect.map((links) =>
                links
                  .filter((link) => hasOwnershipMarker(link.description))
                  .map((link) => {
                    const parsed = parseLinkName(link.name ?? "");
                    return toAttrs(
                      link,
                      parsed?.project ?? env.project,
                      parsed?.location ?? env.region,
                      parsed?.bucketId ?? "",
                      parsed?.datasetId ?? "",
                    );
                  }),
              ),
            ),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = news.location ?? output?.location ?? env.region;
      const parent = resolveDatasetParent(
        news.dataset,
        news.bucket,
        location,
        env.project,
      );
      const linkId = yield* toLinkId(id, news.linkId, output?.linkId);
      const name = linkResourceName(
        parent.project,
        parent.location,
        parent.bucketId,
        parent.datasetId,
        linkId,
      );
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* observability
          .createProjectsLocationsBucketsDatasetsLinks({
            parent: parent.name,
            linkId,
            body: {
              displayName: news.displayName,
              description: desiredDescription,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              Effect.succeed<observability.Operation>({ done: true }),
            ),
          );
        yield* waitForOperation(created).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
        current = yield* waitUntilPresent(name);
      }

      if (current === undefined) {
        return yield* new BucketsDatasetsLinkNotResolved({ name });
      }

      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const displayNameChanged =
        (current.displayName ?? "") !== (news.displayName ?? "");
      const updateMask = [
        descriptionChanged ? "description" : undefined,
        displayNameChanged ? "displayName" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        const patched =
          yield* observability.patchProjectsLocationsBucketsDatasetsLinks({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              displayName: news.displayName,
              description: desiredDescription,
            },
          });
        yield* waitForOperation(patched).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
        current = (yield* getByName(current.name ?? name)) ?? current;
      }

      return toAttrs(
        current,
        parent.project,
        parent.location,
        parent.bucketId,
        parent.datasetId,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const names = isValidLinkName(output.name)
        ? [output.name]
        : output.linkId
          ? yield* listProjectDatasets().pipe(
              Effect.map((datasets) =>
                datasets.flatMap((dataset) =>
                  dataset.name
                    ? [`${dataset.name}/links/${output.linkId}`]
                    : [],
                ),
              ),
            )
          : [];
      yield* Effect.forEach(
        names,
        (name) =>
          observability
            .deleteProjectsLocationsBucketsDatasetsLinks({ name })
            .pipe(
              Effect.flatMap((operation) =>
                waitForOperation(operation, { notFoundOk: true }),
              ),
              Effect.catchTag(["NotFound", "BadRequest"], () => Effect.void),
              Effect.flatMap(() => waitUntilDeleted(name)),
            ),
        { concurrency: 1 },
      );
    }),
  });
