import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  collectionParent,
  dataStoreIdOf,
  DEFAULT_COLLECTION,
  normalizeCollection,
  normalizeLocation,
  parseResourceName,
  sameJson,
  sameStringList,
  toResourceId,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

export type CollectionsEngineSearchEngineConfig = {
  /**
   * Search feature tier. Defaults to `SEARCH_TIER_STANDARD`.
   */
  searchTier?: discoveryengine.GoogleCloudDiscoveryengineV1EngineSearchEngineConfigSearchTierEnum;
  /**
   * Search add-ons enabled on this engine.
   */
  searchAddOns?: discoveryengine.GoogleCloudDiscoveryengineV1EngineSearchEngineConfigSearchAddOnsItemEnumList;
  /**
   * Required subscription tier. Immutable after create.
   */
  requiredSubscriptionTier?: discoveryengine.GoogleCloudDiscoveryengineV1EngineSearchEngineConfigRequiredSubscriptionTierEnum;
};

export type CollectionsEngineCommonConfig = {
  /**
   * Company or entity associated with the engine. Setting this may help
   * LLM features.
   */
  companyName?: string;
};

export type CollectionsEngineProps = {
  /**
   * Engine id (the `{engine}` segment of the resource name). If omitted,
   * a unique RFC-1034 id is generated. Immutable — changing it replaces
   * the engine.
   */
  engineId?: string;
  /**
   * Location (`global`, `us`, `eu`, …). Immutable — changing it replaces
   * the engine.
   * @default "global"
   */
  location?: string;
  /**
   * Collection id. Immutable — changing it replaces the engine.
   * @default "default_collection"
   */
  collectionId?: string;
  /**
   * User-facing display name.
   * @default the engine id
   */
  displayName?: string;
  /**
   * Solution type. Immutable — changing it replaces the engine.
   * @default "SOLUTION_TYPE_SEARCH"
   */
  solutionType?: discoveryengine.GoogleCloudDiscoveryengineV1EngineSolutionTypeEnum;
  /**
   * Industry vertical. Must match the linked data store. Immutable.
   * @default "GENERIC"
   */
  industryVertical?: discoveryengine.GoogleCloudDiscoveryengineV1EngineIndustryVerticalEnum;
  /**
   * Data store ids to attach. For search and recommendation engines at
   * most one id is allowed. Values may be ids or full resource names.
   */
  dataStoreIds?: string[];
  /**
   * Search-engine configuration. Applied when `solutionType` is
   * `SOLUTION_TYPE_SEARCH`.
   */
  searchEngineConfig?: CollectionsEngineSearchEngineConfig;
  /**
   * Common metadata (company name).
   */
  commonConfig?: CollectionsEngineCommonConfig;
  /**
   * Chat-engine configuration. One-time consumed at create.
   */
  chatEngineConfig?: discoveryengine.GoogleCloudDiscoveryengineV1EngineChatEngineConfig;
  /**
   * Media recommendation configuration.
   */
  mediaRecommendationEngineConfig?: discoveryengine.GoogleCloudDiscoveryengineV1EngineMediaRecommendationEngineConfig;
  /**
   * Disable analytics for searches on this engine.
   * @default false
   */
  disableAnalytics?: boolean;
  /**
   * Application type. Immutable.
   */
  appType?: discoveryengine.GoogleCloudDiscoveryengineV1EngineAppTypeEnum;
};

