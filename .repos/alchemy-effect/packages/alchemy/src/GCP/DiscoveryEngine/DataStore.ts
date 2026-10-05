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
  normalizeLocation,
  parseResourceName,
  sameStringList,
  toResourceId,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

export type DataStoreProps = {
  /**
   * Data store id (the `{dataStore}` segment of the resource name). If
   * omitted, a unique RFC-1034 id is generated. Immutable — changing it
   * replaces the data store.
   */
  dataStoreId?: string;
  /**
   * Location (`global`, `us`, `eu`, …). Immutable — changing it replaces
   * the data store.
   * @default "global"
   */
  location?: string;
  /**
   * User-facing display name (max 128 characters).
   * @default the data store id
   */
  displayName?: string;
  /**
   * Industry vertical. Immutable — changing it replaces the data store.
   * @default "GENERIC"
   */
  industryVertical?: discoveryengine.GoogleCloudDiscoveryengineV1DataStoreIndustryVerticalEnum;
  /**
   * Content config. Immutable — changing it replaces the data store.
   * @default "NO_CONTENT"
   */
  contentConfig?: discoveryengine.GoogleCloudDiscoveryengineV1DataStoreContentConfigEnum;
  /**
   * Solutions to enroll. Available values depend on `industryVertical`.
   * @default ["SOLUTION_TYPE_SEARCH"]
   */
  solutionTypes?: discoveryengine.GoogleCloudDiscoveryengineV1DataStoreSolutionTypesItemEnumList;
  /**
   * Whether ingested documents carry ACL information. Immutable.
   * @default false
   */
  aclEnabled?: boolean;
  /**
   * Skip creating the default schema. Cannot be combined with a starting
   * schema.
   * @default false
   */
  skipDefaultSchemaCreation?: boolean;
  /**
   * Create an advanced site-search data store. Ignored unless the store
   * is GENERIC + PUBLIC_WEBSITE.
   * @default false
   */
  createAdvancedSiteSearch?: boolean;
  /**
   * Disable CMEK even if the project has a default CmekConfig.
   * @default true
   */
  disableCmek?: boolean;
  /**
   * Resource name of the CmekConfig used to protect this data store.
   */
  cmekConfigName?: string;
  /**
   * Customer-managed KMS key used at creation time.
   */
  kmsKeyName?: string;
};

