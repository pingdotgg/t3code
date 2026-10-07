import * as retail from "@distilled.cloud/gcp/retail_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  MAX_ID_LENGTH,
  expandCatalog,
  normalizeLocation,
  parseResourceName,
  replaceOnIdentity,
  sameJson,
  sameStringList,
  slugNoDigits,
  toPhysical,
  updateMaskOf,
} from "./internal.ts";

export type ControlCondition = {
  /** Query terms to match. */
  queryTerms?: Array<{
    value: string;
    fullMatch?: boolean;
  }>;
  /** Browse page categories. */
  pageCategories?: string[];
};

export type CatalogsControlProps = {
  /**
   * Parent catalog resource name
   * `projects/{project}/locations/{location}/catalogs/{catalog}` or a
   * catalog id (combined with `location`). Immutable — changing it
   * replaces the control.
   * @default "default_catalog"
   */
  catalog?: string;
  /**
   * Location used when `catalog` is a bare id. Immutable.
   * @default "global"
   */
  location?: string;
  /**
   * Control id (`[a-z-_]`, 4-63 characters). If omitted, a unique id is
   * generated. Immutable — changing it replaces the control.
   */
  controlId?: string;
  /**
   * Human-readable name (max 128 characters).
   */
  displayName?: string;
  /**
   * Solution types. Immutable. Only `SOLUTION_TYPE_SEARCH` is supported.
   * @default ["SOLUTION_TYPE_SEARCH"]
   */
  solutionTypes?: Array<
    | "SOLUTION_TYPE_UNSPECIFIED"
    | "SOLUTION_TYPE_RECOMMENDATION"
    | "SOLUTION_TYPE_SEARCH"
    | (string & {})
  >;
  /**
   * Search use cases.
   * @default ["SEARCH_SOLUTION_USE_CASE_SEARCH"]
   */
  searchSolutionUseCase?: Array<
    | "SEARCH_SOLUTION_USE_CASE_UNSPECIFIED"
    | "SEARCH_SOLUTION_USE_CASE_SEARCH"
    | "SEARCH_SOLUTION_USE_CASE_BROWSE"
    | (string & {})
  >;
  /**
   * Two-way synonym set (at least two terms).
   */
  synonyms?: string[];
  /**
   * Redirect URI.
   */
  redirectUri?: string;
  /**
   * Filter expression.
   */
  filter?: string;
  /**
   * Boost strength in `[-1, 1]`.
   */
  boost?: number;
  /**
   * Filter selecting products to boost. Used with `boost`.
   */
  productsFilter?: string;
  /**
   * Terms to drop from the query.
   */
  ignoreTerms?: string[];
  /**
   * Trigger conditions. Omit to always apply the action.
   */
  condition?: ControlCondition;
};

export type CatalogsControl = Resource<
  "GCP.Retail.CatalogsControl",
  CatalogsControlProps,
  {
    /** Full resource name. */
    name: string;
    /** Control id. */
    controlId: string;
    /** Parent catalog resource name. */
    catalog: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Solution types. */
    solutionTypes: string[];
    /** Search use cases. */
    searchSolutionUseCase: string[];
    /** Two-way synonyms. */
    synonyms: string[];
    /** Redirect URI. */
    redirectUri: string | undefined;
    /** Filter expression. */
    filter: string | undefined;
    /** Boost strength. */
    boost: number | undefined;
    /** Serving configs this control is attached to. */
    associatedServingConfigIds: string[];
  },
  never,
  Providers
>;

/**
 * A Retail serving control on a catalog.
 *
 * Without labels, ownership rests on the deterministic id: `read` reports a
 * resource it finds without prior state as unowned (adopt it with `--adopt`).
 * Parent, control id, and solution types are immutable. Display name and rule
 * actions update in place unless the action oneof changes, which replaces the
 * control.
 *
 * ### Creating a Control
 * **Example:** Two-way synonym control
 * ```typescript
 * const control = yield* GCP.Retail.CatalogsControl("Greetings", {
 *   displayName: "greetings",
 *   synonyms: ["hello", "hi"],
 * });
 * ```
 *
 * @resource
 * @category Retail
 */
export const CatalogsControl = Resource<CatalogsControl>(
  "GCP.Retail.CatalogsControl",
);

export class CatalogsControlNotResolved extends Data.TaggedError(
  "GCP.Retail.CatalogsControlNotResolved",
)<{
  name: string;
}> {}

const defaultSolutionTypes = ["SOLUTION_TYPE_SEARCH"] as const;
const defaultUseCase = ["SEARCH_SOLUTION_USE_CASE_SEARCH"] as const;

const actionKind = (input: {
  synonyms?: string[];
  redirectUri?: string;
  filter?: string;
  boost?: number;
  ignoreTerms?: string[];
}) => {
  if (input.redirectUri) return "redirect";
  if (input.filter) return "filter";
  if (input.boost !== undefined) return "boost";
  if (input.ignoreTerms && input.ignoreTerms.length > 0) return "ignore";
  return "synonyms";
};

