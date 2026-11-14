import * as basin from "@distilled.cloud/cloudflare/basin_catalog";
import * as Iceberg from "@distilled.cloud/iceberg";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { createInternalTags, hasAlchemyTags } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Formatter from "effect/Formatter";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import type * as Redacted from "effect/Redacted";
import * as S from "effect/Schema";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import type { DataCatalog } from "../R2/DataCatalog.ts";
import {
  assignFieldIds,
  BasinTableSchemaUnsupported,
  destructiveChanges,
  fieldIdsByPath,
  fromIcebergFields,
  maxFieldId,
  normalizeColumns,
  parsePartitionTerm,
  partitionFieldName,
  samePartitionTerms,
  toTableSchema,
  type PartitionTerm,
} from "./internal/schema.ts";

export { BasinTableSchemaUnsupported } from "./internal/schema.ts";

const TypeId = "Cloudflare.Basin.Table" as const;
type TypeId = typeof TypeId;

/**
 * An Iceberg primitive type. Decimals are written `decimal(P, S)` and
 * fixed-length binaries `fixed[N]`.
 */
export type TablePrimitiveType =
  | "boolean"
  | "int"
  | "long"
  | "float"
  | "double"
  | "date"
  | "time"
  | "timestamp"
  | "timestamptz"
  | "timestamp_ns"
  | "timestamptz_ns"
  | "string"
  | "uuid"
  | "binary"
  | `decimal(${number}, ${number})`
  | `decimal(${number},${number})`
  | `fixed[${number}]`;

/** A nested Iceberg struct column type. */
export interface TableStructType {
  type: "struct";
  /** Columns of the struct. */
  fields: TableColumn[];
}

/** An Iceberg list column type. */
export interface TableListType {
  type: "list";
  /** Type of each element. */
  element: TableColumnType;
  /**
   * Whether elements are non-null.
   * @default false
   */
  elementRequired?: boolean;
}

/** An Iceberg map column type. */
export interface TableMapType {
  type: "map";
  /** Type of the keys. */
  key: TableColumnType;
  /** Type of the values. */
  value: TableColumnType;
  /**
   * Whether values are non-null.
   * @default false
   */
  valueRequired?: boolean;
}

/** Any Iceberg column type. */
export type TableColumnType = TablePrimitiveType | TableStructType | TableListType | TableMapType;

/** One column of a table schema. Field ids are assigned by Alchemy. */
export interface TableColumn {
  /** Column name. */
  name: string;
  /** Column type. */
  type: TableColumnType;
  /**
   * Whether the column is non-null.
   * @default false
   */
  required?: boolean;
  /** Column documentation stored in the Iceberg schema. */
  doc?: string;
}

/**
 * A plain Iceberg schema descriptor: the table's top-level columns.
 */
export interface TableSchema {
  /** Top-level columns. */
  fields: TableColumn[];
}

/**
 * A table schema: an Effect Schema `Struct` or `Class`, or a plain
 * {@link TableSchema} descriptor (for types Effect Schema cannot express,
 * like `float`, `decimal(P, S)`, or `date`).
 */
export type TableSchemaInput = S.Schema<any> | TableSchema;

/**
 * What happens to the Iceberg table when the resource is removed from the
 * stack or the stack is destroyed.
 *
 * - `"retain"` — leave the table and its data in the catalog.
 * - `"drop"` — drop the table from the catalog without purging its files.
 * - `"purge"` — drop the table and ask the catalog to purge its data and
 *   metadata files.
 */
export type TableDeletePolicy = "retain" | "drop" | "purge";

/** Target output file size, in MB, of compaction. */
export type TableCompactionTargetSizeMb = "64" | "128" | "256" | "512";

