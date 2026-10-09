import * as cloudsearch from "@distilled.cloud/gcp/cloudsearch_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  findSearchApplicationByDisplayName,
  getSearchApplication,
  ignoreMissing,
  jsonEqual,
  MAX_DISPLAY_NAME_LENGTH,
  operationResourceName,
  sameBoolean,
  sameText,
  searchApplicationIdOf,
  toGeneratedName,
  toSearchApplicationName,
  updateMaskOf,
  waitForOperation,
  waitUntilExists,
} from "./internal.ts";

export type DataSourceRestriction = cloudsearch.DataSourceRestriction;
export type SortOptions = cloudsearch.SortOptions;
export type QueryInterpretationConfig = cloudsearch.QueryInterpretationConfig;
export type ScoringConfig = cloudsearch.ScoringConfig;
export type SourceConfig = cloudsearch.SourceConfig;
export type FacetOptions = cloudsearch.FacetOptions;

export type SettingsSearchapplicationProps = {
  /**
   * Search application id (`{application_id}` or
   * `searchapplications/{application_id}`). Server assigned on create.
   * Immutable — changing it replaces the application.
   */
  searchApplicationId?: string;
  /**
   * Display name (max 300 characters). Without state Alchemy finds the
   * application by this name.
   * @default a unique name generated from the stack, stage, and logical id
   */
  displayName?: string;
  /**
   * Enable audit logging for query APIs.
   * @default false
   */
  enableAuditLog?: boolean;
  /**
   * Return thumbnail URIs with search results when available.
   * @default false
   */
  returnResultThumbnailUrls?: boolean;
  /**
   * Sources this application may search (max 10).
   */
  dataSourceRestrictions?: DataSourceRestriction[];
  /**
   * Default sort for search results.
   */
  defaultSortOptions?: SortOptions;
  /**
   * Default query-interpretation options.
   */
  queryInterpretationConfig?: QueryInterpretationConfig;
  /**
   * Ranking configuration.
   */
  scoringConfig?: ScoringConfig;
  /**
   * Per-source scoring and crowding configuration.
   */
  sourceConfig?: SourceConfig[];
  /**
   * Default facet fields. Sources listed here must also appear in
   * `dataSourceRestrictions`.
   */
  defaultFacetOptions?: FacetOptions[];
};

export type SettingsSearchapplication = Resource<
  "GCP.CloudSearch.SettingsSearchapplication",
  SettingsSearchapplicationProps,
  {
    /** Full resource name `searchapplications/{application_id}`. */
    name: string;
    /** Search application id (last path segment). */
    searchApplicationId: string;
    /** Project id used when the application was reconciled. */
    project: string;
    /** User-facing display name with the Alchemy prefix stripped. */
    displayName: string | undefined;
    /** Whether query audit logging is enabled. */
    enableAuditLog: boolean;
    /** Whether result thumbnail URIs are returned. */
    returnResultThumbnailUrls: boolean;
    /** Restricted data sources. */
    dataSourceRestrictions: DataSourceRestriction[];
    /** Default sort options. */
    defaultSortOptions: SortOptions | undefined;
    /** Query interpretation config. */
    queryInterpretationConfig: QueryInterpretationConfig | undefined;
    /** Scoring config. */
    scoringConfig: ScoringConfig | undefined;
    /** Per-source config. */
    sourceConfig: SourceConfig[];
    /** Default facet options. */
    defaultFacetOptions: FacetOptions[];
    /** Server-reported in-flight operation ids. */
    operationIds: string[];
  },
  never,
  Providers
>;

