import * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_NAME_LENGTH = 1024;
const DEFAULT_TYPE = "TABLE";

const TYPE_ALIASES: Record<string, string> = {
  INT64: "INTEGER",
  FLOAT64: "FLOAT",
  BOOL: "BOOLEAN",
  STRUCT: "RECORD",
};

export type TableField = {
  /** Field name. Letters, numbers, underscores; max 300 characters. */
  name: string;
  /**
   * Field type (`STRING`, `INTEGER`/`INT64`, `FLOAT`/`FLOAT64`,
   * `BOOLEAN`/`BOOL`, `TIMESTAMP`, `DATE`, `RECORD`/`STRUCT`, …).
   */
  type: string;
  /**
   * Field mode (`NULLABLE`, `REQUIRED`, `REPEATED`).
   * @default "NULLABLE"
   */
  mode?: string;
  /** Field description. Max 1,024 characters. */
  description?: string;
  /** Nested fields when `type` is `RECORD` / `STRUCT`. */
  fields?: TableField[];
  /** Max UTF-8 length (`STRING`) or byte length (`BYTES`). */
  maxLength?: string;
  /** Precision for `NUMERIC` / `BIGNUMERIC`. */
  precision?: string;
  /** Scale for `NUMERIC` / `BIGNUMERIC`. */
  scale?: string;
  /** SQL expression for the column default. */
  defaultValueExpression?: string;
  /** Collation for `STRING` fields (`und:ci` or `""`). */
  collation?: string;
};

export type TableTimePartitioning = {
  /**
   * Partition granularity (`DAY`, `HOUR`, `MONTH`, `YEAR`). Immutable —
   * changing it replaces the table.
   */
  type: string;
  /**
   * Partitioning column (`TIMESTAMP` or `DATE`). Omit to use
   * `_PARTITIONTIME`. Immutable — changing it replaces the table.
   */
  field?: string;
  /** Partition expiration in milliseconds. */
  expirationMs?: string;
};

export type TableClustering = {
  /** Top-level clustering columns, most selective first. */
  fields?: string[];
};

export type TableProps = {
  /**
   * Dataset id (the `{dataset}` segment of
   * `projects/{project}/datasets/{dataset}`) or a full dataset resource
   * name. Immutable — changing it replaces the table.
   */
  datasetId: string;
  /**
   * Table id (the `{table}` segment of
   * `projects/{project}/datasets/{dataset}/tables/{table}`). If omitted,
   * a unique name is generated from the stack, stage, and logical id.
   * Must contain only letters, numbers, and underscores; max 1,024
   * characters. Immutable — changing it replaces the table.
   */
  tableId?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Table schema. Adding columns updates in place; removing or changing
   * the type of an existing column is rejected by BigQuery.
   */
  schema?: TableField[];
  /** User-friendly description of this table. */
  description?: string;
  /** Descriptive display name. */
  friendlyName?: string;
  /**
   * Expiration time as milliseconds since the Unix epoch (string). Omit
   * for no expiration.
   */
  expirationTime?: string;
  /**
   * Time-based partitioning. `type` and `field` are immutable.
   */
  timePartitioning?: TableTimePartitioning;
  /**
   * Clustering columns. Usually combined with time partitioning.
   */
  clustering?: TableClustering;
  /**
   * Require a partition filter in queries that can be used for partition
   * elimination.
   * @default false
   */
  requirePartitionFilter?: boolean;
  /**
   * Cloud KMS key used to encrypt table data, as
   * `projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`.
   * Immutable — changing it replaces the table.
   */
  kmsKeyName?: string;
};