/** Per-table maintenance managed by the Basin catalog. */
export interface TableMaintenance {
  /**
   * Compaction rewrites small data files into larger ones. Omit to leave
   * the table's compaction settings unmanaged.
   */
  compaction?: {
    /**
     * Whether compaction runs.
     * @default true
     */
    enabled?: boolean;
    /** Target output file size, in MB. */
    targetSizeMb?: TableCompactionTargetSizeMb;
  };
  /**
   * Snapshot expiration removes old snapshots. Omit to leave the table's
   * snapshot expiration settings unmanaged.
   */
  snapshotExpiration?: {
    /**
     * Whether snapshot expiration runs.
     * @default true
     */
    enabled?: boolean;
    /**
     * Expire snapshots older than this, e.g. `"7 days"` or
     * `Duration.hours(36)`. Sent to Cloudflare in whole days, hours, or
     * minutes.
     */
    olderThan?: Duration.Input;
    /** Always keep at least this many snapshots. */
    retainLast?: number;
  };
}

export interface TableProps {
  /**
   * The catalog that owns the table: a `Cloudflare.Basin.Catalog` resource
   * (orders the table after the catalog) or the name of the bucket the
   * catalog is enabled on. The table is created in its warehouse. Changing
   * the catalog fails the plan.
   */
  catalog: string | DataCatalog;
  /**
   * Iceberg namespace of the table. Created if it does not exist; never
   * deleted (other tables may share it). Changing the namespace fails the
   * plan.
   */
  namespace: string;
  /**
   * Table name. Changing it fails the plan (Iceberg renames would orphan
   * readers and writers).
   * @default ${app}_${id}_${stage}_${suffix} (lowercase, underscores)
   */
  name?: string;
  /**
   * Table schema. Additive changes (new optional columns, relaxing
   * `required`, `int`→`long`, `float`→`double`, wider decimals, docs,
   * column order) evolve the table in place. Destructive changes (dropping
   * a column, adding a required column, narrowing or changing a type) fail
   * the plan — Alchemy never drops data to replace a table.
   */
  schema: TableSchemaInput;
  /**
   * Partition spec as Iceberg transform terms: a bare column (`"region"`,
   * identity), `"year(at)"`, `"month(at)"`, `"day(at)"`, `"hour(at)"`,
   * `"bucket[16](id)"`, `"truncate[4](name)"`. Immutable: changing it fails
   * the plan.
   */
  partitionBy?: string[];
  /**
   * Iceberg table properties. Synced in place; keys removed from this map
   * are removed from the table. Properties set by the catalog or other
   * writers are left alone.
   */
  properties?: Record<string, string>;
  /**
   * Per-table maintenance (compaction and snapshot expiration). Only the
   * settings you specify are enforced. Enabling a job on a table requires
   * the same job to be enabled on the catalog (`compaction` /
   * `snapshotExpiration` with `state: "enabled"` on the DataCatalog).
   */
  maintenance?: TableMaintenance;
  /**
   * What happens to the table when it is removed from the stack.
   * @default "retain"
   */
  delete?: TableDeletePolicy;
  /**
   * Bearer token for the Iceberg REST catalog. Defaults to the deploying
   * Cloudflare credentials (API token or OAuth access token), which need
   * R2 Data Catalog access.
   */
  token?: Redacted.Redacted<string>;
}

export interface TableAttributes {
  /** Iceberg namespace of the table. */
  namespace: string;
  /** Table name. */
  tableName: string;
  /** `namespace.tableName`, as engines like Spark and DuckDB address it. */
  identifier: string;
  /** Iceberg table UUID. Stable across in-place schema evolution. */
  tableUuid: string;
  /** Base location of the table's files in R2. */
  location: string | undefined;
  /** Location of the current metadata file. */
  metadataLocation: string | undefined;
  /** Iceberg REST catalog URI of the warehouse. */
  catalogUri: string;
  /** Warehouse name (`{accountId}_{bucketName}`). */
  warehouse: string;
  /** The Cloudflare account that owns the catalog. */
  accountId: string;
  /** R2 bucket that backs the catalog. */
  bucketName: string;
  /** Iceberg table format version. */
  formatVersion: number;
  /** Id of the table's current schema. */
  currentSchemaId: number | undefined;
}