const toAttrs = (
  control: retail.GoogleCloudRetailV2Control,
  project: string,
) => {
  const name = control.name ?? "";
  const parsed = parseResourceName(name, "controls");
  return {
    name,
    controlId: parsed.id,
    catalog: parsed.catalog,
    project: parsed.project || project,
    location: parsed.location,
    displayName: control.displayName,
    solutionTypes: [...(control.solutionTypes ?? [])],
    searchSolutionUseCase: [...(control.searchSolutionUseCase ?? [])],
    synonyms: [...(control.rule?.twowaySynonymsAction?.synonyms ?? [])],
    redirectUri: control.rule?.redirectAction?.redirectUri,
    filter: control.rule?.filterAction?.filter,
    boost: control.rule?.boostAction?.boost,
    associatedServingConfigIds: [...(control.associatedServingConfigIds ?? [])],
  };
};

const resourceName = (catalog: string, controlId: string) =>
  `${catalog}/controls/${controlId}`;

const toRule = (news: CatalogsControlProps): retail.GoogleCloudRetailV2Rule => {
  const condition = news.condition;
  const kind = actionKind(news);
  return {
    condition,
    twowaySynonymsAction:
      kind === "synonyms"
        ? { synonyms: news.synonyms ?? ["hello", "hi"] }
        : undefined,
    redirectAction:
      kind === "redirect" ? { redirectUri: news.redirectUri } : undefined,
    filterAction: kind === "filter" ? { filter: news.filter } : undefined,
    boostAction:
      kind === "boost"
        ? { boost: news.boost, productsFilter: news.productsFilter }
        : undefined,
    ignoreAction:
      kind === "ignore" ? { ignoreTerms: news.ignoreTerms } : undefined,
  };
};

const toBody = (
  news: CatalogsControlProps,
  displayName: string,
): retail.GoogleCloudRetailV2Control => ({
  displayName,
  solutionTypes: news.solutionTypes ?? [...defaultSolutionTypes],
  searchSolutionUseCase: news.searchSolutionUseCase ?? [...defaultUseCase],
  rule: toRule(news),
});

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : retail
        .getProjectsLocationsCatalogsControls({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const CatalogsControlProvider = () =>
  Provider.succeed(CatalogsControl, {
    stables: ["name", "controlId", "catalog", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousParent = olds?.catalog ?? output?.catalog;
      const nextParent = expandCatalog(
        news.catalog,
        env.project,
        normalizeLocation(news.location ?? output?.location),
      );
      const previousTypes = olds?.solutionTypes ?? output?.solutionTypes;
      const nextTypes = news.solutionTypes ?? previousTypes;
      const previousKind = actionKind({
        synonyms: olds?.synonyms ?? output?.synonyms,
        redirectUri: olds?.redirectUri ?? output?.redirectUri,
        filter: olds?.filter ?? output?.filter,
        boost: olds?.boost ?? output?.boost,
      });
      const nextKind = actionKind(news);
      const identity = replaceOnIdentity({
        previousId: olds?.controlId ?? output?.controlId,
        nextId: news.controlId,
        previousParent,
        nextParent,
      });
      if (
        identity !== undefined ||
        (previousTypes !== undefined &&
          nextTypes !== undefined &&
          !sameStringList(previousTypes, nextTypes)) ||
        previousKind !== nextKind
      ) {
        return (
          identity ?? {
            action: "replace" as const,
            deleteFirst: true,
          }
        );
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const catalog = olds?.catalog ?? output?.catalog;
      const controlId = yield* toPhysical(
        id,
        olds?.controlId,
        output?.controlId,
        (name) => slugNoDigits(name, MAX_ID_LENGTH),
        MAX_ID_LENGTH,
      );
      const name =
        output?.name ??
        (catalog !== undefined
          ? resourceName(
              expandCatalog(
                catalog,
                env.project,
                normalizeLocation(output?.location),
              ),
              controlId,
            )
          : undefined);
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const catalog = expandCatalog(news.catalog, env.project, location);
      const controlId = yield* toPhysical(
        id,
        news.controlId,
        output?.controlId,
        (name) => slugNoDigits(name, MAX_ID_LENGTH),
        MAX_ID_LENGTH,
      );
      const name = resourceName(catalog, controlId);
      const displayName = news.displayName ?? controlId;
      const body = toBody(news, displayName);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* retail
          .createProjectsLocationsCatalogsControls({
            parent: catalog,
            controlId,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CatalogsControlNotResolved({ name });
      }

      const resource = current.name ?? name;
      const rule = toRule(news);
      const mask = updateMaskOf(
        (current.displayName ?? "") !== displayName
          ? "display_name"
          : undefined,
        sameJson(current.rule, rule) ? undefined : "rule",
        sameStringList(
          current.searchSolutionUseCase,
          news.searchSolutionUseCase ?? [...defaultUseCase],
        )
          ? undefined
          : "search_solution_use_case",
      );

      if (mask.length > 0) {
        current = yield* retail.patchProjectsLocationsCatalogsControls({
          name: resource,
          updateMask: mask,
          body: { ...body, name: resource },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* retail
        .deleteProjectsLocationsCatalogsControls({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
