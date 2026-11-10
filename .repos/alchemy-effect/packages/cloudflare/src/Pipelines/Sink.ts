import * as pipelines from "@distilled.cloud/cloudflare/pipelines";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import type { Bucket } from "../R2/Bucket.ts";
import type { DataCatalog } from "../R2/DataCatalog.ts";

const TypeId = "Cloudflare.Pipelines.Sink" as const;
type TypeId = typeof TypeId;

/**
 * Batching policy controlling when the sink rolls (closes and uploads)
 * the current output file.
 */
export interface SinkRollingPolicy {
  /**
   * Roll the file once it reaches this size in bytes.
   */
  fileSizeBytes?: number;
  /**
   * Roll the file after this many seconds without new events.
   */
  inactivitySeconds?: number;
  /**
   * Roll the file at most this many seconds after it was opened.
   * @default 300
   */
  intervalSeconds?: number;
}

/**
 * Configuration of an `r2` sink writing raw files to an R2 bucket.
 */
export interface SinkR2Config {
  /**
   * The destination R2 bucket: a `Cloudflare.R2.Bucket` resource (orders the
   * sink after the bucket) or a bucket name. The bucket must already exist.
   */
  bucket: string | Bucket;
  /**
   * R2 S3-compatible credentials the sink uses to write objects.
   * Write-only — Cloudflare never echoes them back, and sinks cannot be
   * updated, so changing them does NOT replace the sink (see the
   * resource docs on rotating credentials).
   */
  credentials: {
    /** R2 access key id (the API token id). */
    accessKeyId: Redacted.Redacted<string>;
    /** R2 secret access key (SHA-256 hex of the API token value). */
    secretAccessKey: Redacted.Redacted<string>;
  };
  /**
   * Key prefix under which output objects are written.
   */
  path?: string;
  /**
   * Time-based partitioning of output object keys.
   */
  partitioning?: {
    /**
     * strftime-style pattern, e.g. `year=%Y/month=%m/day=%d`.
     */
    timePattern?: string;
  };
  /**
   * Naming of output files within a partition.
   */
  fileNaming?: {
    /** Prefix prepended to each file name. */
    prefix?: string;
    /** Suffix appended to each file name. */
    suffix?: string;
    /**
     * Strategy generating the unique part of each file name.
     * @default "uuid_v7"
     */
    strategy?: "serial" | "uuid" | "uuid_v7" | "ulid";
  };
  /**
   * When the sink rolls output files.
   */
  rollingPolicy?: SinkRollingPolicy;
  /**
   * Jurisdiction the bucket was created in (`eu`, `fedramp`), when not
   * the default.
   */
  jurisdiction?: string;
}

/**
 * Configuration of a catalog sink writing an Iceberg table via the Basin
 * (R2 Data) Catalog, spelled with the bucket name.
 */
export interface SinkR2DataCatalogConfig {
  /**
   * The R2 bucket backing the catalog: a `Cloudflare.R2.Bucket` resource or a
   * bucket name. The bucket must already exist and have the catalog enabled.
   */
  bucket: string | Bucket;
  /**
   * Name of the Iceberg table to write.
   */
  tableName: string;
  /**
   * Catalog namespace the table lives in.
   * @default "default"
   */
  namespace?: string;
  /**
   * Cloudflare API token with R2 Data Catalog permissions. Write-only —
   * Cloudflare never echoes it back, and changing it does NOT replace
   * the sink.
   */
  token: Redacted.Redacted<string>;
  /**
   * When the sink rolls output files.
   */
  rollingPolicy?: SinkRollingPolicy;
}

/**
 * The catalog a catalog sink writes to: a `Cloudflare.Basin.Catalog`
 * (`Cloudflare.R2.DataCatalog`) resource, which orders the sink after the
 * catalog, or the name of the bucket the catalog is enabled on.
 */
export type SinkCatalogReference = string | DataCatalog;

