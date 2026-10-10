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
  expandDatabase,
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

export type SerDeInfo = {
  /**
   * Fully qualified Java class name of the serialization library.
   */
  serializationLib?: string;
};

export type StorageDescriptor = {
  /**
   * Cloud Storage folder URI where the table data is stored, starting
   * with `gs://`.
   */
  locationUri?: string;
  /**
   * Fully qualified Java class name of the input format.
   */
  inputFormat?: string;
  /**
   * Fully qualified Java class name of the output format.
   */
  outputFormat?: string;
  /**
   * Serializer and deserializer information.
   */
  serdeInfo?: SerDeInfo;
};

export type HiveTableOptions = {
  /**
   * Hive table type (`MANAGED_TABLE`, `EXTERNAL_TABLE`, …).
   */
  tableType?: string;
  /**
   * User-supplied Hive table parameters. Alchemy ownership keys
   * (`alchemy-stack`, `alchemy-stage`, `alchemy-id`) are merged in
   * automatically — BigLake tables have no labels field.
   */
  parameters?: Record<string, string>;
  /**
   * Physical storage information of the data.
   */
  storageDescriptor?: StorageDescriptor;
};

export type CatalogsDatabasesTableProps = {
  /**
   * Parent database. Full name
   * `projects/{project}/locations/{location}/catalogs/{catalog}/databases/{database}`
   * or the database id (combined with `catalog` and `location`).
   * Immutable — changing it replaces the table.
   */
  database: string;
  /**
   * Parent catalog used when `database` is a bare id.
   */
  catalog?: string;
  /**
   * Table id (the `{table}` segment). If omitted, a unique id is
   * generated. Immutable — changing it replaces the table.
   */
  tableId?: string;
  /**
   * Location used when `database` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Table type.
   * @default "HIVE"
   */
  type?: biglake.TableTypeEnum | (string & {});
  /**
   * Hive table options. Required when `type` is `HIVE`.
   */
  hiveOptions?: HiveTableOptions;
};

