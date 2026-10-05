import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  parentBefore,
  parseResourceName,
  sameStringList,
  servingConfigId,
} from "./internal.ts";

export type CollectionsEnginesServingConfigProps = {
  /**
   * Parent Engine resource name
   * `projects/{project}/locations/{location}/collections/{collection}/engines/{engine}`.
   * Immutable — changing it replaces the serving config.
   */
  engine: string;
  /**
   * Serving config id (4-63 alphanumeric characters). If omitted, a
   * unique id is generated. Immutable — changing it replaces the
   * serving config.
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
  solutionType?: discoveryengine.GoogleCloudDiscoveryengineV1ServingConfigSolutionTypeEnum;
  /**
   * Custom ranking expression.
   */
  rankingExpression?: string;
  /**
   * Recommendation model id. Required for `SOLUTION_TYPE_RECOMMENDATION`.
   */
  modelId?: string;
  /**
   * Diversity level for recommendation results.
   */
  diversityLevel?: string;
  /**
   * Boost control ids applied at serving time.
   */
  boostControlIds?: string[];
  /**
   * Filter control ids applied at serving time.
   */
  filterControlIds?: string[];
  /**
   * Synonyms control ids.
   */
  synonymsControlIds?: string[];
  /**
   * Redirect control ids.
   */
  redirectControlIds?: string[];
};

