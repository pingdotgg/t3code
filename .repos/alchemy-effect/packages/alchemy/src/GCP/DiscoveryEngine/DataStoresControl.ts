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
  expandDataStore,
  fingerprint,
  parseResourceName,
  toPhysical,
} from "./internal.ts";

export type DataStoresControlQueryTerm = {
  /** Query value to match. Must be lowercase UTF-8. */
  value: string;
  /**
   * Whether the search query must exactly match the term.
   * @default false
   */
  fullMatch?: boolean;
};

export type DataStoresControlTimeRange = {
  /** Inclusive start of the active window (RFC3339). */
  startTime?: string;
  /** Inclusive end of the active window (RFC3339). */
  endTime?: string;
};

export type DataStoresControlCondition = {
  /** Query regex matching the whole search query. */
  queryRegex?: string;
  /** Query terms to match. Maximum 10. */
  queryTerms?: DataStoresControlQueryTerm[];
  /** Active time windows. Maximum 10. */
  activeTimeRange?: DataStoresControlTimeRange[];
};

export type DataStoresControlRedirectAction = {
  /** URI to redirect the shopper to (max 2000 characters). */
  redirectUri: string;
};

export type DataStoresControlFilterAction = {
  /** Filter expression applied to matching results. */
  filter: string;
  /** Data store whose documents can be filtered. Defaults to the parent. */
  dataStore?: string;
};

export type DataStoresControlSynonymsAction = {
  /** Synonym set. At least 2, at most 100. */
  synonyms: string[];
};

export type DataStoresControlBoostAction = {
  /** Filter selecting documents to boost. */
  filter?: string;
  /** Data store whose documents can be boosted. Defaults to the parent. */
  dataStore?: string;
  /** Boost strength in `[-1, 1]`. Negative values demote. */
  boost?: number;
  /** Fixed boost strength in `[-1, 1]`. */
  fixedBoost?: number;
};

export type DataStoresControlPromoteAction = {
  /** Data store this promotion is attached to. Defaults to the parent. */
  dataStore?: string;
  /** Promotion title (max 160 characters). */
  title: string;
  /** Promotion URI. */
  uri?: string;
  /** Promotion description (max 200 characters). */
  description?: string;
  /** Thumbnail image URI. */
  imageUri?: string;
  /** Document resource name to promote. */
  document?: string;
  /**
   * Whether the promotion is enabled.
   * @default true
   */
  enabled?: boolean;
};

export type DataStoresControlProps = {
  /**
   * Parent Data Store resource name
   * `projects/{project}/locations/{location}/dataStores/{dataStore}`.
   * Immutable — changing it replaces the control.
   */
  dataStore: string;
  /**
   * Control id (1-63 characters, `a-z`, `_`, `-`). If omitted, a unique
   * id is generated. Immutable — changing it replaces the control.
   */
  controlId?: string;
  /**
   * Human-readable name (max 128 characters).
   */
  displayName?: string;
  /**
   * Solution this control belongs to. Immutable — changing it replaces
   * the control.
   * @default "SOLUTION_TYPE_SEARCH"
   */
  solutionType?: string;
  /**
   * Search use cases. Required when `solutionType` is
   * `SOLUTION_TYPE_SEARCH`.
   * @default ["SEARCH_USE_CASE_SEARCH"]
   */
  useCases?: string[];
  /**
   * Conditions that trigger the action. Omit to always apply.
   */
  conditions?: DataStoresControlCondition[];
  /** Redirect-type action. Mutually exclusive with the other actions. */
  redirectAction?: DataStoresControlRedirectAction;
  /** Filter-type action. Mutually exclusive with the other actions. */
  filterAction?: DataStoresControlFilterAction;
  /** Synonyms-type action. Mutually exclusive with the other actions. */
  synonymsAction?: DataStoresControlSynonymsAction;
  /** Boost-type action. Mutually exclusive with the other actions. */
  boostAction?: DataStoresControlBoostAction;
  /** Promote-type action. Mutually exclusive with the other actions. */
  promoteAction?: DataStoresControlPromoteAction;
};

export type DataStoresControl = Resource<
  "GCP.DiscoveryEngine.DataStoresControl",
  DataStoresControlProps,
  {
    /** Full resource name `.../dataStores/{dataStore}/controls/{control}`. */
    name: string;
    /** Control id (last path segment). */
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
    /** Serving configs this control is attached to. */
    associatedServingConfigIds: string[];
  },
  never,
  Providers
>;

/**
 * A Vertex AI Search Control attached to a Data Store.
 *
 * Without labels, ownership rests on the deterministic id: `read` reports a
 * resource it finds without prior state as unowned (adopt it with `--adopt`).
 * Parent, control id, solution type, and action kind are immutable; display
 * name, conditions, and action payload update in place.
 *
 * ### Creating a Control
 * **Example:** Synonym control
 * ```typescript
 * const control = yield* GCP.DiscoveryEngine.DataStoresControl("Synonyms", {
 *   dataStore: dataStore.name,
 *   displayName: "happy-glad",
 *   synonymsAction: { synonyms: ["happy", "glad"] },
 * });
 * ```
 *
 * ### Updating a Control
 * **Example:** Rename and expand the synonym set
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const control = yield* GCP.DiscoveryEngine.DataStoresControl("Synonyms", {
 *   dataStore: dataStore.name,
 *   displayName: "mood",
 *   synonymsAction: { synonyms: ["happy", "glad", "cheerful"] },
 * });
 * ```
 *
 * @resource
 * @category DiscoveryEngine
 */
export const DataStoresControl = Resource<DataStoresControl>(
  "GCP.DiscoveryEngine.DataStoresControl",
);