export type Table = Resource<TypeId, TableProps, TableAttributes, never, Providers>;

/**
 * A plan-time rejection: the change cannot be applied in place and Alchemy
 * will not replace (drop) an Iceberg table to apply it.
 */
export class BasinTableChangeRejected extends Data.TaggedError(
  "Cloudflare.Basin.TableChangeRejected",
)<{
  message: string;
  table: string;
  reasons: string[];
}> {}

/**
 * The deploying Cloudflare credentials cannot authenticate against the
 * Iceberg REST catalog (global API keys are not bearer tokens).
 */
export class BasinTableCredentialsUnavailable extends Data.TaggedError(
  "Cloudflare.Basin.TableCredentialsUnavailable",
)<{
  message: string;
}> {}

const TableResource = Resource<Table>(TypeId);

// A schema that cannot be lowered is a defect: `Effect.sync` dies with the thrown error.
const toProps = <P>(props: P): Effect.Effect<P> =>
  Effect.sync(() => {
    const p = props as { schema?: unknown } | undefined;
    return p?.schema !== undefined && S.isSchema(p.schema)
      ? ({ ...p, schema: toTableSchema(p.schema as S.Schema<any>) } as P)
      : props;
  });

/**
 * An Apache Iceberg table in a Cloudflare Basin (R2 Data) catalog.
 *
 * Declare the table's schema with Effect Schema; Alchemy derives the Iceberg
 * schema (`String`→`string`, `Boolean`→`boolean`, `Int`→`long` (`int` when
 * bounded to 32 bits), `Number`→`double`, `Date`→`timestamptz`,
 * `Uint8Array`→`binary`, arrays→`list`, `Struct`/`Class`→`struct`,
 * `Record`→`map`, optional/nullable→not required). Additive schema changes
 * evolve the table in place, keeping its UUID and field ids; destructive
 * changes fail the plan. By default the table is retained when removed
 * from the stack.
 *
 * Writing to a table from a Pipelines sink and querying it with Basin SQL
 * are not part of this resource yet.
 * ### Creating a table
 * **Example:** Table from an Effect Schema
 * ```typescript
 * const Order = Schema.Struct({
 *   id: Schema.String,
 *   amount: Schema.Number,
 *   at: Schema.Date,
 *   note: Schema.optional(Schema.String),
 * });
 *
 * const bucket = yield* Cloudflare.R2.Bucket("Analytics");
 * const catalog = yield* Cloudflare.R2.DataCatalog("Catalog", {
 *   bucket,
 * });
 * const orders = yield* Cloudflare.Basin.Table("Orders", {
 *   catalog,
 *   namespace: "sales",
 *   schema: Order,
 *   partitionBy: ["day(at)"],
 * });
 * // orders.identifier → "sales.<generated name>"
 * ```
 *
 * **Example:** Plain Iceberg column descriptors
 * ```typescript
 * const prices = yield* Cloudflare.Basin.Table("Prices", {
 *   catalog,
 *   namespace: "sales",
 *   name: "prices",
 *   schema: {
 *     fields: [
 *       { name: "sku", type: "string", required: true },
 *       { name: "price", type: "decimal(10, 2)" },
 *       { name: "day", type: "date" },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Evolving the schema
 * **Example:** Add an optional column in place
 * ```typescript
 * const Order = Schema.Struct({
 *   id: Schema.String,
 *   amount: Schema.Number,
 *   at: Schema.Date,
 *   note: Schema.optional(Schema.String),
 *   coupon: Schema.optional(Schema.String), // new: evolves the table
 * });
 * ```
 *
 * ### Properties and maintenance
 * **Example:** Table properties, compaction, and snapshot expiration
 * ```typescript
 * // Table maintenance needs the jobs enabled on the catalog first.
 * const catalog = yield* Cloudflare.R2.DataCatalog("Catalog", {
 *   bucket,
 *   compaction: { state: "enabled" },
 *   snapshotExpiration: { state: "enabled" },
 *   token: maintenanceToken,
 * });
 * const orders = yield* Cloudflare.Basin.Table("Orders", {
 *   catalog,
 *   namespace: "sales",
 *   schema: Order,
 *   properties: { "write.parquet.compression-codec": "zstd" },
 *   maintenance: {
 *     compaction: { targetSizeMb: "256" },
 *     snapshotExpiration: { olderThan: "7 days", retainLast: 10 },
 *   },
 * });
 * ```
 *
 * ### Deleting
 * **Example:** Purge the table's data on destroy
 * ```typescript
 * const scratch = yield* Cloudflare.Basin.Table("Scratch", {
 *   catalog,
 *   namespace: "tmp",
 *   schema: Order,
 *   delete: "purge",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/r2/data-catalog/
 *
 * @resource
 * @product Basin
 * @category Storage & Databases
 */
