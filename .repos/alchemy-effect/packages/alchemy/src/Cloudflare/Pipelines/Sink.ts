import * as pipelines from "@distilled.cloud/cloudflare/pipelines";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

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
   * Name of the destination R2 bucket. The bucket must already exist.
   */
  bucket: string;
  /**
   * R2 S3-compatible credentials the sink uses to write objects.
   * Write-only — Cloudflare never echoes them back.
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
 * Configuration of an `r2_data_catalog` sink writing Iceberg tables via
 * the R2 Data Catalog.
 */
export interface SinkR2DataCatalogConfig {
  /**
   * Name of the R2 bucket backing the catalog. The bucket must already
   * exist and have the Data Catalog enabled.
   */
  bucket: string;
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
   * Cloudflare never echoes it back.
   */
  token: Redacted.Redacted<string>;
  /**
   * When the sink rolls output files.
   */
  rollingPolicy?: SinkRollingPolicy;
}

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
   * Sinks have no update API, so changing this (or any other) property
   * triggers a replacement.
   * @default ${app}_${id}_${stage}_${suffix}
   */
  name?: string;
  /**
   * Output file format.
   * @default { type: "json" }
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
       * Sink type — `r2_data_catalog` writes Iceberg tables via the R2
       * Data Catalog.
       */
      type: "r2_data_catalog";
      /**
       * R2 Data Catalog destination configuration.
       */
      config: SinkR2DataCatalogConfig;
    });

export interface SinkAttributes {
  /** Cloudflare-assigned sink identifier. */
  sinkId: string;
  /** Account that owns the sink. */
  accountId: string;
  /** Sink name (unique per account). */
  name: string;
  /** Sink type. */
  type: "r2" | "r2_data_catalog";
  /** Destination R2 bucket name. */
  bucket: string;
  /** Key prefix output objects are written under (r2 sinks). */
  path: string | undefined;
  /** When the sink was created. */
  createdAt: string;
  /** When the sink was last modified. */
  modifiedAt: string;
}

export type Sink = Resource<
  TypeId,
  SinkProps,
  SinkAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Pipelines sink — the destination of the Pipelines product.
 * A SQL {@link Pipeline} reads events from a {@link Stream} and
 * writes them to a sink, which stores them in R2 either as raw files
 * (`r2`) or as Iceberg tables via the R2 Data Catalog
 * (`r2_data_catalog`).
 *
 * Sinks have no update API: every property change triggers a
 * replacement. With engine-generated names this is seamless (the new
 * sink gets a fresh name before the old one is deleted); with an
 * explicit `name` the create-before-delete replacement collides, so
 * prefer generated names.
 * @resource
 * @product Pipelines
 * @category Storage & Databases
 * @section Creating a Sink
 * @example R2 sink with JSON output
 * The S3-compatible credentials are derived from a Cloudflare API token:
 * the access key id is the token id and the secret is the SHA-256 hex
 * digest of the token value.
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("events", {});
 *
 * const sink = yield* Cloudflare.Pipelines.Sink("events-sink", {
 *   type: "r2",
 *   config: {
 *     bucket: bucket.bucketName,
 *     credentials: {
 *       accessKeyId: alchemy.secret.env.R2_ACCESS_KEY_ID,
 *       secretAccessKey: alchemy.secret.env.R2_SECRET_ACCESS_KEY,
 *     },
 *     path: "ingest",
 *     rollingPolicy: { intervalSeconds: 30 },
 *   },
 * });
 * ```
 *
 * @example Parquet output
 * ```typescript
 * const sink = yield* Cloudflare.Pipelines.Sink("parquet-sink", {
 *   type: "r2",
 *   config: { bucket: bucket.bucketName, credentials },
 *   format: { type: "parquet", compression: "zstd" },
 * });
 * ```
 *
 * @section R2 Data Catalog
 * @example Iceberg table sink
 * ```typescript
 * const sink = yield* Cloudflare.Pipelines.Sink("iceberg-sink", {
 *   type: "r2_data_catalog",
 *   config: {
 *     bucket: bucket.bucketName,
 *     tableName: "events",
 *     namespace: "default",
 *     token: alchemy.secret.env.CATALOG_TOKEN,
 *   },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/pipelines/
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
      // Sinks have no update API — any change is a replacement.
      const newName = yield* sinkName(id, news.name);
      const oldName = output?.name ?? (yield* sinkName(id, o.name));
      if (
        newName !== oldName ||
        news.type !== o.type ||
        !stableEquals(normalizeProps(news), normalizeProps(o))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
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
            schedule: Schedule.max([
              Schedule.exponential("250 millis"),
              Schedule.recurs(8),
            ]),
            until: (s) => s === undefined,
          }),
        );
        observed = undefined;
      }

      // 2. Ensure — create when missing. There is no sync step: sinks
      //    have no update API, so prop changes arrive as replacements
      //    (diff) rather than in-place updates. An AlreadyExists on
      //    create is a race or recovery — resolve it via the name lookup.
      if (!observed) {
        observed = yield* pipelines
          .createSink({
            accountId,
            name,
            type: news.type,
            config: toRequestConfig(accountId, news),
            format: news.format,
          })
          .pipe(
            Effect.catchTag("SinkAlreadyExists", (error) =>
              findSinkByName(accountId, name).pipe(
                Effect.flatMap((match) =>
                  match ? Effect.succeed(match) : Effect.fail(error),
                ),
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
    Effect.catchTag("SinkNotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidSinkId", () => Effect.succeed(undefined)),
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
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(8),
      ]),
    }),
    Effect.catchTag("SinkNotFound", () => Effect.void),
    Effect.catchTag("InvalidSinkId", () => Effect.void),
  );

