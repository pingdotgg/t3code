import * as glue from "@distilled.cloud/aws/glue";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  cleanMap,
  retryWhileConcurrentModification,
  tableArn,
} from "./internal.ts";

export interface GlueColumn {
  /** Column name. */
  name: string;
  /** Column data type (Hive/Glue type string, e.g. `string`, `bigint`). */
  type?: string;
  /** Free-text comment. */
  comment?: string;
  /** Free-form key/value properties for the column. */
  parameters?: Record<string, string>;
}

export interface GlueSerDeInfo {
  /** Name of the SerDe. */
  name?: string;
  /**
   * The serialization library class, e.g.
   * `org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe`.
   */
  serializationLibrary?: string;
  /** SerDe configuration properties. */
  parameters?: Record<string, string>;
}

export interface GlueStorageDescriptor {
  /** Columns of the table (schema). */
  columns?: GlueColumn[];
  /** Physical location of the data (usually an S3 path). */
  location?: string;
  /**
   * The input format class, e.g.
   * `org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat`.
   */
  inputFormat?: string;
  /**
   * The output format class, e.g.
   * `org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat`.
   */
  outputFormat?: string;
  /** Whether the data is compressed. */
  compressed?: boolean;
  /** Number of buckets used to bucket the table (if `bucketColumns` is set). */
  numberOfBuckets?: number;
  /** Serialization/deserialization metadata. */
  serdeInfo?: GlueSerDeInfo;
  /** Columns the table is bucketed by. */
  bucketColumns?: string[];
  /** Free-form storage descriptor properties. */
  parameters?: Record<string, string>;
  /** Whether the table stores data in subdirectories. */
  storedAsSubDirectories?: boolean;
}

export interface TableProps {
  /**
   * Name of the database the table belongs to. Changing it replaces the
   * table.
   */
  databaseName: string;
  /**
   * Name of the table. Glue lowercases table names. If omitted, a unique
   * lowercase name is generated. Changing the name replaces the table.
   * @default a generated lowercase physical name
   */
  tableName?: string;
  /**
   * A description of the table.
   */
  description?: string;
  /**
   * The table owner.
   */
  owner?: string;
  /**
   * The type of the table. Common values are `EXTERNAL_TABLE`,
   * `GOVERNED`, and `VIRTUAL_VIEW`.
   * @default "EXTERNAL_TABLE"
   */
  tableType?: string;
  /**
   * Retention time (in days) for the table.
   */
  retention?: number;
  /**
   * The physical storage descriptor: columns (schema), data location, input/
   * output formats, and SerDe. This is what Athena reads to query the data.
   */
  storageDescriptor?: GlueStorageDescriptor;
  /**
   * Partition keys. Athena prunes partitions on these columns. Note: changing
   * partition keys after creation requires `Force`; Alchemy sends the desired
   * set on every update.
   */
  partitionKeys?: GlueColumn[];
  /**
   * Free-form key/value properties stored on the table. Alchemy adds its own
   * `alchemy::*` ownership markers here (Glue tables are not ARN-taggable) —
   * user keys are preserved.
   */
  parameters?: Record<string, string>;
  /**
   * The AWS account ID of the Data Catalog. Changing it replaces the table.
   * @default the caller's account (the default Data Catalog)
   */
  catalogId?: string;
}

export interface Table extends Resource<
  "AWS.Glue.Table",
  TableProps,
  {
    /** The (lowercase) name of the table. */
    tableName: string;
    /** The name of the database the table belongs to. */
    databaseName: string;
    /** The ARN of the table. */
    tableArn: string;
    /** The AWS account ID of the Data Catalog the table lives in. */
    catalogId: string;
  },
  {},
  Providers
> {}

/**
 * An AWS Glue Data Catalog table — a schema (columns), storage location, and
 * SerDe over data in S3 (or another store). This is the unit Athena, Redshift
 * Spectrum, and EMR query; it is the analytics foundation of a Glue database.
 * @resource
 * @section Creating Tables
 * @example Parquet Table over S3
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const database = yield* AWS.Glue.Database("Analytics", {
 *   databaseName: "analytics",
 * });
 *
 * const events = yield* AWS.Glue.Table("Events", {
 *   databaseName: database.databaseName,
 *   tableName: "events",
 *   tableType: "EXTERNAL_TABLE",
 *   storageDescriptor: {
 *     location: "s3://my-data-lake/events/",
 *     inputFormat:
 *       "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat",
 *     outputFormat:
 *       "org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat",
 *     serdeInfo: {
 *       serializationLibrary:
 *         "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe",
 *     },
 *     columns: [
 *       { name: "id", type: "string" },
 *       { name: "amount", type: "double" },
 *     ],
 *   },
 *   partitionKeys: [{ name: "dt", type: "string" }],
 *   parameters: { classification: "parquet" },
 * });
 * ```
 */
export const Table = Resource<Table>("AWS.Glue.Table");

const toColumn = (column: GlueColumn) => ({
  Name: column.name,
  Type: column.type,
  Comment: column.comment,
  Parameters: column.parameters,
});

