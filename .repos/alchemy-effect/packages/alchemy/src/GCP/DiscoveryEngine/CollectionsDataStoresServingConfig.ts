import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  parentOf,
  parseResourceName,
  sameStringList,
  servingConfigIdOf,
  toPhysical,
} from "./internal.ts";

export type CollectionsDataStoresServingConfigProps = {
  /**
   * Parent data store resource name. Immutable — changing it replaces
   * the serving config.
   */
  dataStore: string;
  /**
   * Serving config id (4-63 characters, `[a-zA-Z0-9_]`). If omitted, a
   * unique id is generated. Immutable — changing it replaces the serving
   * config.
   */
  servingConfigId?: string;
  /**
   * Human-readable name (max 128 characters).
   */
  displayName?: string;
  /**
   * Solution type. Immutable.
   * @default "SOLUTION_TYPE_SEARCH"
   */
  solutionType?:
    | "SOLUTION_TYPE_UNSPECIFIED"
    | "SOLUTION_TYPE_RECOMMENDATION"
    | "SOLUTION_TYPE_SEARCH"
    | "SOLUTION_TYPE_CHAT"
    | "SOLUTION_TYPE_GENERATIVE_CHAT"
    | "SOLUTION_TYPE_AI_MODE"
    | (string & {});
  /**
   * Filter control ids applied at serving time.
   */
  filterControlIds?: string[];
  /**
   * Boost control ids applied at serving time.
   */
  boostControlIds?: string[];
  /**
   * Redirect control ids.
   */
  redirectControlIds?: string[];
  /**
   * Synonyms control ids.
   */
  synonymsControlIds?: string[];
  /**
   * Ranking expression, e.g. `0.5 * relevance_score`.
   */
  rankingExpression?: string;
  /**
   * Recommendation diversity level.
   */
  diversityLevel?: string;
  /**
   * Recommendation model id. Required for `SOLUTION_TYPE_RECOMMENDATION`.
   */
  modelId?: string;
};