/**
 * Detect drift between the echoed cloud config and the desired props.
 * Only fields Cloudflare echoes back are comparable (credentials and the
 * catalog token are write-only); only user-declared optional fields are
 * diffed so we don't fight server-side defaults.
 */
const sinkDrifted = (observed: ObservedSink, news: SinkProps): boolean => {
  if (observed.type !== news.type) return true;
  const cfg = observed.config;
  if (!cfg) return false;
  if (cfg.bucket !== (news.config.bucket as string)) return true;
  if (news.type === "r2") {
    const observedPath = "path" in cfg ? (cfg.path ?? undefined) : undefined;
    if (news.config.path !== undefined && news.config.path !== observedPath) {
      return true;
    }
  } else if ("tableName" in cfg) {
    if (cfg.tableName !== news.config.tableName) return true;
    if (
      news.config.namespace !== undefined &&
      news.config.namespace !== (cfg.namespace ?? undefined)
    ) {
      return true;
    }
  }
  return false;
};

const findSinkByName = (accountId: string, name: string) =>
  pipelines.listSinks.items({ accountId }).pipe(
    Stream.runCollect,
    Effect.map((chunk): ObservedSink | undefined =>
      Array.from(chunk).find((s) => s.name === name),
    ),
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
      bucket: c.bucket as string,
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
  const c = news.config;
  return {
    accountId,
    bucket: c.bucket as string,
    tableName: c.tableName,
    namespace: c.namespace,
    token: Redacted.value(c.token),
    rollingPolicy: c.rollingPolicy,
  };
};

/**
 * Normalize props for change detection: unwrap redacted secrets so two
 * `Redacted` wrappers holding the same value compare equal.
 */
const normalizeProps = (props: SinkProps): unknown => {
  if (props.type === "r2") {
    return {
      type: props.type,
      format: props.format,
      config: {
        ...props.config,
        credentials: {
          accessKeyId: Redacted.value(props.config.credentials.accessKeyId),
          secretAccessKey: Redacted.value(
            props.config.credentials.secretAccessKey,
          ),
        },
      },
    };
  }
  return {
    type: props.type,
    format: props.format,
    config: {
      ...props.config,
      token: Redacted.value(props.config.token),
    },
  };
};

/**
 * Key-order-insensitive structural equality for plain JSON-ish prop
 * values.
 */
const stableEquals = (a: unknown, b: unknown): boolean =>
  stableStringify(a) === stableStringify(b);

const stableStringify = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([x], [y]) =>
            x.localeCompare(y),
          ),
        )
      : v,
  ) ?? "undefined";

const toAttributes = (
  observed: ObservedSink,
  accountId: string,
): SinkAttributes => ({
  sinkId: observed.id,
  accountId,
  name: observed.name,
  type: observed.type as "r2" | "r2_data_catalog",
  bucket: observed.config?.bucket ?? "",
  path:
    observed.config && "path" in observed.config
      ? (observed.config.path ?? undefined)
      : undefined,
  createdAt: observed.createdAt,
  modifiedAt: observed.modifiedAt,
});
