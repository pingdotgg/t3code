import * as s3tables from "@distilled.cloud/aws/s3tables";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { TableBucketArn } from "./TableBucket.ts";

/**
 * A field in an Apache Iceberg table schema.
 */
export interface IcebergSchemaField {
  /**
   * Name of the field.
   */
  name: string;
  /**
   * Iceberg field type, e.g. `int`, `long`, `string`, `boolean`,
   * `timestamp`, `date`, `decimal(10,2)`.
   */
  type: string;
  /**
   * Whether the field is required (non-nullable).
   * @default false
   */
  required?: boolean;
}

export interface TableProps {
  /**
   * ARN of the table bucket that owns the table. Changing it replaces the
   * table.
   */
  tableBucket: TableBucketArn | string;
  /**
   * Name of the namespace that owns the table. Changing it replaces the
   * table.
   */
  namespace: string;
  /**
   * Name of the table. Must be 1-255 characters of lowercase letters,
   * numbers, and underscores, beginning with a letter or number. Changing
   * the name replaces the table.
   * @default a deterministic name derived from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Open table format. Only `ICEBERG` is supported.
   * @default "ICEBERG"
   */
  format?: "ICEBERG";
  /**
   * Iceberg schema for the table, applied at create time. Schema evolution
   * after creation is a data-plane concern; changing this replaces the
   * table.
   */
  schema?: {
    /**
     * Ordered list of schema fields.
     */
    fields: IcebergSchemaField[];
  };
}

export interface Table extends Resource<
  "AWS.S3Tables.Table",
  TableProps,
  {
    tableArn: string;
    name: string;
    namespace: string;
    tableBucketArn: string;
    versionToken: string;
    metadataLocation: string | undefined;
    warehouseLocation: string;
    format: string;
    type: string;
    createdAt: Date;
  },
  never,
  Providers
> {}

/**
 * A fully-managed Apache Iceberg table within an S3 Tables {@link Namespace}.
 *
 * S3 Tables manages the table's storage, metadata, and maintenance
 * (compaction, snapshot expiration). Query it through engines like Amazon
 * Athena, Amazon EMR, or Apache Spark via the S3 Tables Iceberg catalog.
 * @resource
 * @section Creating Tables
 * @example Table with an Iceberg schema
 * ```typescript
 * import * as S3Tables from "alchemy/AWS/S3Tables";
 *
 * const bucket = yield* S3Tables.TableBucket("Analytics");
 * const ns = yield* S3Tables.Namespace("Events", {
 *   tableBucket: bucket.tableBucketArn,
 * });
 * const table = yield* S3Tables.Table("PageViews", {
 *   tableBucket: bucket.tableBucketArn,
 *   namespace: ns.namespace,
 *   schema: {
 *     fields: [
 *       { name: "id", type: "long", required: true },
 *       { name: "url", type: "string" },
 *       { name: "ts", type: "timestamp" },
 *     ],
 *   },
 * });
 * ```
 */
export const Table = Resource<Table>("AWS.S3Tables.Table");

const createTableName = (id: string, props: { name?: string | undefined }) =>
  Effect.gen(function* () {
    if (props.name) {
      return props.name;
    }
    // Table names allow lowercase letters, numbers, and underscores only.
    const base = yield* createPhysicalName({
      id,
      maxLength: 60,
      lowercase: true,
    });
    return base.replaceAll("-", "_");
  });

const buildMetadata = (
  props: TableProps,
): s3tables.TableMetadata | undefined =>
  props.schema
    ? {
        iceberg: {
          schema: {
            fields: props.schema.fields.map((f) => ({
              name: f.name,
              type: f.type,
              required: f.required,
            })),
          },
        },
      }
    : undefined;