export const Table: typeof TableResource = Object.assign(
  (...args: [id: string, props: unknown] | [methods: object]) => {
    if (typeof args[0] !== "string") {
      return (TableResource as (methods: object) => unknown)(args[0]);
    }
    const [id, props] = args as [string, unknown];
    const resolved = Effect.isEffect(props)
      ? // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- props are untyped; Effect-valued props are resolved by the engine
        Effect.flatMap(props as Effect.Effect<unknown>, toProps)
      : Effect.suspend(() => toProps(props));
    return TableResource(id, resolved as Effect.Effect<any>);
  },
  TableResource,
) as typeof TableResource;

/**
 * Returns true if the given value is a Basin Table resource.
 */
export const isTable = (value: unknown): value is Table =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

interface CatalogRef {
  catalogUri: string;
  warehouse: string;
  accountId: string;
  bucketName: string;
}

const CATALOG_HOST = "https://catalog.cloudflarestorage.com";

/**
 * The catalog prop is resolved to the DataCatalog's attributes before a
 * lifecycle operation runs. During plan it may still be unresolved.
 */
const catalogRefOf = (catalog: unknown, defaultAccountId?: string): CatalogRef | undefined => {
  if (typeof catalog === "string") {
    if (catalog.length === 0 || defaultAccountId === undefined) return undefined;
    return {
      accountId: defaultAccountId,
      bucketName: catalog,
      catalogUri: `${CATALOG_HOST}/${defaultAccountId}/${catalog}`,
      warehouse: `${defaultAccountId}_${catalog}`,
    };
  }
  if (catalog === null || typeof catalog !== "object") return undefined;
  const c = catalog as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
  const fromUri = str(c.catalogUri)?.match(/\/([^/]+)\/([^/]+)\/?$/);
  const accountId = str(c.accountId) ?? fromUri?.[1] ?? defaultAccountId;
  const bucketName = str(c.bucketName) ?? str(c.bucket) ?? fromUri?.[2];
  if (!accountId || !bucketName) return undefined;
  return {
    accountId,
    bucketName,
    catalogUri: str(c.catalogUri) ?? `${CATALOG_HOST}/${accountId}/${bucketName}`,
    warehouse: str(c.warehouse) ?? str(c.name) ?? `${accountId}_${bucketName}`,
  };
};

const refFromOutput = (output: TableAttributes): CatalogRef => ({
  catalogUri: output.catalogUri,
  warehouse: output.warehouse,
  accountId: output.accountId,
  bucketName: output.bucketName,
});

const bearerToken = (override: Redacted.Redacted<string> | undefined) =>
  Effect.gen(function* () {
    if (override !== undefined) return override;
    const creds = yield* yield* CloudflareEnvironment;
    if (creds.type === "apiToken") return creds.apiToken;
    if (creds.type === "oauth") return creds.accessToken;
    return yield* new BasinTableCredentialsUnavailable({
      message:
        "Cloudflare.Basin.Table: the Iceberg catalog needs a bearer token; global API key credentials cannot be used. Log in with an API token or OAuth, or pass `token`.",
    });
  });