/**
 * The bucket name behind a bucket or catalog reference: the string itself,
 * or the `bucketName` attribute of a resolved `Cloudflare.R2.Bucket` or
 * `Cloudflare.Basin.Catalog`.
 */
const bucketNameOf = (ref: unknown): string =>
  typeof ref === "string"
    ? ref
    : ref !== null &&
        typeof ref === "object" &&
        typeof (ref as { bucketName?: unknown }).bucketName === "string"
      ? (ref as { bucketName: string }).bucketName
      : "";

/**
 * The Iceberg table a catalog sink writes to.
 */
export interface SinkCatalogTable {
  /**
   * Catalog namespace the table lives in.
   * @default "default"
   */
  namespace?: string;
  /** Table name. */
  name: string;
}

/**
 * Sink type of a catalog sink. `basin_catalog` and `r2_data_catalog` are
 * the same destination; switching between them never replaces the sink.
 */
export type SinkCatalogType = "basin_catalog" | "r2_data_catalog";

/**
 * Output file format written by the sink.
 */
export type SinkFormat =
  | {
      /** Newline-delimited JSON output. */
      type: "json";
    }
  | {
      /** Parquet output. */
      type: "parquet";
      /**
       * Compression codec.
       * @default "zstd"
       */
      compression?: "uncompressed" | "snappy" | "gzip" | "zstd" | "lz4";
      /** Target row-group size in bytes. */
      rowGroupBytes?: number;
    };

interface SinkBaseProps {
  /**
   * Name of the sink. Unique per account; must be alphanumeric and
   * underscores only (it is referenced as a SQL table name). If omitted,
   * a unique name is generated from the app, stage, and logical ID.
   *
   * Sinks have no update API, so changing this (or any destination
   * property) triggers a replacement.
   * @default ${app}_${id}_${stage}_${suffix}
   */
  name?: string;
  /**
   * Output file format. Catalog sinks require Parquet.
   * @default { type: "json" } for `r2` sinks, { type: "parquet" } for catalog sinks
   */
  format?: SinkFormat;
}

export type SinkProps =
  | (SinkBaseProps & {
      /**
       * Sink type — `r2` writes raw files to an R2 bucket.
       */
      type: "r2";
      /**
       * R2 destination configuration.
       */
      config: SinkR2Config;
    })
  | (SinkBaseProps & {
      /**
       * Sink type — writes an Iceberg table via the Basin (R2 Data)
       * Catalog.
       */
      type: SinkCatalogType;
      /**
       * Catalog destination configuration, spelled with the bucket name.
       * Equivalent to the `catalog` / `table` / `token` form.
       */
      config: SinkR2DataCatalogConfig;
    })
  | (SinkBaseProps & {
      /**
       * Sink type — writes an Iceberg table via the Basin (R2 Data)
       * Catalog.
       */
      type: SinkCatalogType;
      /**
       * The catalog to write to: a `Cloudflare.Basin.Catalog` resource or
       * the name of the bucket the catalog is enabled on.
       */
      catalog: SinkCatalogReference;
      /**
       * The Iceberg table to write. Cloudflare creates it with the
       * sink — sinks cannot be created for existing Iceberg tables.
       */
      table: SinkCatalogTable;
      /**
       * Cloudflare API token with R2 Data Catalog permissions. Write-only;
       * changing it does NOT replace the sink.
       */
      token: Redacted.Redacted<string>;
      /**
       * When the sink rolls output files.
       */
      rollingPolicy?: SinkRollingPolicy;
    });

export interface SinkAttributes {
  /** Cloudflare-assigned sink identifier. */
  sinkId: string;
  /** Account that owns the sink. */
  accountId: string;
  /** Sink name (unique per account). */
  name: string;
  /** Sink type. */
  type: "r2" | SinkCatalogType;
  /** Destination R2 bucket name. */
  bucket: string;
  /** Key prefix output objects are written under (r2 sinks). */
  path: string | undefined;
  /** Catalog namespace of the destination table (catalog sinks). */
  namespace: string | undefined;
  /** Destination Iceberg table name (catalog sinks). */
  tableName: string | undefined;
  /** When the sink was created. */
  createdAt: string;
  /** When the sink was last modified. */
  modifiedAt: string;
}