export type DataStore = Resource<
  "GCP.DiscoveryEngine.DataStore",
  DataStoreProps,
  {
    /** Full resource name. */
    name: string;
    /** Data store id (last path segment). */
    dataStoreId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Collection id parsed from the resource name, if present. */
    collectionId: string | undefined;
    /** Display name. */
    displayName: string | undefined;
    /** Industry vertical. */
    industryVertical: string | undefined;
    /** Content config. */
    contentConfig: string | undefined;
    /** Enrolled solutions. */
    solutionTypes: string[];
    /** Whether ACL is enabled. */
    aclEnabled: boolean;
    /** Default schema id. */
    defaultSchemaId: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Discovery Engine DataStore — a container for Documents.
 *
 * Without labels, ownership rests on the deterministic id: `read` reports a
 * resource it finds without prior state as unowned (adopt it with `--adopt`).
 * Location-scoped (`projects/{project}/locations/{location}/dataStores`). Id,
 * location, vertical, content config, and ACL are immutable; display name
 * updates in place.
 *
 * ### Creating a Data Store
 * **Example:** Generated id, generic search store
 * ```typescript
 * const store = yield* GCP.DiscoveryEngine.DataStore("Docs", {
 *   displayName: "docs",
 * });
 * ```
 *
 * **Example:** Explicit id
 * ```typescript
 * const store = yield* GCP.DiscoveryEngine.DataStore("Docs", {
 *   dataStoreId: "app-docs",
 *   location: "global",
 *   industryVertical: "GENERIC",
 *   contentConfig: "NO_CONTENT",
 *   solutionTypes: ["SOLUTION_TYPE_SEARCH"],
 * });
 * ```
 *
 * ### Updating a Data Store
 * **Example:** Rename
 * ```typescript
 * // Same logical id as before; only the display name changes.
 * const store = yield* GCP.DiscoveryEngine.DataStore("Docs", {
 *   displayName: "docs-prod",
 * });
 * ```
 *
 * @resource
 * @category DiscoveryEngine
 */
export const DataStore = Resource<DataStore>("GCP.DiscoveryEngine.DataStore");

export class DataStoreNotResolved extends Data.TaggedError(
  "GCP.DiscoveryEngine.DataStoreNotResolved",
)<{
  name: string;
}> {}

export class DataStoreStillExists extends Data.TaggedError(
  "GCP.DiscoveryEngine.DataStoreStillExists",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, dataStoreId: string) =>
  `projects/${project}/locations/${location}/dataStores/${dataStoreId}`;

const verticalOf = (
  value:
    | discoveryengine.GoogleCloudDiscoveryengineV1DataStoreIndustryVerticalEnum
    | undefined,
) => value ?? "GENERIC";

const contentOf = (
  value:
    | discoveryengine.GoogleCloudDiscoveryengineV1DataStoreContentConfigEnum
    | undefined,
) => value ?? "NO_CONTENT";

const solutionsOf = (
  value:
    | discoveryengine.GoogleCloudDiscoveryengineV1DataStoreSolutionTypesItemEnumList
    | undefined,
): discoveryengine.GoogleCloudDiscoveryengineV1DataStoreSolutionTypesItemEnumList =>
  value && value.length > 0 ? value : ["SOLUTION_TYPE_SEARCH"];

const getByName = (name: string) =>
  discoveryengine
    .getProjectsLocationsDataStores({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toAttrs = (
  store: discoveryengine.GoogleCloudDiscoveryengineV1DataStore,
  project: string,
) => {
  const name = store.name ?? "";
  const parsed = parseResourceName(name, "dataStores");
  return {
    name,
    dataStoreId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    collectionId: name.includes("/collections/")
      ? parsed.collectionId
      : undefined,
    displayName: store.displayName,
    industryVertical: store.industryVertical,
    contentConfig: store.contentConfig,
    solutionTypes: [...(store.solutionTypes ?? [])],
    aclEnabled: store.aclEnabled === true,
    defaultSchemaId: store.defaultSchemaId,
    createTime: store.createTime,
  };
};

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((store) =>
      store
        ? Effect.succeed(store)
        : Effect.fail(new DataStoreNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.DiscoveryEngine.DataStoreNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((store) =>
      store === undefined
        ? Effect.void
        : Effect.fail(new DataStoreStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.DiscoveryEngine.DataStoreStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const DataStoreProvider = () =>
  Provider.succeed(DataStore, {
    stables: [
      "name",
      "dataStoreId",
      "project",
      "location",
      "collectionId",
      "industryVertical",
      "contentConfig",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.dataStoreId ?? output?.dataStoreId;
      const nextId = news.dataStoreId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      const previousVertical = verticalOf(
        olds?.industryVertical ??
          (output?.industryVertical as DataStoreProps["industryVertical"]),
      );
      const nextVertical = verticalOf(
        news.industryVertical ??
          (output?.industryVertical as DataStoreProps["industryVertical"]),
      );
      const previousContent = contentOf(
        olds?.contentConfig ??
          (output?.contentConfig as DataStoreProps["contentConfig"]),
      );
      const nextContent = contentOf(
        news.contentConfig ??
          (output?.contentConfig as DataStoreProps["contentConfig"]),
      );
      const previousAcl = olds?.aclEnabled ?? output?.aclEnabled ?? false;
      const nextAcl = news.aclEnabled ?? previousAcl;
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousVertical !== nextVertical ||
        previousContent !== nextContent ||
        previousAcl !== nextAcl;
      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const dataStoreId = yield* toResourceId(
        id,
        olds?.dataStoreId,
        output?.dataStoreId,
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const existing = yield* getByName(
        output?.name ?? resourceName(env.project, location, dataStoreId),
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const dataStoreId = yield* toResourceId(
        id,
        news.dataStoreId,
        output?.dataStoreId,
      );
      const displayName = news.displayName ?? dataStoreId;
      const industryVertical = verticalOf(news.industryVertical);
      const contentConfig = contentOf(news.contentConfig);
      const solutionTypes = solutionsOf(news.solutionTypes);
      const fallbackName =
        output?.name ?? resourceName(env.project, location, dataStoreId);

      let current = yield* getByName(fallbackName);

      if (current === undefined) {
        // The collection-less create endpoint answers 500 "Internal error
        // encountered." for every request; the same data store is created
        // through the default collection and stays addressable as
        // `projects/{p}/locations/{l}/dataStores/{id}`.
        const created = yield* discoveryengine
          .createProjectsLocationsCollectionsDataStores({
            parent: collectionParent(
              env.project,
              location,
              "default_collection",
            ),
            dataStoreId,
            skipDefaultSchemaCreation: news.skipDefaultSchemaCreation,
            createAdvancedSiteSearch: news.createAdvancedSiteSearch,
            disableCmek: news.disableCmek ?? true,
            cmekConfigName: news.cmekConfigName,
            body: {
              displayName,
              industryVertical,
              contentConfig,
              solutionTypes,
              aclEnabled: news.aclEnabled === true ? true : undefined,
              kmsKeyName: news.kmsKeyName,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(fallbackName);
      }

      if (current === undefined) {
        return yield* new DataStoreNotResolved({ name: fallbackName });
      }

      const name = current.name ?? fallbackName;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const solutionsChanged = !sameStringList(
        current.solutionTypes,
        solutionTypes,
      );

      if (displayNameChanged || solutionsChanged) {
        current = yield* discoveryengine.patchProjectsLocationsDataStores({
          name,
          updateMask: [
            displayNameChanged ? "display_name" : undefined,
            solutionsChanged ? "solution_types" : undefined,
          ]
            .filter((field): field is string => field !== undefined)
            .join(","),
          body: {
            name,
            displayName,
            solutionTypes,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* discoveryengine
        .deleteProjectsLocationsDataStores({ name: output.name })
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
