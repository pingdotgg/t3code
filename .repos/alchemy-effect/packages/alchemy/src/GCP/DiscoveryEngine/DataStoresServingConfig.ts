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
  expandDataStore,
  parseResourceName,
  sameStringList,
  servingConfigIdOf,
  toPhysical,
} from "./internal.ts";

export type DataStoresServingConfigProps = {
  /**
   * Parent Data Store resource name
   * `projects/{project}/locations/{location}/dataStores/{dataStore}`.
   * Immutable — changing it replaces the serving config.
   */
  dataStore: string;
  /**
   * Serving config id (4-63 characters, `a-zA-Z0-9`). If omitted, a
   * unique id is generated. Immutable — changing it replaces the config.
   */
  servingConfigId?: string;
  /**
   * Human-readable name (max 128 characters).
   */
  displayName?: string;
  /**
   * Solution type. Immutable — changing it replaces the config.
   * @default "SOLUTION_TYPE_SEARCH"
   */
  solutionType?: string;
  /**
   * Filter control ids applied on the serving path. Maximum 20.
   */
  filterControlIds?: string[];
  /**
   * Boost control ids applied on the serving path. Maximum 20.
   */
  boostControlIds?: string[];
  /**
   * Redirect control ids. Only the first triggered redirect is applied.
   */
  redirectControlIds?: string[];
  /**
   * Synonyms control ids.
   */
  synonymsControlIds?: string[];
  /**
   * One-way synonyms control ids.
   */
  onewaySynonymsControlIds?: string[];
  /**
   * Dissociate control ids.
   */
  dissociateControlIds?: string[];
  /**
   * Replacement control ids.
   */
  replacementControlIds?: string[];
  /**
   * Ignore control ids.
   */
  ignoreControlIds?: string[];
  /**
   * Promote control ids.
   */
  promoteControlIds?: string[];
  /**
   * Ranking expression, for example
   * `0.5 * relevance_score + 0.3 * dotProduct(doc_embedding)`.
   */
  rankingExpression?: string;
  /**
   * Recommendation model id. Required when `solutionType` is
   * `SOLUTION_TYPE_RECOMMENDATION`.
   */
  modelId?: string;
  /**
   * Diversity level for recommendation results
   * (`no-diversity`, `low-diversity`, `medium-diversity`,
   * `high-diversity`, `auto-diversity`).
   */
  diversityLevel?: string;
};