/** Scope Iceberg operations to one warehouse of the Basin catalog. */
const withCatalog =
  (ref: CatalogRef, token: Redacted.Redacted<string>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          Iceberg.IcebergProtocol,
          Iceberg.fromCatalogConfig({
            uri: ref.catalogUri,
            warehouse: ref.warehouse,
            token,
          }),
        ),
      ),
    );

const tableNameFor = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, lowercase: true, delimiter: "_" }).pipe(
        Effect.map((generated) => generated.replaceAll(/[^a-z0-9_]/g, "_")),
      );

const schemaOf = (schema: TableSchemaInput) =>
  Effect.try({
    try: () => toTableSchema(schema),
    catch: (error) =>
      error instanceof BasinTableSchemaUnsupported
        ? error
        : new BasinTableSchemaUnsupported({ path: "", message: String(error) }),
  });

const partitionTermsOf = (partitionBy: readonly string[] | undefined) =>
  Effect.try({
    try: () => (partitionBy ?? []).map(parsePartitionTerm),
    catch: (error) =>
      error instanceof BasinTableSchemaUnsupported
        ? error
        : new BasinTableSchemaUnsupported({ path: "", message: String(error) }),
  });

const rejected = (table: string, reasons: string[]) =>
  new BasinTableChangeRejected({
    table,
    reasons,
    message: `Cloudflare.Basin.Table '${table}': this change cannot be applied in place, and Alchemy never drops an Iceberg table to replace it:\n${reasons.map((r) => `  - ${r}`).join("\n")}`,
  });

/** HEAD the table; a missing table (or namespace) answers 404 with no body. */
const tableExists = (namespace: string, table: string) =>
  Iceberg.tableExists({ namespace, table }).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

const loadTable = (namespace: string, table: string) =>
  Iceberg.loadTable({ namespace, table }).pipe(
    Effect.catchTag("NoSuchTableException", () => Effect.undefined),
  );

const requirement = (type: string, fields: Record<string, unknown>): Iceberg.TableRequirement => ({
  type,
  ...fields,
});

const currentSchemaOf = (metadata: Iceberg.TableMetadata) =>
  metadata.schemas?.find((s) => s.schema_id === metadata.current_schema_id) ??
  metadata.schemas?.[0];

const observedPartitionTerms = (
  metadata: Iceberg.TableMetadata,
  fields: readonly Iceberg.StructField[],
): PartitionTerm[] => {
  const spec =
    metadata.partition_specs?.find((s) => s.spec_id === metadata.default_spec_id) ??
    metadata.partition_specs?.[0];
  const pathById = new Map([...fieldIdsByPath(fields)].map(([path, fid]) => [fid, path]));
  return (spec?.fields ?? []).map((f) => ({
    column: pathById.get(f.source_id) ?? `#${f.source_id}`,
    transform: f.transform.replaceAll(/\s+/g, "").toLowerCase(),
  }));
};

interface Observed {
  metadata: Iceberg.TableMetadata;
  metadataLocation: string | undefined;
}

/**
 * Converge an existing table's schema and properties onto the desired state
 * in one optimistic commit. Observes first; skips the commit on a no-op.
 */