/**
 * A Cloud Search search application.
 *
 * Search applications have no labels field, so without state Alchemy finds
 * one by `displayName` and reports it unowned unless the name is
 * generated. The server-assigned application id is identity — changing
 * `searchApplicationId` replaces the application. Display name, audit
 * logging, sources, scoring, and facet options update in place. Admin
 * credentials are required.
 *
 * ### Creating a Search Application
 * **Example:** Generated name
 * ```typescript
 * const app = yield* GCP.CloudSearch.SettingsSearchapplication(
 *   "Intranet",
 *   {},
 * );
 * ```
 *
 * **Example:** Named application with audit logging
 * ```typescript
 * const app = yield* GCP.CloudSearch.SettingsSearchapplication(
 *   "Intranet",
 *   {
 *     displayName: "Intranet",
 *     enableAuditLog: true,
 *   },
 * );
 * ```
 *
 * ### Updating a Search Application
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Rename and enable result thumbnails
 * ```typescript
 * const app = yield* GCP.CloudSearch.SettingsSearchapplication(
 *   "Intranet",
 *   {
 *     displayName: "Company search",
 *     returnResultThumbnailUrls: true,
 *   },
 * );
 * ```
 *
 * @resource
 * @category CloudSearch
 */
export const SettingsSearchapplication = Resource<SettingsSearchapplication>(
  "GCP.CloudSearch.SettingsSearchapplication",
);

export class SettingsSearchapplicationNotResolved extends Data.TaggedError(
  "GCP.CloudSearch.SettingsSearchapplicationNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (app: cloudsearch.SearchApplication, project: string) => {
  const name = app.name ?? "";
  return {
    name,
    searchApplicationId: searchApplicationIdOf(name),
    project,
    displayName: app.displayName,
    enableAuditLog: app.enableAuditLog === true,
    returnResultThumbnailUrls: app.returnResultThumbnailUrls === true,
    dataSourceRestrictions: app.dataSourceRestrictions ?? [],
    defaultSortOptions: app.defaultSortOptions,
    queryInterpretationConfig: app.queryInterpretationConfig,
    scoringConfig: app.scoringConfig,
    sourceConfig: app.sourceConfig ?? [],
    defaultFacetOptions: app.defaultFacetOptions ?? [],
    operationIds: app.operationIds ?? [],
  };
};

const lookupName = (
  searchApplicationId: string | undefined,
  existingName: string | undefined,
) => {
  if (searchApplicationId !== undefined && searchApplicationId.length > 0) {
    return toSearchApplicationName(searchApplicationId);
  }
  if (existingName !== undefined && existingName.length > 0) {
    return toSearchApplicationName(existingName);
  }
  return "";
};