export type DataStoresServingConfig = Resource<
  "GCP.DiscoveryEngine.DataStoresServingConfig",
  DataStoresServingConfigProps,
  {
    /** Full resource name `.../dataStores/{dataStore}/servingConfigs/{id}`. */
    name: string;
    /** Serving config id (last path segment). */
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
    /** Ranking expression, if set. */
    rankingExpression: string | undefined;
    /** Recommendation model id, if set. */
    modelId: string | undefined;
    /** Diversity level, if set. */
    diversityLevel: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Search ServingConfig attached to a Data Store.
 *
 * Without labels, ownership rests on the deterministic id: `read` reports a
 * resource it finds without prior state as unowned (adopt it with `--adopt`).
 * Parent, id, and solution type are immutable; display name, attached
 * controls, and ranking update in place. The console only shows the default
 * serving config — additional configs are API-only.
 *
 * ### Creating a Serving Config
 * **Example:** Search serving config
 * ```typescript
 * const config = yield* GCP.DiscoveryEngine.DataStoresServingConfig("Search", {
 *   dataStore: dataStore.name,
 *   displayName: "web-search",
 *   solutionType: "SOLUTION_TYPE_SEARCH",
 * });
 * ```
 *
 * ### Updating a Serving Config
 * **Example:** Attach filter controls
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const config = yield* GCP.DiscoveryEngine.DataStoresServingConfig("Search", {
 *   dataStore: dataStore.name,
 *   displayName: "web-search",
 *   filterControlIds: [control.controlId],
 * });
 * ```
 *
 * @resource
 * @category DiscoveryEngine
 */
export const DataStoresServingConfig = Resource<DataStoresServingConfig>(
  "GCP.DiscoveryEngine.DataStoresServingConfig",
);

export class DataStoresServingConfigNotResolved extends Data.TaggedError(
  "GCP.DiscoveryEngine.DataStoresServingConfigNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_SOLUTION = "SOLUTION_TYPE_SEARCH";

const resourceName = (dataStore: string, servingConfigId: string) =>
  `${dataStore}/servingConfigs/${servingConfigId}`;

const toAttrs = (
  config: discoveryengine.GoogleCloudDiscoveryengineV1ServingConfig,
  project: string,
  dataStoreHint?: string,
) => {
  const name = config.name ?? "";
  const parsed = parseResourceName(name, "servingConfigs");
  const dataStore = parsed.dataStore.includes("/dataStores/")
    ? parsed.dataStore
    : (dataStoreHint ?? parsed.dataStore);
  return {
    name,
    servingConfigId: parsed.id,
    dataStore,
    project: parsed.project || project,
    location: parsed.location,
    displayName: config.displayName,
    solutionType: config.solutionType,
    filterControlIds: [...(config.filterControlIds ?? [])],
    boostControlIds: [...(config.boostControlIds ?? [])],
    rankingExpression: config.rankingExpression,
    modelId: config.modelId,
    diversityLevel: config.diversityLevel,
    createTime: config.createTime,
    updateTime: config.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : discoveryengine
        .getProjectsLocationsDataStoresServingConfigs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const DataStoresServingConfigProvider = () =>
  Provider.succeed(DataStoresServingConfig, {
    stables: [
      "name",
      "servingConfigId",
      "dataStore",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.dataStore ?? output?.dataStore;
      if (previousParent !== undefined && news.dataStore !== previousParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.servingConfigId ?? output?.servingConfigId;
      if (
        previousId !== undefined &&
        news.servingConfigId !== undefined &&
        news.servingConfigId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousSolution =
        olds?.solutionType ?? output?.solutionType ?? DEFAULT_SOLUTION;
      const nextSolution = news.solutionType ?? previousSolution;
      if (previousSolution !== nextSolution) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const servingConfigId = yield* toPhysical(
        id,
        olds?.servingConfigId,
        output?.servingConfigId,
        servingConfigIdOf,
      );
      const parent = olds?.dataStore
        ? expandDataStore(
            olds.dataStore,
            env.project,
            output?.location ?? "global",
          )
        : undefined;
      const name =
        output?.name ?? (parent ? resourceName(parent, servingConfigId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = expandDataStore(
        news.dataStore,
        env.project,
        output?.location ?? "global",
      );
      const servingConfigId = yield* toPhysical(
        id,
        news.servingConfigId,
        output?.servingConfigId,
        servingConfigIdOf,
      );
      const name = resourceName(parent, servingConfigId);
      const displayName = news.displayName ?? servingConfigId;
      const solutionType = news.solutionType ?? DEFAULT_SOLUTION;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsDataStoresServingConfigs({
            parent,
            servingConfigId,
            body: {
              displayName,
              solutionType,
              filterControlIds: news.filterControlIds,
              boostControlIds: news.boostControlIds,
              redirectControlIds: news.redirectControlIds,
              synonymsControlIds: news.synonymsControlIds,
              onewaySynonymsControlIds: news.onewaySynonymsControlIds,
              dissociateControlIds: news.dissociateControlIds,
              replacementControlIds: news.replacementControlIds,
              ignoreControlIds: news.ignoreControlIds,
              promoteControlIds: news.promoteControlIds,
              rankingExpression: news.rankingExpression,
              modelId: news.modelId,
              diversityLevel: news.diversityLevel,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DataStoresServingConfigNotResolved({ name });
      }

      const displayChanged = (current.displayName ?? "") !== displayName;
      const filterChanged = !sameStringList(
        current.filterControlIds,
        news.filterControlIds,
      );
      const boostChanged = !sameStringList(
        current.boostControlIds,
        news.boostControlIds,
      );
      const rankingChanged =
        (current.rankingExpression ?? "") !== (news.rankingExpression ?? "");
      const modelChanged = (current.modelId ?? "") !== (news.modelId ?? "");
      const diversityChanged =
        (current.diversityLevel ?? "") !== (news.diversityLevel ?? "");
      const redirectChanged = !sameStringList(
        current.redirectControlIds,
        news.redirectControlIds,
      );
      const synonymsChanged = !sameStringList(
        current.synonymsControlIds,
        news.synonymsControlIds,
      );

      if (
        displayChanged ||
        filterChanged ||
        boostChanged ||
        rankingChanged ||
        modelChanged ||
        diversityChanged ||
        redirectChanged ||
        synonymsChanged
      ) {
        current =
          yield* discoveryengine.patchProjectsLocationsDataStoresServingConfigs(
            {
              name: current.name ?? name,
              updateMask: [
                displayChanged ? "display_name" : undefined,
                filterChanged ? "filter_control_ids" : undefined,
                boostChanged ? "boost_control_ids" : undefined,
                rankingChanged ? "ranking_expression" : undefined,
                modelChanged ? "model_id" : undefined,
                diversityChanged ? "diversity_level" : undefined,
                redirectChanged ? "redirect_control_ids" : undefined,
                synonymsChanged ? "synonyms_control_ids" : undefined,
              ]
                .filter((field): field is string => field !== undefined)
                .join(","),
              body: {
                name: current.name ?? name,
                displayName,
                filterControlIds: news.filterControlIds,
                boostControlIds: news.boostControlIds,
                redirectControlIds: news.redirectControlIds,
                synonymsControlIds: news.synonymsControlIds,
                rankingExpression: news.rankingExpression,
                modelId: news.modelId,
                diversityLevel: news.diversityLevel,
              },
            },
          );
      }

      return toAttrs(current, env.project, parent);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      yield* discoveryengine
        .deleteProjectsLocationsDataStoresServingConfigs({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
