import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  alchemyIdFilter,
  createInternalLabels,
  hasAlchemyPrefix,
  labelsDiffer,
  listLocations,
  locationOf,
  lastSegment,
  normalizeLocation,
  projectOf,
  resourceNameFromOperation,
  stableJson,
  toDisplayName,
  toLabels,
  userLabels,
} from "./names.ts";
import { waitForOperation } from "./operations.ts";

export type IndexProps = {
  /**
   * Vertex AI location (`us-central1`, …). Immutable — changing it
   * replaces the index.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name (max 128 Unicode characters). Generated from the stack,
   * stage, and logical id when omitted.
   */
  displayName?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * How the index is updated. Immutable.
   * @default "STREAM_UPDATE"
   */
  indexUpdateMethod?:
    | aiplatform.GoogleCloudAiplatformV1IndexIndexUpdateMethodEnum
    | (string & {});
  /**
   * Matching Engine metadata (`contentsDeltaUri`, `config.dimensions`,
   * algorithm config).
   */
  metadata?: unknown;
  /**
   * GCS URI of the OpenAPI schema for `metadata`. Immutable.
   */
  metadataSchemaUri?: string;
  /**
   * Customer-managed encryption key. Immutable.
   */
  encryptionSpec?: aiplatform.GoogleCloudAiplatformV1EncryptionSpec;
};