export type CatalogsDatabasesTable = Resource<
  "GCP.BigLake.CatalogsDatabasesTable",
  CatalogsDatabasesTableProps,
  {
    /** Full resource name. */
    name: string;
    /** Table id (last path segment). */
    tableId: string;
    /** Parent database resource name. */
    database: string;
    /** Parent catalog resource name. */
    catalog: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Table type. */
    type: string | undefined;
    /** Hive table type (`MANAGED_TABLE`, `EXTERNAL_TABLE`, …). */
    tableType: string | undefined;
    /** User Hive parameters (Alchemy ownership keys stripped). */
    parameters: Record<string, string>;
    /** Physical storage descriptor. */
    storageDescriptor: StorageDescriptor | undefined;
    /** Server checksum used for optimistic updates. */
    etag: string | undefined;
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
 * A Hive table inside a BigLake Metastore database.
 *
 * Tables have no labels field — Alchemy stamps ownership into
 * `hiveOptions.parameters` so `list` / nuke can find them. Database,
 * table id, and type are immutable. Hive options update in place.
 *
 * ### Creating a Table
 * **Example:** Managed Hive table
 * ```typescript
 * const table = yield* GCP.BigLake.CatalogsDatabasesTable("Events", {
 *   database: database.name,
 *   hiveOptions: {
 *     tableType: "MANAGED_TABLE",
 *     storageDescriptor: {
 *       locationUri: `gs://${bucket.bucketName}/events`,
 *       inputFormat: "org.apache.hadoop.mapred.SequenceFileInputFormat",
 *       outputFormat:
 *         "org.apache.hadoop.hive.ql.io.HiveSequenceFileOutputFormat",
 *     },
 *     parameters: { owner: "analytics" },
 *   },
 * });
 * ```
 *
 * **Example:** Named external table
 * ```typescript
 * const table = yield* GCP.BigLake.CatalogsDatabasesTable("Events", {
 *   database: database.name,
 *   tableId: "page_views",
 *   hiveOptions: {
 *     tableType: "EXTERNAL_TABLE",
 *     storageDescriptor: {
 *       locationUri: "gs://my-bucket/page_views",
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @category BigLake
 */
export const CatalogsDatabasesTable = Resource<CatalogsDatabasesTable>(
  "GCP.BigLake.CatalogsDatabasesTable",
);

const databaseOf = (
  database: string,
  project: string,
  location: string,
  catalog?: string,
) => expandDatabase(database, project, location, catalog);

const resourceName = (database: string, tableId: string) =>
  `${database}/tables/${tableId}`;

const storageDescriptorOf = (
  descriptor: biglake.StorageDescriptor | undefined,
): StorageDescriptor | undefined => {
  if (descriptor === undefined) return undefined;
  return {
    locationUri: descriptor.locationUri,
    inputFormat: descriptor.inputFormat,
    outputFormat: descriptor.outputFormat,
    serdeInfo: descriptor.serdeInfo,
  };
};

const toAttrs = (table: biglake.Table, project: string) => {
  const name = table.name ?? "";
  const parsed = parseResourceName(name, "tables");
  const catalogParsed = parseResourceName(parsed.parent, "databases");
  return {
    name,
    tableId: parsed.id,
    database: parsed.parent,
    catalog: catalogParsed.parent,
    project,
    location: parsed.location,
    type: table.type,
    tableType: table.hiveOptions?.tableType,
    parameters: userLabels(table.hiveOptions?.parameters),
    storageDescriptor: storageDescriptorOf(
      table.hiveOptions?.storageDescriptor,
    ),
    etag: table.etag,
    createTime: table.createTime,
    updateTime: table.updateTime,
    deleteTime: table.deleteTime,
    expireTime: table.expireTime,
  };
};

const getByName = missingGet(
  biglake.getProjectsLocationsCatalogsDatabasesTables,
);

const desiredHiveOptions = (
  news: CatalogsDatabasesTableProps,
  parameters: Record<string, string>,
): biglake.HiveTableOptions => ({
  tableType: news.hiveOptions?.tableType,
  parameters,
  storageDescriptor: news.hiveOptions?.storageDescriptor,
});

export const CatalogsDatabasesTableProvider = () =>
  Provider.succeed(CatalogsDatabasesTable, {
    stables: [
      "name",
      "tableId",
      "database",
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
        previousId: olds?.tableId ?? output?.tableId,
        nextId: news.tableId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: location,
        previousParent: olds?.database ?? output?.database,
        nextParent: databaseOf(
          news.database,
          env.project,
          location,
          news.catalog,
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const tableId = yield* toPhysicalId(id, olds?.tableId, output?.tableId);
      const database =
        olds?.database !== undefined
          ? databaseOf(olds.database, env.project, location, olds.catalog)
          : (output?.database ?? "");
      const name =
        output?.name ??
        (database.length > 0 ? resourceName(database, tableId) : "");
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
        const tables = yield* listChildResources(
          namedOf(databases),
          listTables,
        );
        return tables
          .filter((item) => hasAlchemyLabelMap(item.hiveOptions?.parameters))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const database = databaseOf(
        news.database,
        env.project,
        location,
        news.catalog,
      );
      const tableId = yield* toPhysicalId(id, news.tableId, output?.tableId);
      const name = output?.name ?? resourceName(database, tableId);
      const type = news.type ?? "HIVE";
      const parameters = mergeParameters(
        news.hiveOptions?.parameters,
        yield* createInternalLabels(id),
      );
      const hiveOptions = desiredHiveOptions(news, parameters);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          biglake.createProjectsLocationsCatalogsDatabasesTables({
            parent: database,
            tableId,
            body: { type, hiveOptions },
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
          biglake.patchProjectsLocationsCatalogsDatabasesTables({
            name: currentName,
            updateMask: updateMaskOf(
              typeChanged ? "type" : undefined,
              hiveChanged ? "hiveOptions" : undefined,
            ),
            body: {
              name: currentName,
              type,
              hiveOptions,
              etag: current.etag,
            },
          }),
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* ignoreGone(
        biglake.deleteProjectsLocationsCatalogsDatabasesTables({
          name: output.name,
        }),
      );
      yield* waitUntilGone(getByName(output.name));
    }),
  });