export type Sink = Resource<TypeId, SinkProps, SinkAttributes, never, Providers>;

/**
 * A Cloudflare Pipelines sink — the destination of the Pipelines product
 * (also exported as `Cloudflare.Basin.Sink`). A SQL {@link Pipeline}
 * reads events from a {@link Stream} and writes them to a sink, which
 * stores them in R2 either as raw files (`r2`) or as an Iceberg table via
 * the Basin Catalog (`basin_catalog`, a.k.a. `r2_data_catalog`).
 *
 * Sinks have no update API: changing the destination (bucket, path,
 * table, format, partitioning, rolling policy) triggers a replacement.
 * Equivalent spellings never replace — `basin_catalog` ⇄
 * `r2_data_catalog`, the `config` form ⇄ the `catalog` / `table` form,
 * omitted ⇄ explicit defaults. With engine-generated names a replacement
 * is seamless (the new sink gets a fresh name before the old one is
 * deleted); with an explicit `name` it collides, so prefer generated
 * names.
 *
 * Credentials (`credentials`, `token`) are write-only and are not part of
 * the replacement diff, so rotating them never recreates the sink — a
 * catalog sink could not be recreated anyway, because Cloudflare refuses
 * to create sinks for existing Iceberg tables. The sink keeps the
 * credentials it was created with; to move it onto new ones, rename it
 * (which replaces it).
 *
 * Pipelines is ingest-only — to react to files the sink writes, subscribe
 * to its bucket with `Cloudflare.R2.BucketEventNotification`.
 *
 * ### Creating a Sink
 * **Example:** R2 sink with JSON output
 * The S3-compatible credentials are derived from a Cloudflare API token:
 * the access key id is the token id and the secret is the SHA-256 hex
 * digest of the token value.
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("events", {});
 *
 * const sink = yield* Cloudflare.Basin.Sink("events-sink", {
 *   type: "r2",
 *   config: {
 *     bucket,
 *     credentials: {
 *       accessKeyId: yield* Config.Redacted("R2_ACCESS_KEY_ID"),
 *       secretAccessKey: yield* Config.Redacted("R2_SECRET_ACCESS_KEY"),
 *     },
 *     path: "ingest",
 *     rollingPolicy: { intervalSeconds: 30 },
 *   },
 * });
 * ```
 *
 * **Example:** Parquet output
 * ```typescript
 * const sink = yield* Cloudflare.Basin.Sink("parquet-sink", {
 *   type: "r2",
 *   config: { bucket, credentials },
 *   format: { type: "parquet", compression: "zstd" },
 * });
 * ```
 *
 * ### Basin Catalog
 * **Example:** Iceberg table sink
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("Lakehouse", {});
 * const catalog = yield* Cloudflare.Basin.Catalog("Catalog", {
 *   bucket,
 * });
 *
 * const sink = yield* Cloudflare.Basin.Sink("PageViewTable", {
 *   type: "basin_catalog",
 *   catalog,
 *   table: { namespace: "web", name: "page_views" },
 *   token: yield* Config.Redacted("CATALOG_TOKEN"),
 * });
 * ```
 *
 * **Example:** Bucket-name form
 * ```typescript
 * const sink = yield* Cloudflare.Basin.Sink("iceberg-sink", {
 *   type: "r2_data_catalog",
 *   config: {
 *     bucket,
 *     tableName: "events",
 *     namespace: "default",
 *     token: yield* Config.Redacted("CATALOG_TOKEN"),
 *   },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/pipelines/
 *
 * @resource
 * @product Pipelines
 * @category Storage & Databases
 */
export const Sink = Resource<Sink>(TypeId);

/**
 * Returns true if the given value is a Sink resource.
 */