const syncTable = (input: {
  namespace: string;
  table: string;
  schema: TableSchema;
  partition: PartitionTerm[];
  properties: Record<string, string>;
  ownedPropertyKeys: string[];
}) =>
  Effect.gen(function* () {
    const loaded = yield* Iceberg.loadTable({ namespace: input.namespace, table: input.table });
    const metadata = loaded.metadata;
    const current = currentSchemaOf(metadata);
    const observedFields = current?.fields ?? [];
    const identifier = `${input.namespace}.${input.table}`;

    const reasons = destructiveChanges(fromIcebergFields(observedFields), input.schema.fields);
    const observedPartition = observedPartitionTerms(metadata, observedFields);
    if (!samePartitionTerms(observedPartition, input.partition)) {
      reasons.push(
        `changes the partition spec from [${observedPartition.map(describeTerm).join(", ")}] to [${input.partition.map(describeTerm).join(", ")}] (partition specs are immutable)`,
      );
    }
    if (reasons.length > 0) return yield* rejected(identifier, reasons);

    const requirements: Iceberg.TableRequirement[] = [
      requirement("assert-table-uuid", { uuid: metadata.table_uuid }),
    ];
    const updates: Iceberg.TableUpdateInput[] = [];

    if (
      !deepEqual(
        normalizeColumns(fromIcebergFields(observedFields)),
        normalizeColumns(input.schema.fields),
      )
    ) {
      let next = Math.max(metadata.last_column_id ?? 0, maxFieldId(observedFields)) + 1;
      const fields = assignFieldIds(input.schema.fields, observedFields, () => next++);
      requirements.push(
        requirement("assert-current-schema-id", {
          "current-schema-id": metadata.current_schema_id,
        }),
      );
      updates.push(
        { action: "add-schema", schema: { type: "struct", fields } },
        { action: "set-current-schema", schema_id: -1 },
      );
    }

    const observedProps = metadata.properties ?? {};
    const changed = Object.fromEntries(
      Object.entries(input.properties).filter(([key, value]) => observedProps[key] !== value),
    );
    if (Object.keys(changed).length > 0) {
      updates.push({ action: "set-properties", updates: changed });
    }
    const removals = input.ownedPropertyKeys.filter(
      (key) => !(key in input.properties) && observedProps[key] !== undefined,
    );
    if (removals.length > 0) {
      updates.push({ action: "remove-properties", removals });
    }

    if (updates.length === 0) {
      return {
        metadata,
        metadataLocation: loaded.metadata_location ?? undefined,
      } satisfies Observed;
    }
    const committed = yield* Iceberg.updateTable({
      namespace: input.namespace,
      table: input.table,
      requirements,
      updates,
    });
    return {
      metadata: committed.metadata,
      metadataLocation: committed.metadata_location,
    } satisfies Observed;
  });

const describeTerm = (t: PartitionTerm) =>
  t.transform === "identity" ? t.column : `${t.transform}(${t.column})`;

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

const AGE_UNITS = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
] as const;

/** Whole days, hours, or minutes (rounded up) — the API's `7d` / `36h` form. */
const formatAge = (millis: number): string => {
  for (const [unit, size] of AGE_UNITS) {
    if (millis % size === 0) return `${millis / size}${unit}`;
  }
  return `${Math.ceil(millis / 60_000)}m`;
};

const parseAge = (age: string | undefined): number | undefined => {
  const m = age?.trim().match(/^(\d+)\s*([dhms])$/);
  if (!m) return undefined;
  const size = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 }[m[2] as "d" | "h" | "m" | "s"];
  return Number(m[1]) * size;
};

const syncMaintenance = (
  ref: CatalogRef,
  namespace: string,
  tableName: string,
  maintenance: TableMaintenance,
) =>
  Effect.gen(function* () {
    const key = {
      accountId: ref.accountId,
      bucketName: ref.bucketName,
      namespace,
      tableName,
    };
    const { maintenanceConfig: observed } = yield* basin.getNamespacesTablesMaintenanceConfig(key);
    const request: basin.UpdateNamespacesTablesMaintenanceConfigRequest = { ...key };
    let dirty = false;

    if (maintenance.compaction !== undefined) {
      const desired = {
        state: maintenance.compaction.enabled === false ? "disabled" : "enabled",
        targetSizeMb: maintenance.compaction.targetSizeMb,
      };
      const o = observed.compaction ?? undefined;
      if (
        o?.state !== desired.state ||
        (desired.targetSizeMb !== undefined && o?.targetSizeMb !== desired.targetSizeMb)
      ) {
        request.compaction = desired;
        dirty = true;
      }
    }

    if (maintenance.snapshotExpiration !== undefined) {
      const se = maintenance.snapshotExpiration;
      const olderThan =
        se.olderThan === undefined
          ? undefined
          : yield* Effect.try({
              try: () => Duration.toMillis(se.olderThan!),
              catch: () =>
                new BasinTableSchemaUnsupported({
                  path: "maintenance.snapshotExpiration.olderThan",
                  message: `Cloudflare.Basin.Table: invalid duration ${Formatter.format(se.olderThan)}`,
                }),
            });
      const desired = {
        state: se.enabled === false ? "disabled" : "enabled",
        maxSnapshotAge: olderThan === undefined ? undefined : formatAge(olderThan),
        minSnapshotsToKeep: se.retainLast,
      };
      const o = observed.snapshotExpiration ?? undefined;
      if (
        o?.state !== desired.state ||
        (olderThan !== undefined && parseAge(o?.maxSnapshotAge) !== olderThan) ||
        (desired.minSnapshotsToKeep !== undefined &&
          o?.minSnapshotsToKeep !== desired.minSnapshotsToKeep)
      ) {
        request.snapshotExpiration = desired;
        dirty = true;
      }
    }

    if (dirty) yield* basin.updateNamespacesTablesMaintenanceConfig(request);
  });