export const SettingsSearchapplicationProvider = () =>
  Provider.succeed(SettingsSearchapplication, {
    stables: ["name", "searchApplicationId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous =
        olds?.searchApplicationId ??
        output?.searchApplicationId ??
        output?.name;
      if (
        previous !== undefined &&
        news.searchApplicationId !== undefined &&
        toSearchApplicationName(news.searchApplicationId) !==
          toSearchApplicationName(previous) &&
        news.searchApplicationId !== output?.searchApplicationId &&
        toSearchApplicationName(news.searchApplicationId) !== output?.name
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const name = lookupName(
        olds?.searchApplicationId ?? output?.searchApplicationId,
        output?.name,
      );
      let existing = yield* getSearchApplication(name);
      if (existing !== undefined) return toAttrs(existing, env.project);
      if (olds === undefined) return undefined;
      const generated = yield* toGeneratedName(id, undefined, undefined);
      const displayName = olds.displayName ?? generated;
      const found = yield* findSearchApplicationByDisplayName(displayName);
      if (found === undefined) return undefined;
      const attrs = toAttrs(found, env.project);
      // A generated display name is unique to this stack, stage and id.
      return displayName === generated ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const displayName = (yield* toGeneratedName(
        id,
        news.displayName,
        output?.displayName,
      )).slice(0, MAX_DISPLAY_NAME_LENGTH);
      const name = lookupName(news.searchApplicationId, output?.name);
      const desiredEnableAuditLog = news.enableAuditLog === true;
      const desiredThumbnails = news.returnResultThumbnailUrls === true;
      const desiredRestrictions = news.dataSourceRestrictions ?? [];
      const desiredSourceConfig = news.sourceConfig ?? [];
      const desiredFacets = news.defaultFacetOptions ?? [];
      const desired: cloudsearch.SearchApplication = {
        displayName,
        enableAuditLog: desiredEnableAuditLog,
        returnResultThumbnailUrls: desiredThumbnails,
        dataSourceRestrictions: desiredRestrictions,
        defaultSortOptions: news.defaultSortOptions,
        queryInterpretationConfig: news.queryInterpretationConfig,
        scoringConfig: news.scoringConfig,
        sourceConfig: desiredSourceConfig,
        defaultFacetOptions: desiredFacets,
      };

      let current = yield* getSearchApplication(name);
      if (current === undefined) {
        current = yield* findSearchApplicationByDisplayName(displayName);
      }

      if (current === undefined) {
        const created = yield* cloudsearch
          .createSettingsSearchapplications({ body: desired })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          const done = yield* waitForOperation(created);
          const createdName = operationResourceName(done);
          if (createdName !== undefined) {
            current = yield* waitUntilExists(
              getSearchApplication(createdName),
              createdName,
            ).pipe(
              Effect.catchTag("GCP.CloudSearch.ResourceNotResolved", () =>
                Effect.succeed(undefined),
              ),
            );
          }
        }
        if (current === undefined) {
          current = yield* findSearchApplicationByDisplayName(displayName);
        }
      }

      if (current === undefined) {
        return yield* new SettingsSearchapplicationNotResolved({
          name: name || displayName,
        });
      }

      const resourceName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const auditChanged = !sameBoolean(
        current.enableAuditLog,
        desiredEnableAuditLog,
      );
      const thumbnailsChanged = !sameBoolean(
        current.returnResultThumbnailUrls,
        desiredThumbnails,
      );
      const restrictionsChanged = !jsonEqual(
        current.dataSourceRestrictions ?? [],
        desiredRestrictions,
      );
      const sortChanged = !jsonEqual(
        current.defaultSortOptions,
        news.defaultSortOptions,
      );
      const interpretationChanged = !jsonEqual(
        current.queryInterpretationConfig,
        news.queryInterpretationConfig,
      );
      const scoringChanged = !jsonEqual(
        current.scoringConfig,
        news.scoringConfig,
      );
      const sourceConfigChanged = !jsonEqual(
        current.sourceConfig ?? [],
        desiredSourceConfig,
      );
      const facetsChanged = !jsonEqual(
        current.defaultFacetOptions ?? [],
        desiredFacets,
      );

      const updateMask = updateMaskOf(
        displayChanged ? "displayName" : undefined,
        auditChanged ? "enableAuditLog" : undefined,
        thumbnailsChanged ? "returnResultThumbnailUrls" : undefined,
        restrictionsChanged ? "dataSourceRestrictions" : undefined,
        sortChanged ? "defaultSortOptions" : undefined,
        interpretationChanged ? "queryInterpretationConfig" : undefined,
        scoringChanged ? "scoringConfig" : undefined,
        sourceConfigChanged ? "sourceConfig" : undefined,
        facetsChanged ? "defaultFacetOptions" : undefined,
      );

      if (updateMask.length > 0) {
        const patched = yield* cloudsearch.patchSettingsSearchapplications({
          name: toSearchApplicationName(resourceName),
          updateMask,
          body: desired,
        });
        yield* waitForOperation(patched);
        const refreshed = yield* waitUntilExists(
          getSearchApplication(resourceName),
          resourceName,
        );
        current = refreshed;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.name.length === 0 && output.searchApplicationId.length === 0) {
        return;
      }
      const name = toSearchApplicationName(
        output.name || output.searchApplicationId,
      );
      const operation = yield* cloudsearch
        .deleteSettingsSearchapplications({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* ignoreMissing(
        cloudsearch.deleteSettingsSearchapplications({ name }),
      );
    }),
  });