export const isSink = (value: unknown): value is Sink =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const SinkProvider = () =>
  Provider.succeed(Sink, {
    stables: ["sinkId", "accountId", "name", "type", "createdAt"],

    diff: Effect.fn(function* ({ id, olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      const o = olds as SinkProps | undefined;
      if (o === undefined) return undefined;
      // Sinks have no update API — any destination change replaces. Compare
      // the CANONICAL destination (credentials excluded) so equivalent
      // spellings and credential rotation never replace.
      const newName = yield* sinkName(id, news.name);
      const oldName = output?.name ?? (yield* sinkName(id, o.name));
      if (newName !== oldName) {
        return { action: "replace" } as const;
      }
      if (!stableEquals(canonicalSink(news), canonicalSink(o))) {
        return { action: "replace" } as const;
      }
      return { action: "noop" } as const;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      if (output?.sinkId) {
        const observed = yield* getSink(acct, output.sinkId);
        if (observed) return toAttributes(observed, acct);
      }
      // Cold read — sink names are unique per account; a generated-name
      // match is proof of ownership, an explicit name is not.
      const name = yield* sinkName(id, olds?.name);
      const match = yield* findSinkByName(acct, name);
      if (match) {
        const attrs = toAttributes(match, acct);
        return olds?.name !== undefined ? Unowned(attrs) : attrs;
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* sinkName(id, news.name);

      // 1. Observe — by cached id first, then by (unique) name so we
      //    recover from lost state writes.
      let observed = output?.sinkId
        ? yield* getSink(output.accountId ?? accountId, output.sinkId)
        : undefined;
      if (!observed) {
        observed = yield* findSinkByName(accountId, name);
      }

      // Converge drift — there is no update API, so when observable
      // echoed config (bucket/path/table) differs from the desired state
      // (e.g. the bucket reference was unresolved at diff time), delete
      // the stale sink and fall through to recreate it under the same
      // name. The delete rides out `SinkInUse` while a pipeline that is
      // being repointed still references it.
      if (observed && sinkDrifted(observed, news)) {
        yield* deleteSink(accountId, observed.id);
        // Wait until the delete is visible so the recreate below does not
        // race a `SinkAlreadyExists` against the dying sink.
        yield* getSink(accountId, observed.id).pipe(
          Effect.repeat({
            schedule: Schedule.max([Schedule.exponential("250 millis"), Schedule.recurs(8)]),
            until: (s) => s === undefined,
          }),
        );
        observed = undefined;
      }

      // 2. Ensure — create when missing. There is no sync step: sinks
      //    have no update API, so destination changes arrive as
      //    replacements (diff) rather than in-place updates. An
      //    AlreadyExists on create is a race or recovery — resolve it via
      //    the name lookup.
      if (!observed) {
        observed = yield* pipelines
          .createSink({
            accountId,
            name,
            type: news.type,
            config: toRequestConfig(accountId, news),
            format: news.format ?? defaultFormat(news.type),
          })
          .pipe(
            Effect.catchTag("SinkAlreadyExists", (error) =>
              findSinkByName(accountId, name).pipe(
                Effect.flatMap((match) => (match ? Effect.succeed(match) : Effect.fail(error))),
              ),
            ),
          );
      }

      return toAttributes(observed, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteSink(output.accountId, output.sinkId);
    }),

    // Account collection: sinks are account-scoped and enumerable via
    // `listSinks` (paginated, items in `result`). Hydrate each page item
    // into the exact `read` Attributes shape. Credentials/token are
    // write-only and never echoed, matching `read`.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* pipelines.listSinks.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((sink) => toAttributes(sink, accountId)),
          ),
        ),
      );
    }),
  });

/**
 * The subset of sink state shared by get/list/create responses.
 */
interface ObservedSink {
  id: string;
  name: string;
  type: string;
  config?:
    | {
        bucket: string;
        path?: string | null;
      }
    | { bucket: string; tableName: string; namespace?: string | null }
    | null;
  createdAt: string;
  modifiedAt: string;
}