export type Table = Resource<
  "GCP.BigQuery.Table",
  TableProps,
  {
    /**
     * Resource path `projects/{project}/datasets/{dataset}/tables/{table}`.
     */
    name: string;
    /** Opaque id `project:dataset.table`. */
    id: string;
    /** Table id (last path segment). */
    tableId: string;
    /** Dataset id. */
    datasetId: string;
    /** Project id. */
    project: string;
    /** Table type (`TABLE`, `VIEW`, `EXTERNAL`, …). */
    type: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Schema fields, if set. */
    schema: TableField[] | undefined;
    /** Description, if set. */
    description: string | undefined;
    /** Friendly name, if set. */
    friendlyName: string | undefined;
    /** Expiration time in milliseconds since epoch, if set. */
    expirationTime: string | undefined;
    /** Dataset location (`US`, `us-central1`, …). */
    location: string | undefined;
    /** Time partitioning, if configured. */
    timePartitioning: TableTimePartitioning | undefined;
    /** Clustering, if configured. */
    clustering: TableClustering | undefined;
    /** Whether queries must specify a partition filter. */
    requirePartitionFilter: boolean;
    /** CMEK key, if set. */
    kmsKeyName: string | undefined;
    /** Creation time in milliseconds since epoch. */
    creationTime: string | undefined;
    /** Row count, excluding the streaming buffer. */
    numRows: string | undefined;
    /** Self-link URL. */
    selfLink: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google BigQuery table.
 *
 * Native tables only — views, materialized views, snapshots, and external
 * tables are not managed by this resource. `datasetId`, `tableId`, time
 * partitioning `type`/`field`, and `kmsKeyName` are immutable (changing
 * them replaces the table). Schema, labels, description, clustering, and
 * partition expiration update in place.
 *
 * ### Creating a Table
 * **Example:** Generated name in an existing dataset
 * ```typescript
 * const events = yield* GCP.BigQuery.Table("Events", {
 *   datasetId: "analytics",
 *   schema: [
 *     { name: "id", type: "STRING" },
 *     { name: "created_at", type: "TIMESTAMP" },
 *   ],
 * });
 * ```
 *
 * **Example:** Explicit id, labels, and partitioning
 * ```typescript
 * const events = yield* GCP.BigQuery.Table("Events", {
 *   datasetId: "analytics",
 *   tableId: "order_events",
 *   labels: { env: "prod" },
 *   schema: [
 *     { name: "id", type: "STRING" },
 *     { name: "created_at", type: "TIMESTAMP" },
 *   ],
 *   timePartitioning: { type: "DAY", field: "created_at" },
 *   clustering: { fields: ["id"] },
 * });
 * ```
 *
 * ### Inserting Rows
 * **Example:** Stream rows with InsertAll
 * ```typescript
 * const insertAll = yield* GCP.BigQuery.InsertAll(events);
 * yield* insertAll({
 *   body: { rows: [{ json: { id: "1", created_at: "2024-01-01T00:00:00Z" } }] },
 * });
 * ```
 *
 * @resource
 * @category BigQuery
 */
export const Table = Resource<Table>("GCP.BigQuery.Table");

export class TableNotResolved extends Data.TaggedError(
  "GCP.BigQuery.TableNotResolved",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const datasetIdOf = (datasetId: string) =>
  datasetId.includes("/") ? lastSegment(datasetId) : datasetId;

const resourceName = (project: string, datasetId: string, tableId: string) =>
  `projects/${project}/datasets/${datasetId}/tables/${tableId}`;

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (id: string, tableId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (tableId !== undefined) return tableId;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
      delimiter: "_",
    });
    return generated.replaceAll("-", "_");
  });

const toFieldSchema = (fields: TableField[]): bigquery.TableFieldSchema[] =>
  fields.map((field) => ({
    name: field.name,
    type: field.type,
    mode: field.mode,
    description: field.description,
    fields: field.fields ? toFieldSchema(field.fields) : undefined,
    maxLength: field.maxLength,
    precision: field.precision,
    scale: field.scale,
    defaultValueExpression: field.defaultValueExpression,
    collation: field.collation,
  }));

const schemaOf = (
  schema: bigquery.TableSchema | undefined,
): TableField[] | undefined => {
  const fields = schema?.fields;
  if (fields === undefined || fields.length === 0) return undefined;
  return fields.flatMap((field) =>
    field.name && field.type
      ? [
          {
            name: field.name,
            type: field.type,
            mode: field.mode,
            description: field.description,
            fields: schemaOf({ fields: field.fields }),
            maxLength: field.maxLength,
            precision: field.precision,
            scale: field.scale,
            defaultValueExpression: field.defaultValueExpression,
            collation: field.collation,
          },
        ]
      : [],
  );
};

const normalizeType = (type: string) => {
  const upper = type.toUpperCase();
  return TYPE_ALIASES[upper] ?? upper;
};

const canonField = (field: TableField): unknown => ({
  name: field.name,
  type: normalizeType(field.type),
  mode: (field.mode ?? "NULLABLE").toUpperCase(),
  description: field.description ?? "",
  maxLength: field.maxLength ?? "",
  precision: field.precision ?? "",
  scale: field.scale ?? "",
  defaultValueExpression: field.defaultValueExpression ?? "",
  collation: field.collation ?? "",
  fields: (field.fields ?? []).map(canonField),
});

const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const schemaChanged = (
  desired: TableField[] | undefined,
  observed: bigquery.TableSchema | undefined,
) =>
  desired !== undefined &&
  !jsonEqual(
    desired.map(canonField),
    (schemaOf(observed) ?? []).map(canonField),
  );

