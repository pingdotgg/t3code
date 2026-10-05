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
  parentBefore,
  parseResourceName,
  sameJson,
  sameStringList,
  toResourceId,
} from "./internal.ts";

export type CollectionsEnginesControlProps = {
  /**
   * Parent Engine resource name
   * `projects/{project}/locations/{location}/collections/{collection}/engines/{engine}`.
   * Immutable — changing it replaces the control.
   */
  engine: string;
  /**
   * Control id (1-63 characters, `a-z`, `_`, `-`). If omitted, a unique
   * id is generated. Immutable — changing it replaces the control.
   */
  controlId?: string;
  /**
   * Human-readable name.
   */
  displayName?: string;
  /**
   * Solution the control belongs to. Immutable.
   * @default "SOLUTION_TYPE_SEARCH"
   */
  solutionType?: discoveryengine.GoogleCloudDiscoveryengineV1ControlSolutionTypeEnum;
  /**
   * Use cases. Required when `solutionType` is `SOLUTION_TYPE_SEARCH`.
   * @default ["SEARCH_USE_CASE_SEARCH"]
   */
  useCases?: discoveryengine.GoogleCloudDiscoveryengineV1ControlUseCasesItemEnumList;
  /**
   * Conditions that must match before the action runs.
   */
  conditions?: discoveryengine.GoogleCloudDiscoveryengineV1ConditionList;
  /**
   * Redirect-type action.
   */
  redirectAction?: discoveryengine.GoogleCloudDiscoveryengineV1ControlRedirectAction;
  /**
   * Filter-type action.
   */
  filterAction?: discoveryengine.GoogleCloudDiscoveryengineV1ControlFilterAction;
  /**
   * Synonyms-type action.
   */
  synonymsAction?: discoveryengine.GoogleCloudDiscoveryengineV1ControlSynonymsAction;
  /**
   * Boost-type action.
   */
  boostAction?: discoveryengine.GoogleCloudDiscoveryengineV1ControlBoostAction;
  /**
   * Promote-type action.
   */
  promoteAction?: discoveryengine.GoogleCloudDiscoveryengineV1ControlPromoteAction;
};

export type CollectionsEnginesControl = Resource<
  "GCP.DiscoveryEngine.CollectionsEnginesControl",
  CollectionsEnginesControlProps,
  {
    /** Full resource name. */
    name: string;
    /** Control id (last path segment). */
    controlId: string;
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
    /** Use cases. */
    useCases: string[];
    /** Serving configs this control is attached to. */
    associatedServingConfigIds: string[];
  },
  never,
  Providers
>;

/**
 * A Discovery Engine Control on a collection Engine — redirects,
 * filters, synonyms, boosts, or promotions applied at serving time.
 *
 * Without labels, ownership rests on the deterministic id: `read` reports a
 * resource it finds without prior state as unowned (adopt it with `--adopt`).
 * Parent engine, control id, and solution type are immutable, and so is the
 * action (changing it replaces the control); display name, use cases, and
 * conditions update in place.
 *
 * ### Creating a Control
 * **Example:** Synonym control
 * ```typescript
 * const control = yield* GCP.DiscoveryEngine.CollectionsEnginesControl(
 *   "Synonyms",
 *   {
 *     engine: engine.name,
 *     displayName: "hello-hi",
 *     synonymsAction: { synonyms: ["hello", "hi"] },
 *   },
 * );
 * ```
 *
 * ### Updating a Control
 * **Example:** Change synonyms
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const control = yield* GCP.DiscoveryEngine.CollectionsEnginesControl(
 *   "Synonyms",
 *   {
 *     engine: engine.name,
 *     synonymsAction: { synonyms: ["hello", "hi", "hey"] },
 *   },
 * );
 * ```
 *
 * @resource
 * @category DiscoveryEngine
 */
export const CollectionsEnginesControl = Resource<CollectionsEnginesControl>(
  "GCP.DiscoveryEngine.CollectionsEnginesControl",
);

export class CollectionsEnginesControlNotResolved extends Data.TaggedError(
  "GCP.DiscoveryEngine.CollectionsEnginesControlNotResolved",
)<{
  name: string;
}> {}

const resourceName = (engine: string, controlId: string) =>
  `${engine}/controls/${controlId}`;

const solutionOf = (
  value:
    | discoveryengine.GoogleCloudDiscoveryengineV1ControlSolutionTypeEnum
    | undefined,
) => value ?? "SOLUTION_TYPE_SEARCH";

