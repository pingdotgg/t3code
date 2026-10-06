import * as biglake from "@distilled.cloud/gcp/biglake_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  BiglakeNotResolved,
  listLocations,
  createInternalLabels,
  expandCatalog,
  hasAlchemyLabelMap,
  hasAlchemyLabels,
  ignoreGone,
  listCatalogs,
  listChildResources,
  listDatabases,
  listTables,
  locationParent,
  mergeParameters,
  missingGet,
  namedOf,
  normalizeLocation,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  sameJson,
  sameText,
  toPhysicalId,
  updateMaskOf,
  userLabels,
  waitUntilGone,
} from "./internal.ts";

export type HiveDatabaseOptions = {
  /**
   * Cloud Storage folder URI where the database data is stored, starting
   * with `gs://`.
   */
  locationUri?: string;
  /**
   * User-supplied Hive database parameters. Alchemy ownership keys
   * (`alchemy-stack`, `alchemy-stage`, `alchemy-id`) are merged in
   * automatically — BigLake databases have no labels field.
   */
  parameters?: Record<string, string>;
};

export type CatalogsDatabaseProps = {
  /**
   * Parent catalog. Full name
   * `projects/{project}/locations/{location}/catalogs/{catalog}` or the
   * catalog id (combined with `location`). Immutable — changing it
   * replaces the database.
   */
  catalog: string;
  /**
   * Database id (the `{database}` segment). If omitted, a unique id is
   * generated. Immutable — changing it replaces the database.
   */
  databaseId?: string;
  /**
   * Location used when `catalog` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Database type.
   * @default "HIVE"
   */
  type?: biglake.DatabaseTypeEnum | (string & {});
  /**
   * Hive database options. Required when `type` is `HIVE`.
   */
  hiveOptions?: HiveDatabaseOptions;
  /**
   * Shortcut for `hiveOptions.locationUri`.
   */
  locationUri?: string;
  /**
   * Shortcut for `hiveOptions.parameters`. Alchemy ownership keys are
   * merged in automatically.
   */
  parameters?: Record<string, string>;
};