const timePartitioningOf = (
  value: bigquery.TimePartitioning | undefined,
): TableTimePartitioning | undefined => {
  if (value?.type === undefined) return undefined;
  return {
    type: value.type,
    field: value.field,
    expirationMs: value.expirationMs,
  };
};

const clusteringOf = (
  value: bigquery.Clustering | undefined,
): TableClustering | undefined => {
  const fields = (value?.fields ?? []).filter(
    (field): field is string => field !== undefined && field.length > 0,
  );
  return fields.length > 0 ? { fields } : undefined;
};

const sameOptionalString = (
  left: string | undefined,
  right: string | undefined,
) => (left ?? "") === (right ?? "");

const toAttrs = (
  table: bigquery.Table | bigquery.TableListTablesItem,
  project: string,
) => {
  const full = table as bigquery.Table;
  const ref = table.tableReference;
  const tableId = ref?.tableId ?? "";
  const datasetId = ref?.datasetId ?? "";
  const projectId = ref?.projectId ?? project;
  return {
    name: resourceName(projectId, datasetId, tableId),
    id: full.id ?? `${projectId}:${datasetId}.${tableId}`,
    tableId,
    datasetId,
    project: projectId,
    type: table.type ?? DEFAULT_TYPE,
    labels: userLabels(table.labels),
    schema: schemaOf(full.schema),
    description: full.description,
    friendlyName: table.friendlyName,
    expirationTime: table.expirationTime,
    location: full.location,
    timePartitioning: timePartitioningOf(table.timePartitioning),
    clustering: clusteringOf(table.clustering),
    requirePartitionFilter: table.requirePartitionFilter === true,
    kmsKeyName: full.encryptionConfiguration?.kmsKeyName,
    creationTime: table.creationTime,
    numRows: full.numRows,
    selfLink: full.selfLink,
  };
};