export type Index = Resource<
  "GCP.AIPlatform.Index",
  IndexProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/indexes/{index}`. */
    name: string;
    /** Index id (last path segment). */
    indexId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Update method (`BATCH_UPDATE` or `STREAM_UPDATE`). */
    indexUpdateMethod: string | undefined;
    /** Matching Engine metadata. */
    metadata: unknown;
    /** Schema URI for metadata, if set. */
    metadataSchemaUri: string | undefined;
    /** Dense vector count. */
    vectorsCount: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Matching Engine Index of embedding vectors.
 *
 * Changing `location`, `indexUpdateMethod`, encryption, or
 * `metadataSchemaUri` replaces the index. Display name, description,
 * labels, and metadata update in place (metadata updates are long-running).
 *
 * ### Creating an Index
 * **Example:** Empty streaming index
 * ```typescript
 * const index = yield* GCP.AIPlatform.Index("Embeddings", {
 *   displayName: "product-embeddings",
 *   indexUpdateMethod: "STREAM_UPDATE",
 *   metadata: {
 *     config: {
 *       dimensions: 768,
 *       approximateNeighborsCount: 150,
 *       distanceMeasureType: "DOT_PRODUCT_DISTANCE",
 *       shardSize: "SHARD_SIZE_SMALL",
 *       algorithmConfig: { bruteForceConfig: {} },
 *     },
 *   },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const Index = Resource<Index>("GCP.AIPlatform.Index");

export class IndexNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.IndexNotResolved",
)<{
  name: string;
}> {}

export class IndexStillExists extends Data.TaggedError(
  "GCP.AIPlatform.IndexStillExists",
)<{
  name: string;
}> {}

const DEFAULT_UPDATE_METHOD = "STREAM_UPDATE";

const toAttrs = (
  index: aiplatform.GoogleCloudAiplatformV1Index,
  project: string,
) => {
  const name = index.name ?? "";
  return {
    name,
    indexId: lastSegment(name),
    project: projectOf(name, project),
    location: locationOf(name),
    displayName: index.displayName,
    description: index.description,
    labels: userLabels(index.labels),
    indexUpdateMethod: index.indexUpdateMethod,
    metadata: index.metadata,
    metadataSchemaUri: index.metadataSchemaUri,
    vectorsCount: index.indexStats?.vectorsCount,
    createTime: index.createTime,
    updateTime: index.updateTime,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsIndexes({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listPage = (parent: string, filter?: string) =>
  aiplatform.listProjectsLocationsIndexes
    .pages({ parent, pageSize: 100, filter })
    .pipe(
      Stream.runCollect,
      Effect.map((pages) =>
        Array.from(pages).flatMap((page) => page.indexes ?? []),
      ),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as aiplatform.GoogleCloudAiplatformV1Index[]),
      ),
    );

const findOwned = (
  project: string,
  location: string,
  labels: Record<string, string>,
) =>
  listPage(
    `projects/${project}/locations/${location}`,
    alchemyIdFilter(labels),
  ).pipe(
    Effect.map(
      (items) =>
        items.find((item) => hasAlchemyPrefix(item.labels)) ?? undefined,
    ),
  );

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (index): index is aiplatform.GoogleCloudAiplatformV1Index =>
        index !== undefined,
      () => new IndexNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.IndexNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (index) => index === undefined,
      () => new IndexStillExists({ name }),
    ),
    Effect.asVoid,
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.IndexStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const IndexProvider = () =>
  Provider.succeed(Index, {
    stables: [
      "name",
      "indexId",
      "project",
      "location",
      "indexUpdateMethod",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousMethod = (
        olds?.indexUpdateMethod ??
        output?.indexUpdateMethod ??
        DEFAULT_UPDATE_METHOD
      ).toUpperCase();
      const nextMethod = (
        news.indexUpdateMethod ?? previousMethod
      ).toUpperCase();
      const previousSchema =
        olds?.metadataSchemaUri ?? output?.metadataSchemaUri ?? "";
      const nextSchema = news.metadataSchemaUri ?? previousSchema;
      if (
        previousLocation !== nextLocation ||
        previousMethod !== nextMethod ||
        nextSchema !== previousSchema
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const ownership = yield* createInternalLabels(id);
      const existing =
        (output?.name !== undefined
          ? yield* getByName(output.name)
          : undefined) ?? (yield* findOwned(env.project, location, ownership));
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* Effect.forEach(
          listLocations(env.region),
          (location) =>
            listPage(`projects/${env.project}/locations/${location}`),
          { concurrency: 4 },
        );
        return pages
          .flat()
          .filter((index) => hasAlchemyPrefix(index.labels))
          .map((index) => toAttrs(index, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const displayName = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const indexUpdateMethod = (
        news.indexUpdateMethod ??
        output?.indexUpdateMethod ??
        DEFAULT_UPDATE_METHOD
      ).toUpperCase();

      let current =
        (output?.name !== undefined
          ? yield* getByName(output.name)
          : undefined) ??
        (yield* findOwned(env.project, location, desiredLabels));

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsIndexes({
            parent: `projects/${env.project}/locations/${location}`,
            body: {
              displayName,
              description: news.description,
              labels: desiredLabels,
              indexUpdateMethod,
              metadata: news.metadata,
              metadataSchemaUri: news.metadataSchemaUri,
              encryptionSpec: news.encryptionSpec,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          const done = yield* waitForOperation(created);
          const name = resourceNameFromOperation(done);
          current =
            name !== undefined
              ? yield* waitUntilExists(name)
              : yield* findOwned(env.project, location, desiredLabels);
        }
        if (current === undefined) {
          current = yield* findOwned(env.project, location, desiredLabels);
        }
      }

      if (current === undefined || current.name === undefined) {
        return yield* new IndexNotResolved({
          name: output?.name ?? `${location}/indexes`,
        });
      }

      const name = current.name;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const displayChanged = (current.displayName ?? "") !== displayName;
      const labelsChanged = labelsDiffer(current.labels, desiredLabels);
      const metadataChanged =
        news.metadata !== undefined &&
        stableJson(current.metadata) !== stableJson(news.metadata);

      if (
        descriptionChanged ||
        displayChanged ||
        labelsChanged ||
        metadataChanged
      ) {
        const operation = yield* aiplatform.patchProjectsLocationsIndexes({
          name,
          updateMask: [
            descriptionChanged ? "description" : undefined,
            displayChanged ? "display_name" : undefined,
            labelsChanged ? "labels" : undefined,
            metadataChanged ? "metadata" : undefined,
          ]
            .filter((field): field is string => field !== undefined)
            .join(","),
          body: {
            name,
            displayName,
            description: news.description,
            labels: desiredLabels,
            metadata: news.metadata,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* aiplatform
        .deleteProjectsLocationsIndexes({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
