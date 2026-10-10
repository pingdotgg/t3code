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
  controlIdOf,
  parentOf,
  parseResourceName,
  sameJson,
  sameStringList,
  toPhysical,
} from "./internal.ts";

export type ControlCondition = {
  /** Query regex. Cannot be set together with `queryTerms`. */
  queryRegex?: string;
  /** Query terms to match. */
  queryTerms?: Array<{
    value: string;
    fullMatch?: boolean;
  }>;
};

export type CollectionsDataStoresControlProps = {
  /**
   * Parent data store resource name. Immutable — changing it replaces
   * the control.
   */
  dataStore: string;
  /**
   * Control id (`[a-z-_]`, 1-63 characters). If omitted, a unique id is
   * generated. Immutable — changing it replaces the control.
   */
  controlId?: string;
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
   * Search use cases. Required when `solutionType` is
   * `SOLUTION_TYPE_SEARCH`.
   * @default ["SEARCH_USE_CASE_SEARCH"]
   */
  useCases?: Array<
    | "SEARCH_USE_CASE_UNSPECIFIED"
    | "SEARCH_USE_CASE_SEARCH"
    | "SEARCH_USE_CASE_BROWSE"
    | (string & {})
  >;
  /**
   * Synonym set (at least two terms).
   */
  synonyms?: string[];
  /**
   * Redirect URI for a redirect control.
   */
  redirectUri?: string;
  /**
   * Filter expression for a filter control.
   */
  filter?: string;
  /**
   * Data store name the filter applies to. Defaults to `dataStore`.
   */
  filterDataStore?: string;
  /**
   * Trigger conditions. Omit to always apply the action.
   */
  conditions?: ControlCondition[];
};

export type CollectionsDataStoresControl = Resource<
  "GCP.DiscoveryEngine.CollectionsDataStoresControl",
  CollectionsDataStoresControlProps,
  {
    /** Full resource name. */
    name: string;
    /** Control id. */
    controlId: string;
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
    /** Search use cases. */
    useCases: string[];
    /** Synonym set. */
    synonyms: string[];
    /** Redirect URI. */
    redirectUri: string | undefined;
    /** Filter expression. */
    filter: string | undefined;
    /** Serving configs this control is attached to. */
    associatedServingConfigIds: string[];
  },
  never,
  Providers
>;

/**
 * A Discovery Engine serving control on a collection data store.
 *
 * Without labels, ownership rests on the deterministic id: `read` reports a
 * resource it finds without prior state as unowned (adopt it with `--adopt`).
 * Parent, control id, and solution type are immutable. Display name,
 * synonyms, redirect, filter, and conditions update in place.
 *
 * ### Creating a Control
 * **Example:** Synonym control
 * ```typescript
 * const store = yield* GCP.DiscoveryEngine.CollectionsDataStore("Docs", {});
 * const control = yield* GCP.DiscoveryEngine.CollectionsDataStoresControl(
 *   "Greetings",
 *   {
 *     dataStore: store.name,
 *     displayName: "greetings",
 *     synonyms: ["hello", "hi"],
 *   },
 * );
 * ```
 *
 * @resource
 * @category DiscoveryEngine
 */
export const CollectionsDataStoresControl =
  Resource<CollectionsDataStoresControl>(
    "GCP.DiscoveryEngine.CollectionsDataStoresControl",
  );

export class CollectionsDataStoresControlNotResolved extends Data.TaggedError(
  "GCP.DiscoveryEngine.CollectionsDataStoresControlNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  control: discoveryengine.GoogleCloudDiscoveryengineV1Control,
  project: string,
) => {
  const name = control.name ?? "";
  const parsed = parseResourceName(name, "controls");
  return {
    name,
    controlId: parsed.id,
    dataStore: parentOf(name, "controls"),
    project: parsed.project || project,
    location: parsed.location,
    displayName: control.displayName,
    solutionType: control.solutionType,
    useCases: [...(control.useCases ?? [])],
    synonyms: [...(control.synonymsAction?.synonyms ?? [])],
    redirectUri: control.redirectAction?.redirectUri,
    filter: control.filterAction?.filter,
    associatedServingConfigIds: [...(control.associatedServingConfigIds ?? [])],
  };
};

const resourceName = (dataStore: string, controlId: string) =>
  `${dataStore}/controls/${controlId}`;

const toBody = (
  news: CollectionsDataStoresControlProps,
  displayName: string,
): discoveryengine.GoogleCloudDiscoveryengineV1Control => ({
  displayName,
  solutionType: news.solutionType ?? "SOLUTION_TYPE_SEARCH",
  useCases: news.useCases ?? ["SEARCH_USE_CASE_SEARCH"],
  synonymsAction:
    news.synonyms && news.synonyms.length > 0
      ? { synonyms: news.synonyms }
      : undefined,
  redirectAction: news.redirectUri
    ? { redirectUri: news.redirectUri }
    : undefined,
  filterAction: news.filter
    ? {
        filter: news.filter,
        dataStore: news.filterDataStore ?? news.dataStore,
      }
    : undefined,
  conditions: news.conditions,
});

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : discoveryengine
        .getProjectsLocationsCollectionsDataStoresControls({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const CollectionsDataStoresControlProvider = () =>
  Provider.succeed(CollectionsDataStoresControl, {
    stables: [
      "name",
      "controlId",
      "dataStore",
      "project",
      "location",
      "solutionType",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.dataStore ?? output?.dataStore;
      const previousId = olds?.controlId ?? output?.controlId;
      const previousType = olds?.solutionType ?? output?.solutionType;
      const nextType = news.solutionType ?? previousType;
      if (
        (previousParent !== undefined && news.dataStore !== previousParent) ||
        (previousId !== undefined &&
          news.controlId !== undefined &&
          news.controlId !== previousId) ||
        (previousType !== undefined &&
          nextType !== undefined &&
          previousType !== nextType)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousParent === news.dataStore &&
            previousId !== undefined &&
            news.controlId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = olds?.dataStore ?? output?.dataStore;
      const childId = yield* toPhysical(
        id,
        olds?.controlId,
        output?.controlId,
        controlIdOf,
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
      const controlId = yield* toPhysical(
        id,
        news.controlId,
        output?.controlId,
        controlIdOf,
      );
      const name = resourceName(news.dataStore, controlId);
      const displayName = news.displayName ?? controlId;
      const body = toBody(news, displayName);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsCollectionsDataStoresControls({
            parent: news.dataStore,
            controlId,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CollectionsDataStoresControlNotResolved({ name });
      }

      const resource = current.name ?? name;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const conditionsChanged = !sameJson(current.conditions, news.conditions);
      const useCasesChanged = !sameStringList(
        current.useCases,
        news.useCases ?? ["SEARCH_USE_CASE_SEARCH"],
      );

      if (displayNameChanged || conditionsChanged || useCasesChanged) {
        current =
          yield* discoveryengine.patchProjectsLocationsCollectionsDataStoresControls(
            {
              name: resource,
              updateMask: [
                displayNameChanged ? "display_name" : undefined,
                conditionsChanged ? "conditions" : undefined,
                useCasesChanged ? "use_cases" : undefined,
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
        .deleteProjectsLocationsCollectionsDataStoresControls({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