/** A catalog sink destination, whichever form it was declared in. */
interface CatalogTarget {
  bucket: string;
  tableName: string;
  namespace: string | undefined;
  token: Redacted.Redacted<string>;
  rollingPolicy: SinkRollingPolicy | undefined;
}

const isCatalogType = (type: string) => type === "r2_data_catalog" || type === "basin_catalog";

const catalogTarget = (props: Exclude<SinkProps, { type: "r2" }>): CatalogTarget =>
  "config" in props && props.config !== undefined
    ? {
        bucket: bucketNameOf(props.config.bucket),
        tableName: props.config.tableName,
        namespace: props.config.namespace,
        token: props.config.token,
        rollingPolicy: props.config.rollingPolicy,
      }
    : {
        bucket: bucketNameOf((props as { catalog: SinkCatalogReference }).catalog),
        tableName: (props as { table: SinkCatalogTable }).table.name,
        namespace: (props as { table: SinkCatalogTable }).table.namespace,
        token: (props as { token: Redacted.Redacted<string> }).token,
        rollingPolicy: (props as { rollingPolicy?: SinkRollingPolicy }).rollingPolicy,
      };

// Pipelines entity names must be alphanumeric/underscore only (they are
// referenced as SQL table names), so swap the default hyphen delimiter
// for underscores.
const sinkName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    const generated = yield* createPhysicalName({
      id,
      lowercase: true,
      delimiter: "_",
    });
    return generated.replaceAll(/[^a-zA-Z0-9_]/g, "_");
  });

/**
 * Read a sink by id, mapping "gone" (`SinkNotFound`, Cloudflare error
 * code 1015, or `InvalidSinkId` for a malformed/foreign id) to
 * `undefined`.
 */
const getSink = (accountId: string, sinkId: string) =>
  pipelines.getSink({ accountId, sinkId }).pipe(
    Effect.map((s): ObservedSink | undefined => s),
    Effect.catchTags({
      SinkNotFound: () => Effect.undefined,
      InvalidSinkId: () => Effect.undefined,
    }),
  );

/**
 * Idempotent delete — a sink that is already gone is success. Rides out
 * `SinkInUse` (HTTP 422 "Sink still in use") with a bounded retry while
 * a dependent pipeline's own deletion propagates.
 */
const deleteSink = (accountId: string, sinkId: string) =>
  pipelines.deleteSink({ accountId, sinkId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "SinkInUse",
      schedule: Schedule.max([Schedule.exponential("500 millis"), Schedule.recurs(8)]),
    }),
    Effect.catchTags({
      SinkNotFound: () => Effect.void,
      InvalidSinkId: () => Effect.void,
    }),
  );

/**
 * Detect drift between the echoed cloud config and the desired props.
 * Only fields Cloudflare echoes back are comparable (credentials and the
 * catalog token are write-only); only user-declared optional fields are
 * diffed so we don't fight server-side defaults.
 */
const sinkDrifted = (observed: ObservedSink, news: SinkProps): boolean => {
  if (isCatalogType(observed.type) !== isCatalogType(news.type)) return true;
  const cfg = observed.config;
  if (!cfg) return false;
  if (news.type === "r2") {
    if (cfg.bucket !== bucketNameOf(news.config.bucket)) return true;
    const observedPath = "path" in cfg ? (cfg.path ?? undefined) : undefined;
    return news.config.path !== undefined && news.config.path !== observedPath;
  }
  const target = catalogTarget(news);
  if (cfg.bucket !== target.bucket) return true;
  if ("tableName" in cfg) {
    if (cfg.tableName !== target.tableName) return true;
    if (target.namespace !== undefined && target.namespace !== (cfg.namespace ?? undefined)) {
      return true;
    }
  }
  return false;
};

const findSinkByName = (accountId: string, name: string) =>
  pipelines.listSinks.items({ accountId }).pipe(
    Stream.runCollect,
    Effect.map((chunk): ObservedSink | undefined => Array.from(chunk).find((s) => s.name === name)),
  );

