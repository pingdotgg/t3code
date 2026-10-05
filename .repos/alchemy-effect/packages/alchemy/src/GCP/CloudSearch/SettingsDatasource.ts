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
  datasourceIdOf,
  findDatasourceByDisplayName,
  getDatasource,
  ignoreMissing,
  jsonEqual,
  MAX_DISPLAY_NAME_LENGTH,
  operationResourceName,
  sameBoolean,
  sameText,
  toDatasourceName,
  toGeneratedName,
  toShortName,
  updateMaskOf,
  waitForOperation,
  waitUntilExists,
} from "./internal.ts";

export type GSuitePrincipal = cloudsearch.GSuitePrincipal;

export type SettingsDatasourceProps = {
  /**
   * Datasource id (`{source_id}` or `datasources/{source_id}`). Server
   * assigned on create. Immutable — changing it replaces the datasource.
   */
  datasourceId?: string;
  /**
   * Display name (max 300 characters). Without state Alchemy finds the
   * datasource by this name.
   * @default a unique name generated from the stack, stage, and logical id
   */
  displayName?: string;
  /**
   * Short operator name used as `source:<value>`. Alphanumeric, max 32
   * characters, unique across datasources. Cannot start with `google` or
   * equal a reserved Workspace source (mail, gmail, docs, drive, …).
   */
  shortName?: string;
  /**
   * Reject Indexing API writes while still serving previously indexed
   * items.
   * @default false
   */
  disableModifications?: boolean;
  /**
   * Disable serving search and assist results from this source.
   * @default false
   */
  disableServing?: boolean;
  /**
   * Whether users can request thumbnail URIs for indexed items.
   * @default false
   */
  returnThumbnailUrls?: boolean;
  /**
   * Service accounts allowed to index this source.
   */
  indexingServiceAccounts?: string[];
  /**
   * Datasource-level item visibility (union of users and groups).
   */
  itemsVisibility?: GSuitePrincipal[];
};

export type SettingsDatasource = Resource<
  "GCP.CloudSearch.SettingsDatasource",
  SettingsDatasourceProps,
  {
    /** Full resource name `datasources/{source_id}`. */
    name: string;
    /** Datasource id (last path segment). */
    datasourceId: string;
    /** Project id used when the datasource was reconciled. */
    project: string;
    /** User-facing display name with the Alchemy prefix stripped. */
    displayName: string | undefined;
    /** Short operator name. */
    shortName: string | undefined;
    /** Whether indexing writes are rejected. */
    disableModifications: boolean;
    /** Whether serving is disabled. */
    disableServing: boolean;
    /** Whether thumbnail URIs may be requested. */
    returnThumbnailUrls: boolean;
    /** Indexing service accounts. */
    indexingServiceAccounts: string[];
    /** Datasource-level visibility. */
    itemsVisibility: GSuitePrincipal[];
    /** Server-reported in-flight operation ids. */
    operationIds: string[];
  },
  never,
  Providers
>;

/**
 * A Cloud Search datasource.
 *
 * Cloud Search datasources have no labels field, so without state Alchemy
 * finds one by `displayName` and reports it unowned unless the name is
 * generated. The server-assigned datasource id is identity — changing
 * `datasourceId` replaces the source. Display name, short name, serving
 * flags, indexing accounts, and visibility update in place. Admin
 * credentials are required.
 *
 * ### Creating a Datasource
 * **Example:** Generated name
 * ```typescript
 * const source = yield* GCP.CloudSearch.SettingsDatasource("Wiki", {});
 * ```
 *
 * **Example:** Explicit display name and short name
 * ```typescript
 * const source = yield* GCP.CloudSearch.SettingsDatasource("Wiki", {
 *   displayName: "Wiki",
 *   shortName: "wiki",
 *   returnThumbnailUrls: true,
 * });
 * ```
 *
 * ### Updating a Datasource
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Rename and disable serving
 * ```typescript
 * const source = yield* GCP.CloudSearch.SettingsDatasource("Wiki", {
 *   displayName: "Knowledge base",
 *   shortName: "wiki",
 *   disableServing: true,
 * });
 * ```
 *
 * @resource
 * @category CloudSearch
 */
export const SettingsDatasource = Resource<SettingsDatasource>(
  "GCP.CloudSearch.SettingsDatasource",
);

export class SettingsDatasourceNotResolved extends Data.TaggedError(
  "GCP.CloudSearch.SettingsDatasourceNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (source: cloudsearch.DataSource, project: string) => {
  const name = source.name ?? "";
  return {
    name,
    datasourceId: datasourceIdOf(name),
    project,
    displayName: source.displayName,
    shortName: source.shortName,
    disableModifications: source.disableModifications === true,
    disableServing: source.disableServing === true,
    returnThumbnailUrls: source.returnThumbnailUrls === true,
    indexingServiceAccounts: source.indexingServiceAccounts ?? [],
    itemsVisibility: source.itemsVisibility ?? [],
    operationIds: source.operationIds ?? [],
  };
};