export class DataStoresControlNotResolved extends Data.TaggedError(
  "GCP.DiscoveryEngine.DataStoresControlNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_SOLUTION = "SOLUTION_TYPE_SEARCH";
const DEFAULT_USE_CASES = ["SEARCH_USE_CASE_SEARCH"];

const resourceName = (dataStore: string, controlId: string) =>
  `${dataStore}/controls/${controlId}`;

const actionKind = (props: {
  redirectAction?: unknown;
  filterAction?: unknown;
  synonymsAction?: unknown;
  boostAction?: unknown;
  promoteAction?: unknown;
}) => {
  if (props.redirectAction) return "redirect";
  if (props.filterAction) return "filter";
  if (props.synonymsAction) return "synonyms";
  if (props.boostAction) return "boost";
  if (props.promoteAction) return "promote";
  return "none";
};

const toBody = (
  news: DataStoresControlProps,
  displayName: string,
): discoveryengine.GoogleCloudDiscoveryengineV1Control => ({
  displayName,
  solutionType: news.solutionType ?? DEFAULT_SOLUTION,
  useCases: news.useCases ?? DEFAULT_USE_CASES,
  conditions: news.conditions,
  redirectAction: news.redirectAction,
  filterAction: news.filterAction
    ? {
        filter: news.filterAction.filter,
        dataStore: news.filterAction.dataStore ?? news.dataStore,
      }
    : undefined,
  synonymsAction: news.synonymsAction,
  boostAction: news.boostAction
    ? {
        filter: news.boostAction.filter,
        dataStore: news.boostAction.dataStore ?? news.dataStore,
        boost: news.boostAction.boost,
        fixedBoost: news.boostAction.fixedBoost,
      }
    : undefined,
  promoteAction: news.promoteAction
    ? {
        dataStore: news.promoteAction.dataStore ?? news.dataStore,
        searchLinkPromotion: {
          title: news.promoteAction.title,
          uri: news.promoteAction.uri,
          description: news.promoteAction.description,
          imageUri: news.promoteAction.imageUri,
          document: news.promoteAction.document,
          enabled: news.promoteAction.enabled,
        },
      }
    : undefined,
});

const toAttrs = (
  control: discoveryengine.GoogleCloudDiscoveryengineV1Control,
  project: string,
  dataStoreHint?: string,
) => {
  const name = control.name ?? "";
  const parsed = parseResourceName(name, "controls");
  const dataStore = parsed.dataStore.includes("/dataStores/")
    ? parsed.dataStore
    : (dataStoreHint ?? parsed.dataStore);
  return {
    name,
    controlId: parsed.id,
    dataStore,
    project: parsed.project || project,
    location: parsed.location,
    displayName: control.displayName,
    solutionType: control.solutionType,
    useCases: [...(control.useCases ?? [])],
    associatedServingConfigIds: [...(control.associatedServingConfigIds ?? [])],
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : discoveryengine
        .getProjectsLocationsDataStoresControls({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const DataStoresControlProvider = () =>
  Provider.succeed(DataStoresControl, {
    stables: ["name", "controlId", "dataStore", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.dataStore ?? output?.dataStore;
      if (previousParent !== undefined && news.dataStore !== previousParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.controlId ?? output?.controlId;
      if (
        previousId !== undefined &&
        news.controlId !== undefined &&
        news.controlId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousSolution =
        olds?.solutionType ?? output?.solutionType ?? DEFAULT_SOLUTION;
      const nextSolution = news.solutionType ?? previousSolution;
      if (previousSolution !== nextSolution) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousKind = actionKind(olds ?? {});
      const nextKind = actionKind(news);
      if (previousKind !== "none" && nextKind !== previousKind) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousAction = fingerprint({
        redirectAction: olds?.redirectAction,
        filterAction: olds?.filterAction,
        synonymsAction: olds?.synonymsAction,
        boostAction: olds?.boostAction,
        promoteAction: olds?.promoteAction,
      });
      const nextAction = fingerprint({
        redirectAction: news.redirectAction,
        filterAction: news.filterAction,
        synonymsAction: news.synonymsAction,
        boostAction: news.boostAction,
        promoteAction: news.promoteAction,
      });
      if (previousKind !== "none" && previousAction !== nextAction) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const controlId = yield* toPhysical(
        id,
        olds?.controlId,
        output?.controlId,
        controlIdOf,
      );
      const parent = olds?.dataStore
        ? expandDataStore(
            olds.dataStore,
            env.project,
            output?.location ?? "global",
          )
        : undefined;
      const name =
        output?.name ?? (parent ? resourceName(parent, controlId) : "");
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
      const controlId = yield* toPhysical(
        id,
        news.controlId,
        output?.controlId,
        controlIdOf,
      );
      const name = resourceName(parent, controlId);
      const displayName = news.displayName ?? controlId;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsDataStoresControls({
            parent,
            controlId,
            body: toBody(news, displayName),
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DataStoresControlNotResolved({ name });
      }

      const desired = toBody(news, displayName);
      const displayChanged = (current.displayName ?? "") !== displayName;
      const useCasesChanged =
        fingerprint([...(current.useCases ?? [])].sort()) !==
        fingerprint([...(desired.useCases ?? [])].sort());
      const conditionsChanged =
        fingerprint(current.conditions) !== fingerprint(desired.conditions);
      if (displayChanged || useCasesChanged || conditionsChanged) {
        current =
          yield* discoveryengine.patchProjectsLocationsDataStoresControls({
            name: current.name ?? name,
            updateMask: [
              displayChanged ? "display_name" : undefined,
              useCasesChanged ? "use_cases" : undefined,
              conditionsChanged ? "conditions" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: { ...desired, name: current.name ?? name },
          });
      }

      return toAttrs(current, env.project, parent);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      yield* discoveryengine
        .deleteProjectsLocationsDataStoresControls({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