const useCasesOf = (
  value:
    | discoveryengine.GoogleCloudDiscoveryengineV1ControlUseCasesItemEnumList
    | undefined,
  solutionType: string,
):
  | discoveryengine.GoogleCloudDiscoveryengineV1ControlUseCasesItemEnumList
  | undefined => {
  if (value && value.length > 0) return value;
  if (solutionType === "SOLUTION_TYPE_SEARCH") {
    return ["SEARCH_USE_CASE_SEARCH"];
  }
  return undefined;
};

const getByName = (name: string) =>
  discoveryengine
    .getProjectsLocationsCollectionsEnginesControls({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toAttrs = (
  control: discoveryengine.GoogleCloudDiscoveryengineV1Control,
  project: string,
) => {
  const name = control.name ?? "";
  const parsed = parseResourceName(name, "controls");
  return {
    name,
    controlId: parsed.id,
    engine: parentBefore(name, "controls"),
    project: parsed.project || project,
    location: parsed.location,
    collectionId: parsed.collectionId,
    displayName: control.displayName,
    solutionType: control.solutionType,
    useCases: [...(control.useCases ?? [])],
    associatedServingConfigIds: [...(control.associatedServingConfigIds ?? [])],
  };
};

const bodyOf = (
  news: CollectionsEnginesControlProps,
  displayName: string,
  solutionType: discoveryengine.GoogleCloudDiscoveryengineV1ControlSolutionTypeEnum,
  useCases:
    | discoveryengine.GoogleCloudDiscoveryengineV1ControlUseCasesItemEnumList
    | undefined,
): discoveryengine.GoogleCloudDiscoveryengineV1Control => ({
  displayName,
  solutionType,
  useCases,
  conditions: news.conditions,
  redirectAction: news.redirectAction,
  filterAction: news.filterAction,
  synonymsAction: news.synonymsAction,
  boostAction: news.boostAction,
  promoteAction: news.promoteAction,
});

export const CollectionsEnginesControlProvider = () =>
  Provider.succeed(CollectionsEnginesControl, {
    stables: [
      "name",
      "controlId",
      "engine",
      "project",
      "location",
      "collectionId",
      "solutionType",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousEngine = olds?.engine ?? output?.engine;
      const previousId = olds?.controlId ?? output?.controlId;
      const nextId = news.controlId ?? previousId;
      const previousSolution = solutionOf(
        olds?.solutionType ??
          (output?.solutionType as CollectionsEnginesControlProps["solutionType"]),
      );
      const nextSolution = solutionOf(
        news.solutionType ??
          (output?.solutionType as CollectionsEnginesControlProps["solutionType"]),
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
      // A control's action is immutable ("updateMask contains an immutable
      // path synonyms_action"), so any action change replaces it.
      if (
        olds !== undefined &&
        (!sameJson(olds.redirectAction, news.redirectAction) ||
          !sameJson(olds.filterAction, news.filterAction) ||
          !sameJson(olds.synonymsAction, news.synonymsAction) ||
          !sameJson(olds.boostAction, news.boostAction) ||
          !sameJson(olds.promoteAction, news.promoteAction))
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = olds?.engine ?? output?.engine;
      const childId = yield* toResourceId(
        id,
        olds?.controlId,
        output?.controlId,
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
      const controlId = yield* toResourceId(
        id,
        news.controlId,
        output?.controlId,
      );
      const displayName = news.displayName ?? controlId;
      const solutionType = solutionOf(news.solutionType);
      const useCases = useCasesOf(news.useCases, solutionType);
      const fallbackName = output?.name ?? resourceName(news.engine, controlId);
      const desired = bodyOf(news, displayName, solutionType, useCases);

      let current = yield* getByName(fallbackName);

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsCollectionsEnginesControls({
            parent: news.engine,
            controlId,
            body: desired,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(fallbackName)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CollectionsEnginesControlNotResolved({
          name: fallbackName,
        });
      }

      const name = current.name ?? fallbackName;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const useCasesChanged = !sameStringList(current.useCases, useCases);
      const conditionsChanged = !sameJson(current.conditions, news.conditions);

      // Actions are immutable; diff replaces the control when they change.
      if (displayNameChanged || useCasesChanged || conditionsChanged) {
        current =
          yield* discoveryengine.patchProjectsLocationsCollectionsEnginesControls(
            {
              name,
              updateMask: [
                displayNameChanged ? "display_name" : undefined,
                useCasesChanged ? "use_cases" : undefined,
                conditionsChanged ? "conditions" : undefined,
              ]
                .filter((field): field is string => field !== undefined)
                .join(","),
              body: { name, ...desired },
            },
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      yield* discoveryengine
        .deleteProjectsLocationsCollectionsEnginesControls({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