export type CollectionsEnginesServingConfig = Resource<
  "GCP.DiscoveryEngine.CollectionsEnginesServingConfig",
  CollectionsEnginesServingConfigProps,
  {
    /** Full resource name. */
    name: string;
    /** Serving config id (last path segment). */
    servingConfigId: string;
    /** Parent engine resource name. */
    engine: string;
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
    /** Ranking expression. */
    rankingExpression: string | undefined;
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
 * A Discovery Engine ServingConfig on a collection Engine.
 *
 * Without labels, ownership rests on the deterministic id: `read` reports a
 * resource it finds without prior state as unowned (adopt it with `--adopt`).
 * Additional serving configs are API-only (the console uses the default).
 * Parent engine, id, and solution type are immutable; display name, ranking,
 * and control lists update in place.
 *
 * ### Creating a Serving Config
 * **Example:** Extra search serving config
 * ```typescript
 * const serving =
 *   yield* GCP.DiscoveryEngine.CollectionsEnginesServingConfig("Primary", {
 *     engine: engine.name,
 *     displayName: "primary",
 *   });
 * ```
 *
 * ### Updating a Serving Config
 * **Example:** Rename
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const serving =
 *   yield* GCP.DiscoveryEngine.CollectionsEnginesServingConfig("Primary", {
 *     engine: engine.name,
 *     displayName: "primary-prod",
 *   });
 * ```
 *
 * @resource
 * @category DiscoveryEngine
 */
export const CollectionsEnginesServingConfig =
  Resource<CollectionsEnginesServingConfig>(
    "GCP.DiscoveryEngine.CollectionsEnginesServingConfig",
  );

export class CollectionsEnginesServingConfigNotResolved extends Data.TaggedError(
  "GCP.DiscoveryEngine.CollectionsEnginesServingConfigNotResolved",
)<{
  name: string;
}> {}

const resourceName = (engine: string, servingConfigId: string) =>
  `${engine}/servingConfigs/${servingConfigId}`;

const solutionOf = (
  value:
    | discoveryengine.GoogleCloudDiscoveryengineV1ServingConfigSolutionTypeEnum
    | undefined,
) => value ?? "SOLUTION_TYPE_SEARCH";

const toId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return servingConfigId(explicit);
    if (existing !== undefined) return existing;
    return servingConfigId(
      yield* createPhysicalName({
        id,
        maxLength: 63,
        lowercase: true,
      }),
    );
  });

const getByName = (name: string) =>
  discoveryengine
    .getProjectsLocationsCollectionsEnginesServingConfigs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toAttrs = (
  config: discoveryengine.GoogleCloudDiscoveryengineV1ServingConfig,
  project: string,
) => {
  const name = config.name ?? "";
  const parsed = parseResourceName(name, "servingConfigs");
  return {
    name,
    servingConfigId: parsed.id,
    engine: parentBefore(name, "servingConfigs"),
    project: parsed.project || project,
    location: parsed.location,
    collectionId: parsed.collectionId,
    displayName: config.displayName,
    solutionType: config.solutionType,
    rankingExpression: config.rankingExpression,
    modelId: config.modelId,
    createTime: config.createTime,
    updateTime: config.updateTime,
  };
};

export const CollectionsEnginesServingConfigProvider = () =>
  Provider.succeed(CollectionsEnginesServingConfig, {
    stables: [
      "name",
      "servingConfigId",
      "engine",
      "project",
      "location",
      "collectionId",
      "solutionType",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousEngine = olds?.engine ?? output?.engine;
      const previousId = olds?.servingConfigId ?? output?.servingConfigId;
      const nextId = news.servingConfigId ?? previousId;
      const previousSolution = solutionOf(
        olds?.solutionType ??
          (output?.solutionType as CollectionsEnginesServingConfigProps["solutionType"]),
      );
      const nextSolution = solutionOf(
        news.solutionType ??
          (output?.solutionType as CollectionsEnginesServingConfigProps["solutionType"]),
      );
      if (
        (previousEngine !== undefined && news.engine !== previousEngine) ||
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousSolution !== nextSolution
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const engine = olds?.engine ?? output?.engine;
      const idValue = yield* toId(
        id,
        olds?.servingConfigId,
        output?.servingConfigId,
      );
      const name =
        output?.name ??
        (engine !== undefined ? resourceName(engine, idValue) : undefined);
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const idValue = yield* toId(
        id,
        news.servingConfigId,
        output?.servingConfigId,
      );
      const displayName = news.displayName ?? idValue;
      const solutionType = solutionOf(news.solutionType);
      const fallbackName = output?.name ?? resourceName(news.engine, idValue);

      let current = yield* getByName(fallbackName);

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsCollectionsEnginesServingConfigs({
            parent: news.engine,
            servingConfigId: idValue,
            body: {
              displayName,
              solutionType,
              rankingExpression: news.rankingExpression,
              modelId: news.modelId,
              diversityLevel: news.diversityLevel,
              boostControlIds: news.boostControlIds,
              filterControlIds: news.filterControlIds,
              synonymsControlIds: news.synonymsControlIds,
              redirectControlIds: news.redirectControlIds,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(fallbackName)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CollectionsEnginesServingConfigNotResolved({
          name: fallbackName,
        });
      }

      const name = current.name ?? fallbackName;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const rankingChanged =
        (current.rankingExpression ?? "") !== (news.rankingExpression ?? "");
      const modelChanged = (current.modelId ?? "") !== (news.modelId ?? "");
      const diversityChanged =
        (current.diversityLevel ?? "") !== (news.diversityLevel ?? "");
      const boostChanged = !sameStringList(
        current.boostControlIds,
        news.boostControlIds,
      );
      const filterChanged = !sameStringList(
        current.filterControlIds,
        news.filterControlIds,
      );
      const synonymsChanged = !sameStringList(
        current.synonymsControlIds,
        news.synonymsControlIds,
      );
      const redirectChanged = !sameStringList(
        current.redirectControlIds,
        news.redirectControlIds,
      );

      if (
        displayNameChanged ||
        rankingChanged ||
        modelChanged ||
        diversityChanged ||
        boostChanged ||
        filterChanged ||
        synonymsChanged ||
        redirectChanged
      ) {
        current =
          yield* discoveryengine.patchProjectsLocationsCollectionsEnginesServingConfigs(
            {
              name,
              updateMask: [
                displayNameChanged ? "display_name" : undefined,
                rankingChanged ? "ranking_expression" : undefined,
                modelChanged ? "model_id" : undefined,
                diversityChanged ? "diversity_level" : undefined,
                boostChanged ? "boost_control_ids" : undefined,
                filterChanged ? "filter_control_ids" : undefined,
                synonymsChanged ? "synonyms_control_ids" : undefined,
                redirectChanged ? "redirect_control_ids" : undefined,
              ]
                .filter((field): field is string => field !== undefined)
                .join(","),
              body: {
                name,
                displayName,
                rankingExpression: news.rankingExpression,
                modelId: news.modelId,
                diversityLevel: news.diversityLevel,
                boostControlIds: news.boostControlIds,
                filterControlIds: news.filterControlIds,
                synonymsControlIds: news.synonymsControlIds,
                redirectControlIds: news.redirectControlIds,
              },
            },
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      yield* discoveryengine
        .deleteProjectsLocationsCollectionsEnginesServingConfigs({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
