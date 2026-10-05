import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { listLocations } from "./names.ts";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { waitForOperation } from "./operations.ts";
import {
  expandParent,
  fingerprint,
  hasAlchemyLabelMap,
  lastSegment,
  normalizeLocation,
  parseResourceName,
  specifiedEquals,
  toPhysicalSnake,
  userLabels,
} from "./helpers.ts";

const MAX_NAME_LENGTH = 60;

export type FeatureViewBigQuerySource = {
  /** BigQuery view URI materialized on each sync. */
  uri?: string;
  /** Columns used as entity ids. */
  entityIdColumns?: string[];
};

export type FeatureViewFeatureRegistrySource = {
  /** Feature groups and feature ids to sync. */
  featureGroups?: Array<{
    featureGroupId?: string;
    featureIds?: string[];
  }>;
  /** Parent project number of the Feature Groups. */
  projectNumber?: string;
};

export type FeatureViewVertexRagSource = {
  /** BigQuery view/table URI. */
  uri?: string;
  /** RAG corpus id. */
  ragCorpusId?: string;
};

export type FeatureViewSyncConfig = {
  /** Cron schedule. */
  cron?: string;
  /** Continuous sync. */
  continuous?: boolean;
};

export type FeatureViewIndexConfig = {
  embeddingColumn?: string;
  embeddingDimension?: number;
  crowdingColumn?: string;
  filterColumns?: string[];
  distanceMeasureType?:
    | aiplatform.GoogleCloudAiplatformV1FeatureViewIndexConfigDistanceMeasureTypeEnum
    | (string & {});
  treeAhConfig?: { leafNodeEmbeddingCount?: string };
  bruteForceConfig?: Record<string, never>;
};

export type FeatureOnlineStoresFeatureViewProps = {
  /**
   * Parent Feature Online Store resource name or id. Immutable.
   */
  featureOnlineStore: string;
  /**
   * Feature View id. Valid characters `[a-z0-9_]`, must start with a
   * letter, max 60. Immutable.
   */
  featureViewId?: string;
  /**
   * Region used when `featureOnlineStore` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * BigQuery source. Mutually exclusive with `featureRegistrySource`
   * and `vertexRagSource`.
   */
  bigQuerySource?: FeatureViewBigQuerySource;
  /**
   * Feature Registry source.
   */
  featureRegistrySource?: FeatureViewFeatureRegistrySource;
  /**
   * Vertex RAG source.
   */
  vertexRagSource?: FeatureViewVertexRagSource;
  /**
   * Sync schedule.
   */
  syncConfig?: FeatureViewSyncConfig;
  /**
   * Vector index config.
   */
  indexConfig?: FeatureViewIndexConfig;
  /**
   * Optimized-store replica config.
   */
  optimizedConfig?: {
    automaticResources?: { minReplicaCount?: number; maxReplicaCount?: number };
  };
  /**
   * Service agent type used during data sync.
   */
  serviceAgentType?:
    | aiplatform.GoogleCloudAiplatformV1FeatureViewServiceAgentTypeEnum
    | (string & {});
  /**
   * Run an on-demand sync immediately at create.
   * @default false
   */
  runSyncImmediately?: boolean;
};