export const TableProvider = () =>
  Provider.succeed(Table, {
    stables: ["tableArn", "name", "namespace", "tableBucketArn"],
    // Tables are scoped to a parent namespace; the engine drives lifecycle
    // from state rather than ambient enumeration.
    list: () => Effect.succeed([]),
    read: Effect.fn(function* ({ id, olds, output }) {
      const tableBucketArn = output?.tableBucketArn ?? olds?.tableBucket;
      const namespace = output?.namespace ?? olds?.namespace;
      if (typeof tableBucketArn !== "string" || typeof namespace !== "string") {
        return undefined;
      }
      const name = output?.name ?? (yield* createTableName(id, olds ?? {}));
      return yield* s3tables
        .getTable({ tableBucketARN: tableBucketArn, namespace, name })
        .pipe(
          Effect.map((t): Table["Attributes"] => ({
            tableArn: t.tableARN,
            name: t.name,
            namespace: t.namespace[0] ?? namespace,
            tableBucketArn,
            versionToken: t.versionToken,
            metadataLocation: t.metadataLocation,
            warehouseLocation: t.warehouseLocation,
            format: t.format,
            type: t.type,
            createdAt: t.createdAt,
          })),
          Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
        );
    }),
    diff: Effect.fn(function* ({ id, news, olds }) {
      if (!isResolved(news)) return;
      if (
        news.tableBucket !== olds?.tableBucket ||
        news.namespace !== olds?.namespace
      ) {
        return { action: "replace" } as const;
      }
      const oldName = yield* createTableName(id, olds ?? {});
      const newName = yield* createTableName(id, news);
      if (oldName !== newName) {
        return { action: "replace" } as const;
      }
      if ((news.format ?? "ICEBERG") !== (olds?.format ?? "ICEBERG")) {
        return { action: "replace" } as const;
      }
      // Schema is fixed at create time; schema evolution is out of band.
      const oldSchema = JSON.stringify(olds?.schema ?? null);
      const newSchema = JSON.stringify(news.schema ?? null);
      if (oldSchema !== newSchema) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const tableBucketArn = news.tableBucket as string;
      const namespace = news.namespace as string;
      const name = output?.name ?? (yield* createTableName(id, news));

      // Observe — read live state; the table may have been deleted
      // out-of-band even if `output` cached its ARN.
      let table = yield* s3tables
        .getTable({ tableBucketARN: tableBucketArn, namespace, name })
        .pipe(
          Effect.map((t) => t),
          Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
        );

      // Ensure — create if missing, tolerating a concurrent create.
      if (table === undefined) {
        yield* s3tables
          .createTable({
            tableBucketARN: tableBucketArn,
            namespace,
            name,
            format: news.format ?? "ICEBERG",
            metadata: buildMetadata(news),
          })
          .pipe(
            Effect.asVoid,
            Effect.catchTag("ConflictException", () => Effect.void),
          );
        // Eventual consistency: getTable can briefly 404 a table that
        // createTable just returned.
        table = yield* s3tables
          .getTable({ tableBucketARN: tableBucketArn, namespace, name })
          .pipe(
            Effect.retry({
              while: (e) => e._tag === "NotFoundException",
              schedule: Schedule.max([
                Schedule.exponential(500),
                Schedule.recurs(8),
              ]),
            }),
          );
      }

      yield* session.note(table.tableARN);
      return {
        tableArn: table.tableARN,
        name: table.name,
        namespace: table.namespace[0] ?? namespace,
        tableBucketArn,
        versionToken: table.versionToken,
        metadataLocation: table.metadataLocation,
        warehouseLocation: table.warehouseLocation,
        format: table.format,
        type: table.type,
        createdAt: table.createdAt,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      // Deliberately NO versionToken: destroy is unconditional. Runtime
      // commits (UpdateTableMetadataLocation) rotate the token, so the
      // persisted one may be stale and would fail with ConflictException.
      yield* s3tables
        .deleteTable({
          tableBucketARN: output.tableBucketArn,
          namespace: output.namespace,
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
    }),
  });