export type CollectionsDataStoresServingConfig = Resource<
  "GCP.DiscoveryEngine.CollectionsDataStoresServingConfig",
  CollectionsDataStoresServingConfigProps,
  {
    /** Full resource name. */
    name: string;
    /** Serving config id. */
    servingConfigId: string;
    /** Parent data store resource name. */
    dataStore: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Solution type. */
    solutionType: string | undefined;
    /** Filter control ids. */
    filterControlIds: string[];
    /** Boost control ids. */
    boostControlIds: string[];
    /** Redirect control ids. */
    redirectControlIds: string[];
    /** Synonyms control ids. */
    synonymsControlIds: string[];
    /** Ranking expression. */
    rankingExpression: string | undefined;
    /** Diversity level. */
    diversityLevel: string | undefined;
    /** Model id. */
    modelId: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Discovery Engine serving config on a collection data store.
 *
 * Without labels, ownership rests on the deterministic id: `read` reports a
 * resource it finds without prior state as unowned (adopt it with `--adopt`).
 * Parent, serving config id, and solution type are immutable. Display name
 * and control-id lists update in place.
 *
 * ### Creating a Serving Config
 * **Example:** Extra search serving config
 * ```typescript
 * const store = yield* GCP.DiscoveryEngine.CollectionsDataStore("Docs", {});
 * const serving = yield* GCP.DiscoveryEngine.CollectionsDataStoresServingConfig(
 *   "Preview",
 *   {
 *     dataStore: store.name,
 *     displayName: "preview search",
 *   },
 * );
 * ```
 *
 * @resource
 * @category DiscoveryEngine
 */
export const CollectionsDataStoresServingConfig =
  Resource<CollectionsDataStoresServingConfig>(
    "GCP.DiscoveryEngine.CollectionsDataStoresServingConfig",
  );

export class CollectionsDataStoresServingConfigNotResolved extends Data.TaggedError(
  "GCP.DiscoveryEngine.CollectionsDataStoresServingConfigNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  config: discoveryengine.GoogleCloudDiscoveryengineV1ServingConfig,
  project: string,
) => {
  const name = config.name ?? "";
  const parsed = parseResourceName(name, "servingConfigs");
  return {
    name,
    servingConfigId: parsed.id,
    dataStore: parentOf(name, "servingConfigs"),
    project: parsed.project || project,
    location: parsed.location,
    displayName: config.displayName,
    solutionType: config.solutionType,
    filterControlIds: [...(config.filterControlIds ?? [])],
    boostControlIds: [...(config.boostControlIds ?? [])],
    redirectControlIds: [...(config.redirectControlIds ?? [])],
    synonymsControlIds: [...(config.synonymsControlIds ?? [])],
    rankingExpression: config.rankingExpression,
    diversityLevel: config.diversityLevel,
    modelId: config.modelId,
    createTime: config.createTime,
    updateTime: config.updateTime,
  };
};

const resourceName = (dataStore: string, servingConfigId: string) =>
  `${dataStore}/servingConfigs/${servingConfigId}`;

const toBody = (
  news: CollectionsDataStoresServingConfigProps,
  displayName: string,
): discoveryengine.GoogleCloudDiscoveryengineV1ServingConfig => ({
  displayName,
  solutionType: news.solutionType ?? "SOLUTION_TYPE_SEARCH",
  filterControlIds: news.filterControlIds,
  boostControlIds: news.boostControlIds,
  redirectControlIds: news.redirectControlIds,
  synonymsControlIds: news.synonymsControlIds,
  rankingExpression: news.rankingExpression,
  diversityLevel: news.diversityLevel,
  modelId: news.modelId,
});

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : discoveryengine
        .getProjectsLocationsCollectionsDataStoresServingConfigs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const CollectionsDataStoresServingConfigProvider = () =>
  Provider.succeed(CollectionsDataStoresServingConfig, {
    stables: [
      "name",
      "servingConfigId",
      "dataStore",
      "project",
      "location",
      "solutionType",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.dataStore ?? output?.dataStore;
      const previousId = olds?.servingConfigId ?? output?.servingConfigId;
      const previousType = olds?.solutionType ?? output?.solutionType;
      const nextType = news.solutionType ?? previousType;
      if (
        (previousParent !== undefined && news.dataStore !== previousParent) ||
        (previousId !== undefined &&
          news.servingConfigId !== undefined &&
          news.servingConfigId !== previousId) ||
        (previousType !== undefined &&
          nextType !== undefined &&
          previousType !== nextType)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousParent === news.dataStore &&
            previousId !== undefined &&
            news.servingConfigId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = olds?.dataStore ?? output?.dataStore;
      const childId = yield* toPhysical(
        id,
        olds?.servingConfigId,
        output?.servingConfigId,
        servingConfigIdOf,
      );
      const name =
        output?.name ??
        (parent !== undefined ? resourceName(parent, childId) : undefined);
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const servingConfigId = yield* toPhysical(
        id,
        news.servingConfigId,
        output?.servingConfigId,
        servingConfigIdOf,
      );
      const name = resourceName(news.dataStore, servingConfigId);
      const displayName = news.displayName ?? servingConfigId;
      const body = toBody(news, displayName);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsCollectionsDataStoresServingConfigs({
            parent: news.dataStore,
            servingConfigId,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CollectionsDataStoresServingConfigNotResolved({
          name,
        });
      }

      const resource = current.name ?? name;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const filterChanged = !sameStringList(
        current.filterControlIds,
        news.filterControlIds,
      );
      const boostChanged = !sameStringList(
        current.boostControlIds,
        news.boostControlIds,
      );
      const redirectChanged = !sameStringList(
        current.redirectControlIds,
        news.redirectControlIds,
      );
      const synonymsChanged = !sameStringList(
        current.synonymsControlIds,
        news.synonymsControlIds,
      );
      const rankingChanged =
        (current.rankingExpression ?? "") !== (news.rankingExpression ?? "");
      const diversityChanged =
        (current.diversityLevel ?? "") !== (news.diversityLevel ?? "");
      const modelChanged = (current.modelId ?? "") !== (news.modelId ?? "");

      if (
        displayNameChanged ||
        filterChanged ||
        boostChanged ||
        redirectChanged ||
        synonymsChanged ||
        rankingChanged ||
        diversityChanged ||
        modelChanged
      ) {
        current =
          yield* discoveryengine.patchProjectsLocationsCollectionsDataStoresServingConfigs(
            {
              name: resource,
              updateMask: [
                displayNameChanged ? "display_name" : undefined,
                filterChanged ? "filter_control_ids" : undefined,
                boostChanged ? "boost_control_ids" : undefined,
                redirectChanged ? "redirect_control_ids" : undefined,
                synonymsChanged ? "synonyms_control_ids" : undefined,
                rankingChanged ? "ranking_expression" : undefined,
                diversityChanged ? "diversity_level" : undefined,
                modelChanged ? "model_id" : undefined,
              ]
                .filter((field): field is string => field !== undefined)
                .join(","),
              body: { ...body, name: resource },
            },
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discoveryengine
        .deleteProjectsLocationsCollectionsDataStoresServingConfigs({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