export type FeatureOnlineStoresFeatureView = Resource<
  "GCP.AIPlatform.FeatureOnlineStoresFeatureView",
  FeatureOnlineStoresFeatureViewProps,
  {
    /** Full resource name. */
    name: string;
    /** Feature view id. */
    featureViewId: string;
    /** Parent online store resource name. */
    featureOnlineStore: string;
    /** Parent online store id. */
    featureOnlineStoreId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** BigQuery source. */
    bigQuerySource:
      | aiplatform.GoogleCloudAiplatformV1FeatureViewBigQuerySource
      | undefined;
    /** Feature Registry source. */
    featureRegistrySource:
      | aiplatform.GoogleCloudAiplatformV1FeatureViewFeatureRegistrySource
      | undefined;
    /** Vertex RAG source. */
    vertexRagSource:
      | aiplatform.GoogleCloudAiplatformV1FeatureViewVertexRagSource
      | undefined;
    /** Sync config. */
    syncConfig:
      | aiplatform.GoogleCloudAiplatformV1FeatureViewSyncConfig
      | undefined;
    /** Vector index config. */
    indexConfig:
      | aiplatform.GoogleCloudAiplatformV1FeatureViewIndexConfig
      | undefined;
    /** Optimized replica config. */
    optimizedConfig:
      | aiplatform.GoogleCloudAiplatformV1FeatureViewOptimizedConfig
      | undefined;
    /** Service agent type. */
    serviceAgentType:
      | aiplatform.GoogleCloudAiplatformV1FeatureViewServiceAgentTypeEnum
      | (string & {})
      | undefined;
    /** Unique service account email. */
    serviceAccountEmail: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Server etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Feature View — the serving projection of a Feature Online Store.
 *
 * Parent store, view id, and location are identity. Labels, sources, sync
 * schedule, and optimized replica counts update in place.
 *
 * ### Creating a Feature View
 * **Example:** Registry-backed view
 * ```typescript
 * const view = yield* GCP.AIPlatform.FeatureOnlineStoresFeatureView("Users", {
 *   featureOnlineStore: store.name,
 *   featureRegistrySource: {
 *     featureGroups: [{ featureGroupId: group.featureGroupId, featureIds: ["age"] }],
 *   },
 *   syncConfig: { cron: "0 * * * *" },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const FeatureOnlineStoresFeatureView =
  Resource<FeatureOnlineStoresFeatureView>(
    "GCP.AIPlatform.FeatureOnlineStoresFeatureView",
  );

export class FeatureOnlineStoresFeatureViewNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.FeatureOnlineStoresFeatureViewNotResolved",
)<{
  name: string;
}> {}

export class FeatureOnlineStoresFeatureViewStillExists extends Data.TaggedError(
  "GCP.AIPlatform.FeatureOnlineStoresFeatureViewStillExists",
)<{
  name: string;
}> {}

const parentOf = (project: string, location: string, store: string) =>
  expandParent(store, project, location, "featureOnlineStores");

const resourceName = (parent: string, viewId: string) =>
  `${parent}/featureViews/${viewId}`;

const toAttrs = (
  view: aiplatform.GoogleCloudAiplatformV1FeatureView,
  project: string,
) => {
  const name = view.name ?? "";
  const parsed = parseResourceName(name, "featureViews");
  const store = parseResourceName(parsed.parent, "featureOnlineStores");
  return {
    name,
    featureViewId: parsed.id,
    featureOnlineStore: parsed.parent,
    featureOnlineStoreId: store.id,
    project: parsed.project || project,
    location: parsed.location,
    labels: userLabels(view.labels),
    bigQuerySource: view.bigQuerySource,
    featureRegistrySource: view.featureRegistrySource,
    vertexRagSource: view.vertexRagSource,
    syncConfig: view.syncConfig,
    indexConfig: view.indexConfig,
    optimizedConfig: view.optimizedConfig,
    serviceAgentType: view.serviceAgentType,
    serviceAccountEmail: view.serviceAccountEmail,
    createTime: view.createTime,
    updateTime: view.updateTime,
    etag: view.etag,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsFeatureOnlineStoresFeatureViews({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((view) =>
      view
        ? Effect.succeed(view)
        : Effect.fail(new FeatureOnlineStoresFeatureViewNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag ===
        "GCP.AIPlatform.FeatureOnlineStoresFeatureViewNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((view) =>
      view === undefined
        ? Effect.void
        : Effect.fail(new FeatureOnlineStoresFeatureViewStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag ===
        "GCP.AIPlatform.FeatureOnlineStoresFeatureViewStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const listViewsUnder = (parent: string, project: string) =>
  aiplatform.listProjectsLocationsFeatureOnlineStoresFeatureViews
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.featureViews ?? [])),
      Stream.filter((view) => hasAlchemyLabelMap(view.labels)),
      Stream.map((view) => toAttrs(view, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const FeatureOnlineStoresFeatureViewProvider = () =>
  Provider.succeed(FeatureOnlineStoresFeatureView, {
    stables: [
      "name",
      "featureViewId",
      "featureOnlineStore",
      "featureOnlineStoreId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousId = olds?.featureViewId ?? output?.featureViewId;
      const nextId = news.featureViewId ?? previousId;
      const previousParent =
        olds?.featureOnlineStore ?? output?.featureOnlineStore ?? "";
      const nextParent = news.featureOnlineStore ?? previousParent;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const parentChanged =
        previousParent.length > 0 &&
        lastSegment(nextParent) !== lastSegment(previousParent);
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        parentChanged ||
        previousLocation !== nextLocation;
      if (!replace) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const parentRef = olds?.featureOnlineStore ?? output?.featureOnlineStore;
      // A create interrupted before its parent resolved has nothing to find.
      if (output?.name === undefined && typeof parentRef !== "string") {
        return undefined;
      }
      const parent = parentOf(env.project, location, parentRef ?? "");
      const viewId = yield* toPhysicalSnake(
        id,
        olds?.featureViewId,
        output?.featureViewId,
        MAX_NAME_LENGTH,
      );
      const name = output?.name ?? resourceName(parent, viewId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const stores = yield* Stream.fromIterable(listLocations(env.region))
          .pipe(
            Stream.flatMap((location) =>
              aiplatform.listProjectsLocationsFeatureOnlineStores.pages({
                parent: `projects/${env.project}/locations/${location}`,
                pageSize: 100,
              }),
            ),
          )
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.featureOnlineStores ?? []),
            ),
            Stream.filter((store) => hasAlchemyLabelMap(store.labels)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
        const nested = yield* Effect.forEach(
          stores,
          (store) =>
            store.name
              ? listViewsUnder(store.name, env.project)
              : Effect.succeed([]),
          { concurrency: 4 },
        );
        return nested.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const parent = parentOf(env.project, location, news.featureOnlineStore);
      const viewId = yield* toPhysicalSnake(
        id,
        news.featureViewId,
        output?.featureViewId,
        MAX_NAME_LENGTH,
      );
      const name = resourceName(parent, viewId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsFeatureOnlineStoresFeatureViews({
            parent,
            featureViewId: viewId,
            runSyncImmediately: news.runSyncImmediately === true,
            body: {
              labels: desiredLabels,
              bigQuerySource: news.bigQuerySource,
              featureRegistrySource: news.featureRegistrySource,
              vertexRagSource: news.vertexRagSource,
              syncConfig: news.syncConfig,
              indexConfig: news.indexConfig,
              optimizedConfig: news.optimizedConfig,
              serviceAgentType: news.serviceAgentType,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new FeatureOnlineStoresFeatureViewNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const bqChanged =
        news.bigQuerySource !== undefined &&
        !specifiedEquals(news.bigQuerySource, current.bigQuerySource);
      const registryChanged =
        news.featureRegistrySource !== undefined &&
        !specifiedEquals(
          news.featureRegistrySource,
          current.featureRegistrySource,
        );
      const syncChanged =
        news.syncConfig !== undefined &&
        fingerprint(current.syncConfig) !== fingerprint(news.syncConfig);
      const optimizedChanged =
        news.optimizedConfig !== undefined &&
        !specifiedEquals(news.optimizedConfig, current.optimizedConfig);
      const agentChanged =
        news.serviceAgentType !== undefined &&
        (current.serviceAgentType ?? "") !== news.serviceAgentType;

      if (
        labelsChanged ||
        bqChanged ||
        registryChanged ||
        syncChanged ||
        optimizedChanged ||
        agentChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          bqChanged ? "big_query_source" : undefined,
          registryChanged ? "feature_registry_source" : undefined,
          syncChanged ? "sync_config" : undefined,
          optimizedChanged ? "optimized_config.automatic_resources" : undefined,
          agentChanged ? "service_agent_type" : undefined,
        ].filter((field): field is string => field !== undefined);

        const patched = yield* aiplatform
          .patchProjectsLocationsFeatureOnlineStoresFeatureViews({
            name,
            updateMask: updateMask.join(","),
            body: {
              name,
              labels: desiredLabels,
              bigQuerySource: news.bigQuerySource,
              featureRegistrySource: news.featureRegistrySource,
              syncConfig: news.syncConfig,
              optimizedConfig: news.optimizedConfig,
              serviceAgentType: news.serviceAgentType,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("5 seconds"),
            }),
          );
        yield* waitForOperation(patched);
        current = yield* waitUntilExists(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* aiplatform
        .deleteProjectsLocationsFeatureOnlineStoresFeatureViews({
          name: output.name,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