/**
 * Build the distilled create request `config` body from props,
 * unwrapping write-only secrets.
 */
const toRequestConfig = (accountId: string, news: SinkProps) => {
  if (news.type === "r2") {
    const c = news.config;
    return {
      accountId,
      bucket: bucketNameOf(c.bucket),
      credentials: {
        accessKeyId: Redacted.value(c.credentials.accessKeyId),
        secretAccessKey: Redacted.value(c.credentials.secretAccessKey),
      },
      path: c.path,
      partitioning: c.partitioning,
      fileNaming: c.fileNaming,
      rollingPolicy: c.rollingPolicy,
      jurisdiction: c.jurisdiction,
    };
  }
  const t = catalogTarget(news);
  return {
    accountId,
    bucket: t.bucket,
    tableName: t.tableName,
    namespace: t.namespace,
    token: Redacted.value(t.token),
    rollingPolicy: t.rollingPolicy,
  };
};

const canonicalRollingPolicy = (rp: SinkRollingPolicy | undefined) => ({
  fileSizeBytes: rp?.fileSizeBytes,
  inactivitySeconds: rp?.inactivitySeconds,
  intervalSeconds: rp?.intervalSeconds ?? 300,
});

/** Catalog (Iceberg) sinks only accept Parquet; raw R2 sinks default to JSON. */
const defaultFormat = (type: SinkProps["type"]): SinkFormat =>
  isCatalogType(type) ? { type: "parquet" } : { type: "json" };

const canonicalFormat = (type: SinkProps["type"], format: SinkFormat | undefined) => {
  const f = format ?? defaultFormat(type);
  return f.type === "parquet"
    ? {
        type: "parquet",
        compression: f.compression ?? "zstd",
        rowGroupBytes: f.rowGroupBytes,
      }
    : { type: "json" };
};

/**
 * The canonical destination of a sink, for change detection: catalog
 * type spellings and declaration forms collapse, defaults are filled in,
 * and write-only credentials are excluded (they cannot be updated, and
 * rotating them must never recreate the sink).
 */
const canonicalSink = (props: SinkProps): unknown => {
  const format = canonicalFormat(props.type, props.format);
  if (props.type === "r2") {
    const c = props.config;
    return {
      kind: "r2",
      format,
      bucket: bucketNameOf(c.bucket),
      path: c.path,
      partitioning: c.partitioning,
      fileNaming: c.fileNaming
        ? { ...c.fileNaming, strategy: c.fileNaming.strategy ?? "uuid_v7" }
        : undefined,
      rollingPolicy: canonicalRollingPolicy(c.rollingPolicy),
      jurisdiction: c.jurisdiction,
    };
  }
  const t = catalogTarget(props);
  return {
    kind: "catalog",
    format,
    bucket: t.bucket,
    namespace: t.namespace ?? "default",
    tableName: t.tableName,
    rollingPolicy: canonicalRollingPolicy(t.rollingPolicy),
  };
};

/**
 * Key-order-insensitive structural equality for plain JSON-ish prop
 * values.
 */
const stableEquals = (a: unknown, b: unknown): boolean => stableStringify(a) === stableStringify(b);

const stableStringify = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)),
        )
      : v,
  ) ?? "undefined";

const toAttributes = (observed: ObservedSink, accountId: string): SinkAttributes => {
  const cfg = observed.config ?? undefined;
  return {
    sinkId: observed.id,
    accountId,
    name: observed.name,
    type: observed.type as SinkAttributes["type"],
    bucket: cfg?.bucket ?? "",
    path: cfg && "path" in cfg ? (cfg.path ?? undefined) : undefined,
    namespace: cfg && "namespace" in cfg ? (cfg.namespace ?? undefined) : undefined,
    tableName: cfg && "tableName" in cfg ? cfg.tableName : undefined,
    createdAt: observed.createdAt,
    modifiedAt: observed.modifiedAt,
  };
};
