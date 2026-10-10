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
  dataStoreName,
  normalizeCollection,
  normalizeLocation,
  parseResourceName,
  toResourceId,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

export type CollectionsDataStoreProps = {
  /**
   * Data store id (the `{data_store}` segment). If omitted, a unique
   * RFC-1034 id is generated. Immutable — changing it replaces the
   * data store.
   */
  dataStoreId?: string;
  /**
   * Location (`global`, `us`, `eu`). Immutable — changing it replaces
   * the data store.
   * @default "global"
   */
  location?: string;
  /**
   * Collection id. Immutable — changing it replaces the data store.
   * @default "default_collection"
   */
  collection?: string;
  /**
   * User-facing display name (max 128 characters).
   * @default the data store id
   */
  displayName?: string;
  /**
   * Industry vertical. Immutable.
   * @default "GENERIC"
   */
  industryVertical?:
    | "INDUSTRY_VERTICAL_UNSPECIFIED"
    | "GENERIC"
    | "MEDIA"
    | "HEALTHCARE_FHIR"
    | (string & {});
  /**
   * Content config. Immutable.
   * @default "NO_CONTENT"
   */
  contentConfig?:
    | "CONTENT_CONFIG_UNSPECIFIED"
    | "NO_CONTENT"
    | "CONTENT_REQUIRED"
    | "PUBLIC_WEBSITE"
    | "GOOGLE_WORKSPACE"
    | (string & {});
  /**
   * Solutions this data store enrolls.
   * @default ["SOLUTION_TYPE_SEARCH"]
   */
  solutionTypes?: Array<
    | "SOLUTION_TYPE_UNSPECIFIED"
    | "SOLUTION_TYPE_RECOMMENDATION"
    | "SOLUTION_TYPE_SEARCH"
    | "SOLUTION_TYPE_CHAT"
    | "SOLUTION_TYPE_GENERATIVE_CHAT"
    | "SOLUTION_TYPE_AI_MODE"
    | (string & {})
  >;
  /**
   * Whether ingested documents carry ACL information. Immutable.
   * @default false
   */
  aclEnabled?: boolean;
  /**
   * Skip creating the default schema. Cannot be combined with
   * `startingSchema`.
   * @default false
   */
  skipDefaultSchemaCreation?: boolean;
  /**
   * Create an advanced site-search data store. Ignored unless
   * `contentConfig` is `PUBLIC_WEBSITE`.
   * @default false
   */
  createAdvancedSiteSearch?: boolean;
  /**
   * Disable CMEK even if the project has a default CmekConfig.
   * @default true
   */
  disableCmek?: boolean;
  /**
   * Input-only CMEK key resource name used at create time.
   */
  kmsKeyName?: string;
  /**
   * Starting schema applied only on create.
   */
  startingSchema?: {
    jsonSchema?: string;
    structSchema?: Record<string, unknown>;
  };
  /**
   * When true, the data store is not available for serving search
   * requests.
   */
  disabledForServing?: boolean;
};