export type CollectionsEngine = Resource<
  "GCP.DiscoveryEngine.CollectionsEngine",
  CollectionsEngineProps,
  {
    /** Full resource name. */
    name: string;
    /** Engine id (last path segment). */
    engineId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Collection id. */
    collectionId: string;
    /** Display name. */
    displayName: string | undefined;
    /** Solution type. */
    solutionType: string | undefined;
    /** Industry vertical. */
    industryVertical: string | undefined;
    /** Attached data store ids. */
    dataStoreIds: string[];
    /** Whether analytics are disabled. */
    disableAnalytics: boolean;
    /** Company name from common config. */
    companyName: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Discovery Engine Engine under a collection — serves Search,
 * Recommendation, or Chat from one or more DataStores.
 *
 * Without labels, ownership rests on the deterministic id: `read` reports a
 * resource it finds without prior state as unowned (adopt it with `--adopt`).
 * Parent is
 * `projects/{project}/locations/{location}/collections/{collection}`. Id,
 * location, collection, solution type, and vertical are immutable; display
 * name, analytics flag, and common config update in place.
 *
 * ### Creating an Engine
 * **Example:** Search engine over a data store
 * ```typescript
 * const store = yield* GCP.DiscoveryEngine.DataStore("Docs", {});
 * const engine = yield* GCP.DiscoveryEngine.CollectionsEngine("Search", {
 *   dataStoreIds: [store.dataStoreId],
 *   displayName: "docs search",
 * });
 * ```
 *
 * ### Updating an Engine
 * **Example:** Rename
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const engine = yield* GCP.DiscoveryEngine.CollectionsEngine("Search", {
 *   dataStoreIds: [store.dataStoreId],
 *   displayName: "docs search prod",
 * });
 * ```
 *
 * @resource
 * @category DiscoveryEngine
 */
export const CollectionsEngine = Resource<CollectionsEngine>(
  "GCP.DiscoveryEngine.CollectionsEngine",
);

export class CollectionsEngineNotResolved extends Data.TaggedError(
  "GCP.DiscoveryEngine.CollectionsEngineNotResolved",
)<{
  name: string;
}> {}

export class CollectionsEngineStillExists extends Data.TaggedError(
  "GCP.DiscoveryEngine.CollectionsEngineStillExists",
)<{
  name: string;
}> {}

const resourceName = (
  project: string,
  location: string,
  collectionId: string,
  engineId: string,
) => `${collectionParent(project, location, collectionId)}/engines/${engineId}`;

const solutionOf = (
  value:
    | discoveryengine.GoogleCloudDiscoveryengineV1EngineSolutionTypeEnum
    | undefined,
) => value ?? "SOLUTION_TYPE_SEARCH";

const verticalOf = (
  value:
    | discoveryengine.GoogleCloudDiscoveryengineV1EngineIndustryVerticalEnum
    | undefined,
) => value ?? "GENERIC";

const idsOf = (values: readonly string[] | undefined) =>
  (values ?? []).map(dataStoreIdOf);

const getByName = (name: string) =>
  discoveryengine
    .getProjectsLocationsCollectionsEngines({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toAttrs = (
  engine: discoveryengine.GoogleCloudDiscoveryengineV1Engine,
  project: string,
) => {
  const name = engine.name ?? "";
  const parsed = parseResourceName(name, "engines");
  return {
    name,
    engineId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    collectionId: parsed.collectionId || DEFAULT_COLLECTION,
    displayName: engine.displayName,
    solutionType: engine.solutionType,
    industryVertical: engine.industryVertical,
    dataStoreIds: [...(engine.dataStoreIds ?? [])],
    disableAnalytics: engine.disableAnalytics === true,
    companyName: engine.commonConfig?.companyName,
    createTime: engine.createTime,
    updateTime: engine.updateTime,
  };
};

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((engine) =>
      engine
        ? Effect.succeed(engine)
        : Effect.fail(new CollectionsEngineNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.DiscoveryEngine.CollectionsEngineNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((engine) =>
      engine === undefined
        ? Effect.void
        : Effect.fail(new CollectionsEngineStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.DiscoveryEngine.CollectionsEngineStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const CollectionsEngineProvider = () =>
  Provider.succeed(CollectionsEngine, {
    stables: [
      "name",
      "engineId",
      "project",
      "location",
      "collectionId",
      "solutionType",
      "industryVertical",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.engineId ?? output?.engineId;
      const nextId = news.engineId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      const previousCollection = normalizeCollection(
        olds?.collectionId ?? output?.collectionId,
      );
      const nextCollection = normalizeCollection(
        news.collectionId ?? olds?.collectionId ?? output?.collectionId,
      );
      const previousSolution = solutionOf(
        olds?.solutionType ??
          (output?.solutionType as CollectionsEngineProps["solutionType"]),
      );
      const nextSolution = solutionOf(
        news.solutionType ??
          (output?.solutionType as CollectionsEngineProps["solutionType"]),
      );
      const previousVertical = verticalOf(
        olds?.industryVertical ??
          (output?.industryVertical as CollectionsEngineProps["industryVertical"]),
      );
      const nextVertical = verticalOf(
        news.industryVertical ??
          (output?.industryVertical as CollectionsEngineProps["industryVertical"]),
      );
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousCollection !== nextCollection ||
        previousSolution !== nextSolution ||
        previousVertical !== nextVertical;
      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousCollection === nextCollection &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const engineId = yield* toResourceId(
        id,
        olds?.engineId,
        output?.engineId,
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const collectionId = normalizeCollection(
        olds?.collectionId ?? output?.collectionId,
      );
      const existing = yield* getByName(
        output?.name ??
          resourceName(env.project, location, collectionId, engineId),
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const collectionId = normalizeCollection(
        news.collectionId ?? output?.collectionId,
      );
      const engineId = yield* toResourceId(id, news.engineId, output?.engineId);
      const displayName = news.displayName ?? engineId;
      const solutionType = solutionOf(news.solutionType);
      const industryVertical = verticalOf(news.industryVertical);
      const dataStoreIds = idsOf(news.dataStoreIds ?? output?.dataStoreIds);
      const parent = collectionParent(env.project, location, collectionId);
      const fallbackName =
        output?.name ??
        resourceName(env.project, location, collectionId, engineId);
      const searchEngineConfig =
        solutionType === "SOLUTION_TYPE_SEARCH"
          ? (news.searchEngineConfig ?? {})
          : news.searchEngineConfig;
      const disableAnalytics = news.disableAnalytics === true;

      let current = yield* getByName(fallbackName);

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsCollectionsEngines({
            parent,
            engineId,
            body: {
              displayName,
              solutionType,
              industryVertical,
              dataStoreIds,
              searchEngineConfig,
              commonConfig: news.commonConfig,
              chatEngineConfig: news.chatEngineConfig,
              mediaRecommendationEngineConfig:
                news.mediaRecommendationEngineConfig,
              disableAnalytics: disableAnalytics ? true : undefined,
              appType: news.appType,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(fallbackName);
      }

      if (current === undefined) {
        return yield* new CollectionsEngineNotResolved({ name: fallbackName });
      }

      const name = current.name ?? fallbackName;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const analyticsChanged =
        (current.disableAnalytics === true) !== disableAnalytics;
      const companyChanged =
        (current.commonConfig?.companyName ?? "") !==
        (news.commonConfig?.companyName ?? "");
      const searchChanged =
        searchEngineConfig !== undefined &&
        !sameJson(current.searchEngineConfig, searchEngineConfig);
      const dataStoresChanged = !sameStringList(
        current.dataStoreIds,
        dataStoreIds,
      );

      if (
        displayNameChanged ||
        analyticsChanged ||
        companyChanged ||
        searchChanged ||
        dataStoresChanged
      ) {
        current =
          yield* discoveryengine.patchProjectsLocationsCollectionsEngines({
            name,
            updateMask: [
              displayNameChanged ? "display_name" : undefined,
              analyticsChanged ? "disable_analytics" : undefined,
              companyChanged ? "common_config" : undefined,
              searchChanged ? "search_engine_config" : undefined,
              dataStoresChanged ? "data_store_ids" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: {
              name,
              displayName,
              disableAnalytics,
              commonConfig: news.commonConfig,
              searchEngineConfig,
              dataStoreIds,
            },
          });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* discoveryengine
        .deleteProjectsLocationsCollectionsEngines({ name: output.name })
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