const getByRef = (projectId: string, datasetId: string, tableId: string) =>
  bigquery
    .getTables({
      projectId,
      datasetId,
      tableId,
      view: "FULL",
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toTableBody = (
  projectId: string,
  datasetId: string,
  tableId: string,
  news: TableProps,
  labels: Record<string, string>,
): bigquery.Table => {
  const body: bigquery.Table = {
    tableReference: { projectId, datasetId, tableId },
    labels,
  };
  if (news.schema !== undefined) {
    body.schema = { fields: toFieldSchema(news.schema) };
  }
  if (news.description !== undefined) {
    body.description = news.description;
  }
  if (news.friendlyName !== undefined) {
    body.friendlyName = news.friendlyName;
  }
  if (news.expirationTime !== undefined) {
    body.expirationTime = news.expirationTime;
  }
  if (news.timePartitioning !== undefined) {
    body.timePartitioning = news.timePartitioning;
  }
  if (news.clustering !== undefined) {
    body.clustering = news.clustering;
  }
  if (news.requirePartitionFilter !== undefined) {
    body.requirePartitionFilter = news.requirePartitionFilter;
  }
  if (news.kmsKeyName !== undefined) {
    body.encryptionConfiguration = { kmsKeyName: news.kmsKeyName };
  }
  return body;
};

export const TableProvider = () =>
  Provider.succeed(Table, {
    stables: [
      "name",
      "id",
      "tableId",
      "datasetId",
      "project",
      "location",
      "creationTime",
      "selfLink",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousTableId = olds?.tableId ?? output?.tableId;
      const nextTableId = news.tableId ?? previousTableId;
      const tableIdChanged =
        news.tableId !== undefined &&
        previousTableId !== undefined &&
        news.tableId !== previousTableId;

      const previousDataset = olds?.datasetId ?? output?.datasetId;
      const nextDataset = datasetIdOf(news.datasetId);
      const datasetChanged =
        previousDataset !== undefined &&
        datasetIdOf(previousDataset) !== nextDataset;

      const previousPartition =
        olds?.timePartitioning ?? output?.timePartitioning;
      const nextPartition = news.timePartitioning;
      const partitionChanged =
        nextPartition !== undefined &&
        ((previousPartition?.type ?? "").toUpperCase() !==
          nextPartition.type.toUpperCase() ||
          (previousPartition?.field ?? "") !== (nextPartition.field ?? ""));

      const previousKms = olds?.kmsKeyName ?? output?.kmsKeyName ?? "";
      const nextKms = news.kmsKeyName ?? previousKms;
      const kmsChanged = previousKms !== nextKms;

      if (
        !tableIdChanged &&
        !datasetChanged &&
        !partitionChanged &&
        !kmsChanged
      ) {
        return undefined;
      }
      return {
        action: "replace" as const,
        deleteFirst:
          !tableIdChanged &&
          !datasetChanged &&
          nextTableId !== undefined &&
          previousTableId !== undefined &&
          nextTableId === previousTableId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const tableId = yield* toId(id, olds?.tableId, output?.tableId);
      const datasetId = datasetIdOf(olds?.datasetId ?? output?.datasetId ?? "");
      if (datasetId.length === 0) return undefined;
      const existing = yield* getByRef(env.project, datasetId, tableId);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const datasets = yield* bigquery.listDatasets
          .pages({
            projectId: env.project,
            maxResults: 1000,
            all: true,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.datasets ?? [])),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as bigquery.DatasetListDatasetsItem[]),
            ),
          );
        const pages = yield* Effect.forEach(
          datasets,
          (dataset) => {
            const datasetId = dataset.datasetReference?.datasetId;
            if (datasetId === undefined) {
              return Effect.succeed([] as ReturnType<typeof toAttrs>[]);
            }
            return bigquery.listTables
              .pages({
                projectId: env.project,
                datasetId,
                maxResults: 1000,
              })
              .pipe(
                Stream.flatMap((page) =>
                  Stream.fromIterable(page.tables ?? []),
                ),
                Stream.filter((table) =>
                  Object.keys(table.labels ?? {}).some((key) =>
                    key.startsWith("alchemy-"),
                  ),
                ),
                Stream.map((table) => toAttrs(table, env.project)),
                Stream.runCollect,
                Effect.map((chunk) => Array.from(chunk)),
                Effect.catchTag("NotFound", () =>
                  Effect.succeed([] as ReturnType<typeof toAttrs>[]),
                ),
              );
          },
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const tableId = yield* toId(id, news.tableId, output?.tableId);
      const datasetId = datasetIdOf(news.datasetId);
      const name = resourceName(env.project, datasetId, tableId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByRef(env.project, datasetId, tableId);

      if (current === undefined) {
        const created = yield* bigquery
          .insertTables({
            projectId: env.project,
            datasetId,
            body: toTableBody(
              env.project,
              datasetId,
              tableId,
              news,
              desiredLabels,
            ),
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getByRef(env.project, datasetId, tableId),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new TableNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (removed.length > 0) {
        // PATCH merges labels; removing one needs a JSON null the typed body
        // cannot carry, so replace the labels with PUT (get-modify-put).
        current = yield* bigquery.updateTables({
          projectId: env.project,
          datasetId,
          tableId,
          body: { ...current, labels: desiredLabels },
        });
      }
      const labelsChanged = removed.length === 0 && upsert.length > 0;
      const descriptionChanged =
        news.description !== undefined &&
        !sameOptionalString(news.description, current.description);
      const friendlyNameChanged =
        news.friendlyName !== undefined &&
        !sameOptionalString(news.friendlyName, current.friendlyName);
      const expirationChanged =
        news.expirationTime !== undefined &&
        !sameOptionalString(news.expirationTime, current.expirationTime);
      const fieldsChanged = schemaChanged(news.schema, current.schema);
      const partitionExpirationChanged =
        news.timePartitioning !== undefined &&
        !sameOptionalString(
          news.timePartitioning.expirationMs,
          current.timePartitioning?.expirationMs,
        );
      const clusteringChanged =
        news.clustering !== undefined &&
        !jsonEqual(
          news.clustering.fields ?? [],
          current.clustering?.fields ?? [],
        );
      const requireFilterChanged =
        news.requirePartitionFilter !== undefined &&
        news.requirePartitionFilter !==
          (current.requirePartitionFilter === true);

      if (
        labelsChanged ||
        descriptionChanged ||
        friendlyNameChanged ||
        expirationChanged ||
        fieldsChanged ||
        partitionExpirationChanged ||
        clusteringChanged ||
        requireFilterChanged
      ) {
        const body: bigquery.Table = {};
        if (labelsChanged) body.labels = desiredLabels;
        if (descriptionChanged) body.description = news.description;
        if (friendlyNameChanged) body.friendlyName = news.friendlyName;
        if (expirationChanged) body.expirationTime = news.expirationTime;
        if (fieldsChanged && news.schema !== undefined) {
          body.schema = { fields: toFieldSchema(news.schema) };
        }
        if (partitionExpirationChanged && news.timePartitioning !== undefined) {
          body.timePartitioning = news.timePartitioning;
        }
        if (clusteringChanged && news.clustering !== undefined) {
          body.clustering = news.clustering;
        }
        if (requireFilterChanged) {
          body.requirePartitionFilter = news.requirePartitionFilter;
        }
        current = yield* bigquery.patchTables({
          projectId: env.project,
          datasetId,
          tableId,
          body,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* bigquery
        .deleteTables({
          projectId: output.project,
          datasetId: output.datasetId,
          tableId: output.tableId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