export const TableProvider = () =>
  Provider.effect(
    Table,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { tableName?: string | undefined },
      ) {
        return (
          props.tableName ??
          (yield* createPhysicalName({ id, maxLength: 255, lowercase: true }))
        );
      });

      const observe = Effect.fn(function* (
        databaseName: string,
        name: string,
        catalogId: string | undefined,
      ) {
        return yield* glue
          .getTable({
            DatabaseName: databaseName,
            Name: name,
            CatalogId: catalogId,
          })
          .pipe(
            Effect.map((r) => r.Table),
            Effect.catchTag("EntityNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const buildTableInput = (name: string, props: TableProps) => {
        const sd = props.storageDescriptor;
        return {
          Name: name,
          Description: props.description,
          Owner: props.owner,
          Retention: props.retention,
          TableType: props.tableType ?? "EXTERNAL_TABLE",
          StorageDescriptor: sd
            ? {
                Columns: sd.columns?.map(toColumn),
                Location: sd.location,
                InputFormat: sd.inputFormat,
                OutputFormat: sd.outputFormat,
                Compressed: sd.compressed,
                NumberOfBuckets: sd.numberOfBuckets,
                SerdeInfo: sd.serdeInfo
                  ? {
                      Name: sd.serdeInfo.name,
                      SerializationLibrary: sd.serdeInfo.serializationLibrary,
                      Parameters: sd.serdeInfo.parameters,
                    }
                  : undefined,
                BucketColumns: sd.bucketColumns,
                Parameters: sd.parameters,
                StoredAsSubDirectories: sd.storedAsSubDirectories,
              }
            : undefined,
          PartitionKeys: props.partitionKeys?.map(toColumn),
        };
      };

      return Table.Provider.of({
        stables: ["tableName", "databaseName", "tableArn", "catalogId"],

        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const dbPages = yield* glue.getDatabases
              .pages({})
              .pipe(Stream.runCollect);
            const databases = Array.from(dbPages).flatMap(
              (page) => page.DatabaseList ?? [],
            );
            const nested = yield* Effect.forEach(
              databases,
              (db) =>
                Effect.gen(function* () {
                  const tablePages = yield* glue.getTables
                    .pages({ DatabaseName: db.Name, CatalogId: db.CatalogId })
                    .pipe(
                      Stream.runCollect,
                      Effect.map((chunk) => Array.from(chunk)),
                      Effect.catchTag("EntityNotFoundException", () =>
                        Effect.succeed([] as glue.GetTablesResponse[]),
                      ),
                    );
                  return tablePages
                    .flatMap((page) => page.TableList ?? [])
                    .map((table) => ({
                      tableName: table.Name,
                      databaseName: table.DatabaseName ?? db.Name,
                      tableArn: tableArn(
                        region,
                        table.CatalogId ?? db.CatalogId ?? accountId,
                        table.DatabaseName ?? db.Name,
                        table.Name,
                      ),
                      catalogId: table.CatalogId ?? db.CatalogId ?? accountId,
                    }));
                }),
              { concurrency: 5 },
            );
            return nested.flat();
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const databaseName = output?.databaseName ?? olds?.databaseName;
          if (databaseName === undefined) return undefined;
          const catalogId = output?.catalogId ?? olds?.catalogId ?? accountId;
          const name = output?.tableName ?? (yield* createName(id, olds ?? {}));
          const table = yield* observe(databaseName, name, catalogId);
          if (table === undefined) return undefined;
          const attrs = {
            tableName: table.Name,
            databaseName: table.DatabaseName ?? databaseName,
            tableArn: tableArn(
              region,
              table.CatalogId ?? catalogId,
              table.DatabaseName ?? databaseName,
              table.Name,
            ),
            catalogId: table.CatalogId ?? catalogId,
          };
          return (yield* hasAlchemyTags(id, cleanMap(table.Parameters)))
            ? attrs
            : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          if (olds.databaseName !== news.databaseName) {
            return { action: "replace" } as const;
          }
          if ((olds.catalogId ?? undefined) !== (news.catalogId ?? undefined)) {
            return { action: "replace" } as const;
          }
          // schema / storage / partition keys / parameters → update
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const catalogId = news.catalogId ?? output?.catalogId ?? accountId;
          const name = output?.tableName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const tableInput = {
            ...buildTableInput(name, news),
            Parameters: { ...news.parameters, ...internalTags },
          };

          // 1. OBSERVE
          let table = yield* observe(news.databaseName, name, catalogId);

          // 2. ENSURE / 3. SYNC
          if (table === undefined) {
            yield* glue
              .createTable({
                CatalogId: catalogId,
                DatabaseName: news.databaseName,
                TableInput: tableInput,
              })
              .pipe(
                Effect.catchTag("AlreadyExistsException", () => Effect.void),
                retryWhileConcurrentModification,
              );
          } else {
            // UpdateTable replaces the full TableInput. Force lets partition
            // keys change without a version conflict.
            yield* glue
              .updateTable({
                CatalogId: catalogId,
                DatabaseName: news.databaseName,
                TableInput: tableInput,
                Force: true,
              })
              .pipe(retryWhileConcurrentModification);
          }
          table = yield* observe(news.databaseName, name, catalogId);

          yield* session.note(name);
          return {
            tableName: name,
            databaseName: news.databaseName,
            tableArn: tableArn(
              region,
              table?.CatalogId ?? catalogId,
              news.databaseName,
              name,
            ),
            catalogId: table?.CatalogId ?? catalogId,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* glue
            .deleteTable({
              CatalogId: output.catalogId,
              DatabaseName: output.databaseName,
              Name: output.tableName,
            })
            .pipe(
              retryWhileConcurrentModification,
              Effect.catchTag("EntityNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