const lookupName = (
  datasourceId: string | undefined,
  existingName: string | undefined,
) => {
  if (datasourceId !== undefined && datasourceId.length > 0) {
    return toDatasourceName(datasourceId);
  }
  if (existingName !== undefined && existingName.length > 0) {
    return toDatasourceName(existingName);
  }
  return "";
};

export const SettingsDatasourceProvider = () =>
  Provider.succeed(SettingsDatasource, {
    stables: ["name", "datasourceId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous =
        olds?.datasourceId ?? output?.datasourceId ?? output?.name;
      if (
        previous !== undefined &&
        news.datasourceId !== undefined &&
        toDatasourceName(news.datasourceId) !== toDatasourceName(previous) &&
        news.datasourceId !== output?.datasourceId &&
        toDatasourceName(news.datasourceId) !== output?.name
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const name = lookupName(
        olds?.datasourceId ?? output?.datasourceId,
        output?.name,
      );
      let existing = yield* getDatasource(name);
      if (existing !== undefined) return toAttrs(existing, env.project);
      if (olds === undefined) return undefined;
      const generated = yield* toGeneratedName(id, undefined, undefined);
      const displayName = olds.displayName ?? generated;
      const found = yield* findDatasourceByDisplayName(displayName);
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
      const name = lookupName(news.datasourceId, output?.name);

      let current = yield* getDatasource(name);
      if (current === undefined) {
        current = yield* findDatasourceByDisplayName(displayName);
      }

      const shortName = yield* toShortName(
        id,
        news.shortName,
        current?.shortName ?? output?.shortName,
      );
      const desiredDisableModifications = news.disableModifications === true;
      const desiredDisableServing = news.disableServing === true;
      const desiredReturnThumbnailUrls = news.returnThumbnailUrls === true;
      const desiredAccounts = news.indexingServiceAccounts ?? [];
      const desiredVisibility = news.itemsVisibility ?? [];
      const desired: cloudsearch.DataSource = {
        displayName,
        shortName,
        disableModifications: desiredDisableModifications,
        disableServing: desiredDisableServing,
        returnThumbnailUrls: desiredReturnThumbnailUrls,
        indexingServiceAccounts: desiredAccounts,
        itemsVisibility: desiredVisibility,
      };

      if (current === undefined) {
        const created = yield* cloudsearch
          .createSettingsDatasources({ body: desired })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          const done = yield* waitForOperation(created);
          const createdName = operationResourceName(done);
          if (createdName !== undefined) {
            current = yield* waitUntilExists(
              getDatasource(createdName),
              createdName,
            ).pipe(
              Effect.catchTag("GCP.CloudSearch.ResourceNotResolved", () =>
                Effect.succeed(undefined),
              ),
            );
          }
        }
        if (current === undefined) {
          current = yield* findDatasourceByDisplayName(displayName);
        }
      }

      if (current === undefined) {
        return yield* new SettingsDatasourceNotResolved({
          name: name || displayName,
        });
      }

      const resourceName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const shortNameChanged = !sameText(current.shortName, shortName);
      const modificationsChanged = !sameBoolean(
        current.disableModifications,
        desiredDisableModifications,
      );
      const servingChanged = !sameBoolean(
        current.disableServing,
        desiredDisableServing,
      );
      const thumbnailsChanged = !sameBoolean(
        current.returnThumbnailUrls,
        desiredReturnThumbnailUrls,
      );
      const accountsChanged = !jsonEqual(
        current.indexingServiceAccounts ?? [],
        desiredAccounts,
      );
      const visibilityChanged = !jsonEqual(
        current.itemsVisibility ?? [],
        desiredVisibility,
      );

      const updateMask = updateMaskOf(
        displayChanged ? "displayName" : undefined,
        shortNameChanged ? "shortName" : undefined,
        modificationsChanged ? "disableModifications" : undefined,
        servingChanged ? "disableServing" : undefined,
        thumbnailsChanged ? "returnThumbnailUrls" : undefined,
        accountsChanged ? "indexingServiceAccounts" : undefined,
        visibilityChanged ? "itemsVisibility" : undefined,
      );

      if (updateMask.length > 0) {
        const patched = yield* cloudsearch.patchSettingsDatasources({
          name: toDatasourceName(resourceName),
          updateMask,
          body: desired,
        });
        yield* waitForOperation(patched);
        const refreshed = yield* waitUntilExists(
          getDatasource(resourceName),
          resourceName,
        );
        current = refreshed;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.name.length === 0 && output.datasourceId.length === 0) {
        return;
      }
      const name = toDatasourceName(output.name || output.datasourceId);
      const operation = yield* cloudsearch
        .deleteSettingsDatasources({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* ignoreMissing(cloudsearch.deleteSettingsDatasources({ name }));
    }),
  });
