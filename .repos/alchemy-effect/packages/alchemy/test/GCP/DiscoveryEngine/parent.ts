import { waitForOperation } from "@/GCP/DiscoveryEngine";
import * as Category from "@distilled.cloud/core/category";
import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import * as GcpRetry from "@distilled.cloud/gcp/Retry";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * The suite runs ~25 files at once against one project, which overruns the
 * per-minute "Data store read requests" quota. Distilled's default backoff
 * gives up before the minute rolls over, so the suite rides it out.
 */
export const quotaTolerant = GcpRetry.policy({
  while: (error) =>
    Category.isThrottling(error) || Category.isTransientError(error),
  schedule: Schedule.max([Schedule.spaced("10 seconds"), Schedule.recurs(12)]),
});

export const DEFAULT_LOCATION = "global";
export const DEFAULT_COLLECTION = "default_collection";

export const collectionParent = (
  project: string,
  location = DEFAULT_LOCATION,
) =>
  `projects/${project}/locations/${location}/collections/${DEFAULT_COLLECTION}`;

export const dataStoreName = (
  project: string,
  dataStoreId: string,
  location = DEFAULT_LOCATION,
) => `${collectionParent(project, location)}/dataStores/${dataStoreId}`;

export const getDataStore = (name: string) =>
  discoveryengine
    .getProjectsLocationsCollectionsDataStores({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const ensureDataStore = (
  project: string,
  dataStoreId: string,
  options?: {
    contentConfig?: string;
    industryVertical?: string;
    location?: string;
    withEngine?: boolean;
    skipDefaultSchemaCreation?: boolean;
  },
) =>
  Effect.gen(function* () {
    const location = options?.location ?? DEFAULT_LOCATION;
    const parent = collectionParent(project, location);
    const name = dataStoreName(project, dataStoreId, location);
    let store = yield* getDataStore(name);
    if (store === undefined) {
      const created = yield* discoveryengine
        .createProjectsLocationsCollectionsDataStores({
          parent,
          dataStoreId,
          disableCmek: true,
          skipDefaultSchemaCreation: options?.skipDefaultSchemaCreation,
          body: {
            displayName: dataStoreId,
            industryVertical: options?.industryVertical ?? "GENERIC",
            contentConfig: options?.contentConfig ?? "CONTENT_REQUIRED",
            solutionTypes: ["SOLUTION_TYPE_SEARCH"],
          },
        })
        .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
      if (created !== undefined) {
        yield* waitForOperation(created);
      }
      store = yield* discoveryengine
        .getProjectsLocationsCollectionsDataStores({ name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "NotFound",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
    }

    if (options?.withEngine === true) {
      const engineId = `${dataStoreId}eng`
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 63);
      const engineName = `${parent}/engines/${engineId}`;
      const existingEngine = yield* discoveryengine
        .getProjectsLocationsCollectionsEngines({ name: engineName })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (existingEngine === undefined) {
        const createdEngine = yield* discoveryengine
          .createProjectsLocationsCollectionsEngines({
            parent,
            engineId,
            body: {
              displayName: engineId,
              solutionType: "SOLUTION_TYPE_SEARCH",
              dataStoreIds: [dataStoreId],
              searchEngineConfig: { searchTier: "SEARCH_TIER_STANDARD" },
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (createdEngine !== undefined) {
          yield* waitForOperation(createdEngine);
        }
      }
    }

    return store;
  });

export const engineNameOf = (
  project: string,
  dataStoreId: string,
  location = DEFAULT_LOCATION,
) =>
  `${collectionParent(project, location)}/engines/${dataStoreId.replace(/[^a-z0-9]/g, "").slice(0, 60)}eng`;

export const deleteEngine = (name: string) =>
  Effect.gen(function* () {
    const existing = yield* discoveryengine
      .getProjectsLocationsCollectionsEngines({ name })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (existing === undefined) return;
    const operation = yield* discoveryengine
      .deleteProjectsLocationsCollectionsEngines({ name })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (operation !== undefined) {
      yield* waitForOperation(operation, { notFoundOk: true });
    }
  });

export const deleteDataStore = (name: string) =>
  Effect.gen(function* () {
    const existing = yield* getDataStore(name);
    if (existing === undefined) return;
    const operation = yield* discoveryengine
      .deleteProjectsLocationsCollectionsDataStores({ name })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (operation !== undefined) {
      yield* waitForOperation(operation, { notFoundOk: true });
    }
  });

export const deleteSearchParent = (
  project: string,
  dataStoreId: string,
  location = DEFAULT_LOCATION,
) =>
  Effect.gen(function* () {
    yield* deleteEngine(engineNameOf(project, dataStoreId, location));
    yield* deleteDataStore(dataStoreName(project, dataStoreId, location));
  });