export type CatalogsDatabase = Resource<
  "GCP.BigLake.CatalogsDatabase",
  CatalogsDatabaseProps,
  {
    /** Full resource name. */
    name: string;
    /** Database id (last path segment). */
    databaseId: string;
    /** Parent catalog resource name. */
    catalog: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Database type. */
    type: string | undefined;
    /** Hive location URI. */
    locationUri: string | undefined;
    /** User Hive parameters (Alchemy ownership keys stripped). */
    parameters: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** RFC3339 deletion timestamp, if soft-deleted. */
    deleteTime: string | undefined;
    /** RFC3339 expire timestamp after delete. */
    expireTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Hive database inside a BigLake Metastore catalog.
 *
 * Databases have no labels field — Alchemy stamps ownership into
 * `hiveOptions.parameters` so `list` / nuke can find them. Catalog,
 * database id, and type are immutable. Hive location URI and parameters
 * update in place.
 *
 * ### Creating a Database
 * **Example:** Hive database on a GCS prefix
 * ```typescript
 * const catalog = yield* GCP.BigLake.Catalog("Lake", {});
 * const database = yield* GCP.BigLake.CatalogsDatabase("Warehouse", {
 *   catalog: catalog.name,
 *   locationUri: `gs://${bucket.bucketName}/warehouse`,
 *   parameters: { owner: "analytics" },
 * });
 * ```
 *
 * **Example:** Named database
 * ```typescript
 * const database = yield* GCP.BigLake.CatalogsDatabase("Warehouse", {
 *   catalog: catalog.name,
 *   databaseId: "sales",
 *   type: "HIVE",
 *   hiveOptions: {
 *     locationUri: "gs://my-bucket/sales",
 *   },
 * });
 * ```
 *
 * @resource
 * @category BigLake
 */
export const CatalogsDatabase = Resource<CatalogsDatabase>(
  "GCP.BigLake.CatalogsDatabase",
);

const catalogOf = (catalog: string, project: string, location: string) =>
  expandCatalog(catalog, project, location);

const resourceName = (catalog: string, databaseId: string) =>
  `${catalog}/databases/${databaseId}`;

const parametersOf = (database: biglake.Database) =>
  userLabels(database.hiveOptions?.parameters);

const toAttrs = (database: biglake.Database, project: string) => {
  const name = database.name ?? "";
  const parsed = parseResourceName(name, "databases");
  return {
    name,
    databaseId: parsed.id,
    catalog: parsed.parent,
    project,
    location: parsed.location,
    type: database.type,
    locationUri: database.hiveOptions?.locationUri,
    parameters: parametersOf(database),
    createTime: database.createTime,
    updateTime: database.updateTime,
    deleteTime: database.deleteTime,
    expireTime: database.expireTime,
  };
};

const getByName = missingGet(biglake.getProjectsLocationsCatalogsDatabases);

const desiredHiveOptions = (
  news: CatalogsDatabaseProps,
  parameters: Record<string, string>,
): biglake.HiveDatabaseOptions => ({
  locationUri: news.hiveOptions?.locationUri ?? news.locationUri,
  parameters,
});

const emptyAndDeleteDatabase = (name: string) =>
  Effect.gen(function* () {
    const tables = yield* listTables(name);
    yield* Effect.forEach(
      namedOf(tables),
      (table) =>
        ignoreGone(
          biglake.deleteProjectsLocationsCatalogsDatabasesTables({
            name: table.name!,
          }),
        ),
      { concurrency: 4 },
    );
    yield* ignoreGone(
      biglake.deleteProjectsLocationsCatalogsDatabases({ name }),
    );
  });

export const CatalogsDatabaseProvider = () =>
  Provider.succeed(CatalogsDatabase, {
    stables: [
      "name",
      "databaseId",
      "catalog",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const typeChanged =
        (olds?.type ?? output?.type) !== undefined &&
        (news.type ?? "HIVE") !== (olds?.type ?? output?.type);
      if (typeChanged) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return replaceOnIdentity({
        previousId: olds?.databaseId ?? output?.databaseId,
        nextId: news.databaseId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: location,
        previousParent: olds?.catalog ?? output?.catalog,
        nextParent: catalogOf(news.catalog, env.project, location),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const databaseId = yield* toPhysicalId(
        id,
        olds?.databaseId,
        output?.databaseId,
      );
      const catalog =
        olds?.catalog !== undefined
          ? catalogOf(olds.catalog, env.project, location)
          : (output?.catalog ?? "");
      const name =
        output?.name ??
        (catalog.length > 0 ? resourceName(catalog, databaseId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(
        id,
        tagRecord(existing.hiveOptions?.parameters),
      ))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const catalogs = (yield* Effect.forEach(
          listLocations(env.region),
          (location) => listCatalogs(locationParent(env.project, location)),
        )).flat();
        const databases = yield* listChildResources(
          namedOf(catalogs),
          listDatabases,
        );
        return databases
          .filter((item) => hasAlchemyLabelMap(item.hiveOptions?.parameters))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const catalog = catalogOf(news.catalog, env.project, location);
      const databaseId = yield* toPhysicalId(
        id,
        news.databaseId,
        output?.databaseId,
      );
      const name = output?.name ?? resourceName(catalog, databaseId);
      const type = news.type ?? "HIVE";
      const parameters = mergeParameters(
        news.parameters ?? news.hiveOptions?.parameters,
        yield* createInternalLabels(id),
      );
      const hiveOptions = desiredHiveOptions(news, parameters);
      const body: biglake.Database = { type, hiveOptions };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          biglake.createProjectsLocationsCatalogsDatabases({
            parent: catalog,
            databaseId,
            body,
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new BiglakeNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const typeChanged = !sameText(current.type, type);
      const hiveChanged = !sameJson(current.hiveOptions, hiveOptions);

      if (typeChanged || hiveChanged) {
        current = yield* retryTransient(
          biglake.patchProjectsLocationsCatalogsDatabases({
            name: currentName,
            updateMask: updateMaskOf(
              typeChanged ? "type" : undefined,
              hiveChanged ? "hiveOptions" : undefined,
            ),
            body: { name: currentName, ...body },
          }),
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* emptyAndDeleteDatabase(output.name);
      yield* waitUntilGone(getByName(output.name));
    }),
  });