const toAttributes = (
  ref: CatalogRef,
  namespace: string,
  tableName: string,
  { metadata, metadataLocation }: Observed,
): TableAttributes => ({
  namespace,
  tableName,
  identifier: `${namespace}.${tableName}`,
  tableUuid: metadata.table_uuid,
  location: metadata.location,
  metadataLocation,
  catalogUri: ref.catalogUri,
  warehouse: ref.warehouse,
  accountId: ref.accountId,
  bucketName: ref.bucketName,
  formatVersion: metadata.format_version,
  currentSchemaId: metadata.current_schema_id,
});

export const TableProvider = () =>
  Provider.succeed(Table, {
    stables: [
      "tableUuid",
      "namespace",
      "tableName",
      "identifier",
      "location",
      "catalogUri",
      "warehouse",
      "accountId",
      "bucketName",
    ],

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const table = output?.identifier ?? "<new>";
      const reasons: string[] = [];
      if (output !== undefined) {
        if (typeof news.namespace === "string" && news.namespace !== output.namespace) {
          reasons.push(`changes the namespace from '${output.namespace}' to '${news.namespace}'`);
        }
        if (typeof news.name === "string" && news.name !== output.tableName) {
          reasons.push(`renames the table from '${output.tableName}' to '${news.name}'`);
        }
        const { accountId } = yield* yield* CloudflareEnvironment;
        const ref = isResolved(news.catalog) ? catalogRefOf(news.catalog, accountId) : undefined;
        if (ref !== undefined && ref.warehouse !== output.warehouse) {
          reasons.push(
            `moves the table from warehouse '${output.warehouse}' to '${ref.warehouse}'`,
          );
        }
      }
      if (olds !== undefined) {
        if (olds.schema !== undefined && isResolved(news.schema)) {
          const previous = yield* schemaOf(olds.schema);
          const next = yield* schemaOf(news.schema);
          reasons.push(...destructiveChanges(previous.fields, next.fields));
        }
        if (isResolved(news.partitionBy)) {
          const previous = yield* partitionTermsOf(olds.partitionBy);
          const next = yield* partitionTermsOf(news.partitionBy);
          if (!samePartitionTerms(previous, next)) {
            reasons.push(
              `changes the partition spec from [${previous.map(describeTerm).join(", ")}] to [${next.map(describeTerm).join(", ")}] (partition specs are immutable)`,
            );
          }
        }
      }
      if (reasons.length > 0) return yield* rejected(table, reasons);
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const ref = output ? refFromOutput(output) : catalogRefOf(olds?.catalog, accountId);
      const namespace = output?.namespace ?? olds?.namespace;
      if (ref === undefined || typeof namespace !== "string") return undefined;
      const tableName = output?.tableName ?? (yield* tableNameFor(id, olds?.name));
      const token = yield* bearerToken(olds?.token);
      const loaded = yield* Effect.gen(function* () {
        if (!(yield* tableExists(namespace, tableName))) return undefined;
        return yield* loadTable(namespace, tableName);
      }).pipe(withCatalog(ref, token));
      if (loaded === undefined) return undefined;
      const attrs = toAttributes(ref, namespace, tableName, {
        metadata: loaded.metadata,
        metadataLocation: loaded.metadata_location ?? undefined,
      });
      // Tables carry Alchemy's ownership tags as table properties.
      if (output !== undefined) return attrs;
      const owned = yield* hasAlchemyTags(id, loaded.metadata.properties ?? {});
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const ref =
        catalogRefOf(news.catalog, accountId) ?? (output ? refFromOutput(output) : undefined);
      const namespace = news.namespace;
      const tableName = yield* tableNameFor(id, news.name ?? output?.tableName);
      const identifier = `${namespace}.${tableName}`;
      if (ref === undefined) {
        return yield* rejected(identifier, [
          "has no resolved catalog (pass a Cloudflare.Basin.Catalog or a bucket name)",
        ]);
      }
      if (output !== undefined && output.identifier !== identifier) {
        return yield* rejected(output.identifier, [
          `changes the table identifier to '${identifier}'`,
        ]);
      }

      const token = yield* bearerToken(news.token);
      const schema = yield* schemaOf(news.schema);
      const partition = yield* partitionTermsOf(news.partitionBy);
      const properties = { ...news.properties, ...(yield* createInternalTags(id)) };

      const observed = yield* Effect.gen(function* () {
        // Ensure the namespace — creation is idempotent under a race.
        yield* Iceberg.createNamespace({ namespace: [namespace] }).pipe(
          Effect.catchTag("AlreadyExistsException", () => Effect.void),
        );

        // Ensure the table. A concurrent create (or a create whose state
        // write was lost) surfaces as AlreadyExists and falls through to sync.
        if ((yield* loadTable(namespace, tableName)) === undefined) {
          let next = 1;
          const fields = assignFieldIds(schema.fields, undefined, () => next++);
          const ids = fieldIdsByPath(fields);
          const missing = partition.filter((t) => !ids.has(t.column));
          if (missing.length > 0) {
            return yield* rejected(
              identifier,
              missing.map((t) => `partitions by unknown column '${t.column}'`),
            );
          }
          yield* Iceberg.createTable({
            namespace,
            name: tableName,
            schema: { type: "struct", fields },
            partition_spec:
              partition.length > 0
                ? {
                    fields: partition.map((t) => ({
                      source_id: ids.get(t.column)!,
                      transform: t.transform,
                      name: partitionFieldName(t),
                    })),
                  }
                : undefined,
            properties,
          }).pipe(Effect.catchTag("AlreadyExistsException", () => Effect.void));
        }

        // Sync schema + properties against observed metadata; a concurrent
        // commit invalidates the requirements — reload and retry.
        return yield* syncTable({
          namespace,
          table: tableName,
          schema,
          partition,
          properties,
          ownedPropertyKeys: Object.keys(olds?.properties ?? {}),
        }).pipe(
          Effect.retry({
            while: (e) => e._tag === "CommitFailedException",
            times: 3,
          }),
        );
      }).pipe(withCatalog(ref, token));

      if (news.maintenance !== undefined) {
        yield* syncMaintenance(ref, namespace, tableName, news.maintenance);
      }

      return toAttributes(ref, namespace, tableName, observed);
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      const policy = olds?.delete ?? "retain";
      if (policy === "retain") return;
      const token = yield* bearerToken(olds?.token);
      // Basin answers drop on a missing table with an ambiguous 403, so
      // observe first: HEAD is a clean 404 when the table is gone.
      yield* Effect.gen(function* () {
        if (!(yield* tableExists(output.namespace, output.tableName))) return;
        yield* Iceberg.dropTable({
          namespace: output.namespace,
          table: output.tableName,
          purgeRequested: policy === "purge",
        }).pipe(Effect.catchTag("NoSuchTableException", () => Effect.void));
      }).pipe(withCatalog(refFromOutput(output), token));
    }),
  });