export type CollectionsDataStore = Resource<
  "GCP.DiscoveryEngine.CollectionsDataStore",
  CollectionsDataStoreProps,
  {
    /** Full resource name. */
    name: string;
    /** Data store id (last path segment). */
    dataStoreId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Collection id. */
    collection: string;
    /** Display name. */
    displayName: string | undefined;
    /** Industry vertical. */
    industryVertical: string | undefined;
    /** Content config. */
    contentConfig: string | undefined;
    /** Enrolled solution types. */
    solutionTypes: string[];
    /** Whether ACL is enabled. */
    aclEnabled: boolean;
    /** Default schema id, if any. */
    defaultSchemaId: string | undefined;
    /** Whether serving is disabled. */
    disabledForServing: boolean;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Discovery Engine data store under a collection.
 *
 * Without labels, ownership rests on the deterministic id: `read` reports a
 * resource it finds without prior state as unowned (adopt it with `--adopt`).
 * Location, collection, data store id, industry vertical, content config, and
 * ACL are immutable. Display name and serving-disabled flag update in place.
 *
 * ### Creating a Data Store
 * **Example:** Generated id, generic search store
 * ```typescript
 * const store = yield* GCP.DiscoveryEngine.CollectionsDataStore("Docs", {
 *   displayName: "product docs",
 * });
 * ```
 *
 * **Example:** Site-search store
 * ```typescript
 * const store = yield* GCP.DiscoveryEngine.CollectionsDataStore("Web", {
 *   contentConfig: "PUBLIC_WEBSITE",
 *   displayName: "public site",
 * });
 * ```
 *
 * ### Updating a Data Store
 * **Example:** Rename
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const store = yield* GCP.DiscoveryEngine.CollectionsDataStore("Docs", {
 *   displayName: "product docs v2",
 * });
 * ```
 *
 * @resource
 * @category DiscoveryEngine
 */
export const CollectionsDataStore = Resource<CollectionsDataStore>(
  "GCP.DiscoveryEngine.CollectionsDataStore",
);

export class CollectionsDataStoreNotResolved extends Data.TaggedError(
  "GCP.DiscoveryEngine.CollectionsDataStoreNotResolved",
)<{
  name: string;
}> {}

export class CollectionsDataStoreStillExists extends Data.TaggedError(
  "GCP.DiscoveryEngine.CollectionsDataStoreStillExists",
)<{
  name: string;
}> {}

const verticalOf = (value: string | undefined) => value ?? "GENERIC";
const contentOf = (value: string | undefined) => value ?? "NO_CONTENT";
const solutionsOf = (value: readonly string[] | undefined) =>
  value && value.length > 0 ? [...value] : ["SOLUTION_TYPE_SEARCH"];

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
    collection: parsed.collection,
    displayName: store.displayName,
    industryVertical: store.industryVertical,
    contentConfig: store.contentConfig,
    solutionTypes: [...(store.solutionTypes ?? [])],
    aclEnabled: store.aclEnabled === true,
    defaultSchemaId: store.defaultSchemaId,
    disabledForServing:
      store.servingConfigDataStore?.disabledForServing === true,
    createTime: store.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : discoveryengine
        .getProjectsLocationsCollectionsDataStores({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((store) =>
      store
        ? Effect.succeed(store)
        : Effect.fail(new CollectionsDataStoreNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.DiscoveryEngine.CollectionsDataStoreNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((store) =>
      store === undefined
        ? Effect.void
        : Effect.fail(new CollectionsDataStoreStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.DiscoveryEngine.CollectionsDataStoreStillExists",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

export const CollectionsDataStoreProvider = () =>
  Provider.succeed(CollectionsDataStore, {
    stables: [
      "name",
      "dataStoreId",
      "project",
      "location",
      "collection",
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
      const previousCollection = normalizeCollection(
        olds?.collection ?? output?.collection,
      );
      const nextCollection = normalizeCollection(
        news.collection ?? olds?.collection ?? output?.collection,
      );
      const previousVertical = verticalOf(
        olds?.industryVertical ?? output?.industryVertical,
      );
      const nextVertical = verticalOf(
        news.industryVertical ??
          olds?.industryVertical ??
          output?.industryVertical,
      );
      const previousContent = contentOf(
        olds?.contentConfig ?? output?.contentConfig,
      );
      const nextContent = contentOf(
        news.contentConfig ?? olds?.contentConfig ?? output?.contentConfig,
      );
      const previousAcl = olds?.aclEnabled ?? output?.aclEnabled ?? false;
      const nextAcl = news.aclEnabled ?? previousAcl;
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousCollection !== nextCollection ||
        previousVertical !== nextVertical ||
        previousContent !== nextContent ||
        previousAcl !== nextAcl;
      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousCollection === nextCollection &&
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
      const collection = normalizeCollection(
        olds?.collection ?? output?.collection,
      );
      const existing = yield* getByName(
        output?.name ??
          dataStoreName(env.project, location, collection, dataStoreId),
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const collection = normalizeCollection(
        news.collection ?? output?.collection,
      );
      const dataStoreId = yield* toResourceId(
        id,
        news.dataStoreId,
        output?.dataStoreId,
      );
      const name = dataStoreName(
        env.project,
        location,
        collection,
        dataStoreId,
      );
      const displayName = news.displayName ?? dataStoreId;
      const industryVertical = verticalOf(news.industryVertical);
      const contentConfig = contentOf(news.contentConfig);
      const solutionTypes = solutionsOf(news.solutionTypes);
      const desiredDisabled = news.disabledForServing === true;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsCollectionsDataStores({
            parent: collectionParent(env.project, location, collection),
            dataStoreId,
            skipDefaultSchemaCreation: news.skipDefaultSchemaCreation,
            createAdvancedSiteSearch: news.createAdvancedSiteSearch,
            disableCmek: news.disableCmek !== false,
            body: {
              displayName,
              industryVertical,
              contentConfig,
              solutionTypes,
              aclEnabled: news.aclEnabled === true ? true : undefined,
              kmsKeyName: news.kmsKeyName,
              startingSchema: news.startingSchema,
              servingConfigDataStore:
                news.disabledForServing !== undefined
                  ? { disabledForServing: desiredDisabled }
                  : undefined,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new CollectionsDataStoreNotResolved({ name });
      }

      const resource = current.name ?? name;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const observedDisabled =
        current.servingConfigDataStore?.disabledForServing === true;
      const servingChanged =
        news.disabledForServing !== undefined &&
        observedDisabled !== desiredDisabled;

      if (displayNameChanged || servingChanged) {
        current =
          yield* discoveryengine.patchProjectsLocationsCollectionsDataStores({
            name: resource,
            updateMask: [
              displayNameChanged ? "display_name" : undefined,
              servingChanged
                ? "serving_config_data_store.disabled_for_serving"
                : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: {
              name: resource,
              displayName,
              servingConfigDataStore: servingChanged
                ? { disabledForServing: desiredDisabled }
                : current.servingConfigDataStore,
            },
          });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* discoveryengine
        .deleteProjectsLocationsCollectionsDataStores({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
