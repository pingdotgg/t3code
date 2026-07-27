import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as pipelines from "@distilled.cloud/cloudflare/pipelines";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import type * as HttpClient from "effect/unstable/http/HttpClient";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Pipelines.LegacyPipeline" as const;
type TypeId = typeof TypeId;

/**
 * HTTP ingest source — events are POSTed as JSON to the pipeline's
 * `endpoint` URL.
 */
export interface LegacyPipelineHttpSource {
  /** Accept events over HTTP at the pipeline endpoint. */
  type: "http";
  /**
   * Require Cloudflare API-token authentication on the ingest endpoint.
   * @default false
   */
  authentication?: boolean;
  /**
   * CORS configuration for browser-originated ingestion.
   */
  cors?: {
    /** Allowed origins, e.g. `["https://example.com"]` or `["*"]`. */
    origins?: string[];
  };
}

/**
 * Worker binding ingest source — events are sent from a Worker via a
 * `pipelines` binding.
 */
export interface LegacyPipelineBindingSource {
  /** Accept events from a Worker `pipelines` binding. */
  type: "binding";
}

/**
 * An ingest source of a legacy pipeline.
 */
export type LegacyPipelineSource =
  | LegacyPipelineHttpSource
  | LegacyPipelineBindingSource;

/**
 * R2 destination configuration of a legacy pipeline.
 */
export interface LegacyPipelineDestination {
  /**
   * Name of the destination R2 bucket. The bucket must already exist.
   */
  bucket: string;
  /**
   * R2 S3-compatible credentials the pipeline uses to write objects.
   * Write-only — Cloudflare never echoes them back.
   */
  credentials: {
    /** R2 access key id (the API token id). */
    accessKeyId: Redacted.Redacted<string>;
    /** R2 secret access key (SHA-256 hex of the API token value). */
    secretAccessKey: Redacted.Redacted<string>;
    /**
     * S3-compatible endpoint of the R2 bucket.
     * @default https://{accountId}.r2.cloudflarestorage.com
     */
    endpoint?: string;
  };
  /**
   * Batching policy controlling when the pipeline flushes a batch of
   * events to R2.
   */
  batch?: {
    /** Flush once the batch reaches this size in bytes. */
    maxBytes?: number;
    /** Flush at most this many seconds after the batch was opened. */
    maxDurationS?: number;
    /** Flush once the batch reaches this many events. */
    maxRows?: number;
  };
  /**
   * Compression applied to output files.
   * @default "gzip"
   */
  compression?: "none" | "gzip" | "deflate";
  /**
   * Key prefix under which output objects are written.
   */
  prefix?: string;
  /**
   * Time-partitioned directory layout of output object keys
   * (strftime-style, e.g. `event_date=%F/hr=%H`).
   */
  filepath?: string;
  /**
   * Name template of output files within a partition.
   */
  filename?: string;
}

export interface LegacyPipelineProps {
  /**
   * Name of the pipeline. Unique per account; the legacy API addresses
   * pipelines by name, so changing it triggers a replacement. If
   * omitted, a unique name is generated from the app, stage, and
   * logical ID.
   * @default ${app}-${id}-${stage}-${suffix}
   */
  name?: string;
  /**
   * Ingest sources accepted by the pipeline.
   * @default [{ type: "http" }, { type: "binding" }]
   */
  source?: LegacyPipelineSource[];
  /**
   * R2 destination the pipeline batches events into.
   */
  destination: LegacyPipelineDestination;
}

export interface LegacyPipelineAttributes {
  /** Cloudflare-assigned pipeline identifier. */
  pipelineId: string;
  /** Account that owns the pipeline. */
  accountId: string;
  /** Pipeline name (unique per account; the API identifier). */
  name: string;
  /** HTTP endpoint URL events can be POSTed to. */
  endpoint: string;
  /** Destination R2 bucket name. */
  bucket: string;
  /** Version number of the last saved configuration. */
  version: number;
}

export type LegacyPipeline = Resource<
  TypeId,
  LegacyPipelineProps,
  LegacyPipelineAttributes,
  never,
  Providers
>;

/**
 * A **legacy** Cloudflare Pipeline — the original HTTP-ingest → R2 batch
 * product (`/accounts/{account}/pipelines`).
 *
 * :::caution
 * This is the **deprecated, legacy** Pipelines API. Cloudflare has
 * superseded it with the SQL-based product — prefer
 * {@link Stream}, {@link Sink}, and {@link Pipeline}
 * for new infrastructure. This resource exists only to manage
 * pre-existing legacy pipelines.
 * :::
 *
 * A legacy pipeline accepts JSON events over HTTP (and/or a Worker
 * `pipelines` binding) and batches them into an R2 bucket using
 * S3-compatible credentials.
 * @resource
 * @product Pipelines
 * @category Storage & Databases
 * @section Creating a Legacy Pipeline
 * @example HTTP ingest into R2
 * The S3-compatible credentials are derived from a Cloudflare API token:
 * the access key id is the token id and the secret is the SHA-256 hex
 * digest of the token value.
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("events", {});
 *
 * const pipeline = yield* Cloudflare.Pipelines.LegacyPipeline("ingest", {
 *   destination: {
 *     bucket: bucket.bucketName,
 *     credentials: {
 *       accessKeyId: alchemy.secret.env.R2_ACCESS_KEY_ID,
 *       secretAccessKey: alchemy.secret.env.R2_SECRET_ACCESS_KEY,
 *     },
 *   },
 * });
 * // POST events to pipeline.endpoint
 * ```
 *
 * @example Tuned batching and CORS
 * ```typescript
 * const pipeline = yield* Cloudflare.Pipelines.LegacyPipeline("ingest", {
 *   source: [
 *     { type: "http", cors: { origins: ["https://example.com"] } },
 *   ],
 *   destination: {
 *     bucket: bucket.bucketName,
 *     credentials,
 *     batch: { maxDurationS: 10, maxRows: 1000 },
 *     compression: "gzip",
 *     prefix: "ingest",
 *   },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/pipelines/
 */
export const LegacyPipeline = Resource<LegacyPipeline>(TypeId);

/**
 * Returns true if the given value is a LegacyPipeline resource.
 */
export const isLegacyPipeline = (value: unknown): value is LegacyPipeline =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const LegacyPipelineProvider = () =>
  Provider.succeed(LegacyPipeline, {
    stables: ["pipelineId", "accountId", "name", "endpoint"],

    diff: Effect.fn(function* ({ id, olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      const o = olds as LegacyPipelineProps | undefined;
      if (o === undefined) return undefined;
      // The legacy API addresses pipelines by name — a name change is a
      // replacement. Everything else updates in place via PUT.
      const newName = yield* legacyPipelineName(id, news.name);
      const oldName = output?.name ?? (yield* legacyPipelineName(id, o.name));
      if (newName !== oldName) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // The list endpoint returns summary items (id/name/endpoint only),
      // so hydrate each by name into the exact `read` Attributes shape
      // with bounded concurrency and a typed per-item not-found skip
      // (a pipeline can vanish between the list and the get).
      const summaries = yield* listLegacyPipelineSummaries(accountId);
      const rows = yield* Effect.forEach(
        summaries,
        (summary) =>
          getLegacyPipeline(accountId, summary.name).pipe(
            Effect.map((observed) =>
              observed ? toAttributes(observed, accountId) : undefined,
            ),
          ),
        { concurrency: 10 },
      );
      return rows.filter(
        (row): row is LegacyPipelineAttributes => row !== undefined,
      );
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      if (output?.name) {
        const observed = yield* getLegacyPipeline(acct, output.name);
        if (observed) return toAttributes(observed, acct);
      }
      // Cold read — names are unique per account; a generated-name match
      // is proof of ownership, an explicit name is not.
      const name = yield* legacyPipelineName(id, olds?.name);
      const observed = yield* getLegacyPipeline(acct, name);
      if (observed) {
        const attrs = toAttributes(observed, acct);
        return olds?.name !== undefined ? Unowned(attrs) : attrs;
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* legacyPipelineName(id, news.name);

      // 1. Observe — the name is the API identifier, so a single get
      //    covers both the cached-output and cold-recovery cases.
      let observed = yield* getLegacyPipeline(
        output?.accountId ?? accountId,
        output?.name ?? name,
      );

      // 2. Ensure — create when missing.
      if (!observed) {
        observed = yield* pipelines.createPipeline({
          accountId,
          name,
          source: toRequestSource(news.source),
          destination: toRequestDestination(accountId, news.destination),
        });
        return toAttributes(observed, accountId);
      }

      // 3. Sync — diff observed config against desired and PUT the full
      //    desired state only when something changed. Credentials are
      //    write-only, so `olds` is the only (best-effort) baseline for
      //    them: on adoption (`olds` undefined) or a credential change we
      //    push an update unconditionally.
      const credsRotated =
        olds === undefined ||
        Redacted.value(news.destination.credentials.accessKeyId) !==
          Redacted.value(olds.destination.credentials.accessKeyId) ||
        Redacted.value(news.destination.credentials.secretAccessKey) !==
          Redacted.value(olds.destination.credentials.secretAccessKey);
      if (credsRotated || drifted(observed, news)) {
        observed = yield* pipelines.updatePipeline({
          accountId,
          pipelineName: observed.name,
          name,
          source: toRequestSource(news.source),
          destination: toRequestDestination(accountId, news.destination),
        });
      }

      return toAttributes(observed, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* pipelines
        .deletePipeline({
          accountId: output.accountId,
          pipelineName: output.name,
        })
        .pipe(Effect.catchTag("PipelineNotExists", () => Effect.void));
    }),
  });

/**
 * The pipeline state shared by get/create/update responses.
 */
interface ObservedLegacyPipeline {
  id: string;
  name: string;
  endpoint: string;
  version: number;
  destination: {
    batch: { maxBytes: number; maxDurationS: number; maxRows: number };
    compression: { type: string };
    path: {
      bucket: string;
      filename?: string | null;
      filepath?: string | null;
      prefix?: string | null;
    };
  };
  source: readonly {
    type: string;
    authentication?: boolean | null;
    cors?: { origins?: readonly string[] | null } | null;
  }[];
}

const legacyPipelineName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    return yield* createPhysicalName({ id, lowercase: true, delimiter: "-" });
  });

/**
 * Read a legacy pipeline by name, mapping "gone" (`PipelineNotExists`,
 * Cloudflare error code 1000) to `undefined`.
 */
const getLegacyPipeline = (accountId: string, pipelineName: string) =>
  pipelines.getPipeline({ accountId, pipelineName }).pipe(
    Effect.map((p): ObservedLegacyPipeline | undefined => p),
    Effect.catchTag("PipelineNotExists", () => Effect.succeed(undefined)),
  );

interface LegacyPipelineSummary {
  id: string;
  name: string;
  endpoint: string;
}

/**
 * Enumerate every legacy pipeline summary in an account. The distilled
 * `listPipelines` op is not stream-paginated, so walk the `page`/
 * `per_page` query params using `result_info.total_count` (falling back
 * to a short-page sentinel) until every page is collected. The list
 * endpoint caps `per_page` at 50 and returns only summary fields.
 */
const listLegacyPipelineSummaries = (accountId: string) => {
  const perPage = 50;
  const collect = (
    page: number,
    acc: LegacyPipelineSummary[],
  ): Effect.Effect<
    LegacyPipelineSummary[],
    pipelines.ListPipelinesError,
    Credentials | HttpClient.HttpClient
  > =>
    Effect.gen(function* () {
      const response = yield* pipelines.listPipelines({
        accountId,
        page: String(page),
        perPage: String(perPage),
      });
      const results = (response.results ?? []).map(
        (p): LegacyPipelineSummary => ({
          id: p.id,
          name: p.name ?? "",
          endpoint: p.endpoint ?? "",
        }),
      );
      const next = [...acc, ...results];
      const total = response.resultInfo?.totalCount;
      const done =
        results.length < perPage ||
        (total !== undefined && next.length >= total);
      return done ? next : yield* collect(page + 1, next);
    });
  return collect(1, []);
};

const defaultSources: LegacyPipelineSource[] = [
  { type: "http" },
  { type: "binding" },
];

const toRequestSource = (source: LegacyPipelineSource[] | undefined) =>
  (source ?? defaultSources).map((s) =>
    s.type === "http"
      ? {
          format: "json" as const,
          type: s.type,
          authentication: s.authentication,
          cors: s.cors,
        }
      : { format: "json" as const, type: s.type },
  );

const toRequestDestination = (
  accountId: string,
  destination: LegacyPipelineDestination,
) => ({
  type: "r2" as const,
  format: "json" as const,
  batch: destination.batch ?? {},
  compression: { type: destination.compression },
  credentials: {
    accessKeyId: Redacted.value(destination.credentials.accessKeyId),
    secretAccessKey: Redacted.value(destination.credentials.secretAccessKey),
    endpoint:
      destination.credentials.endpoint ??
      `https://${accountId}.r2.cloudflarestorage.com`,
  },
  path: {
    bucket: destination.bucket as string,
    prefix: destination.prefix,
    filepath: destination.filepath,
    filename: destination.filename,
  },
});

/**
 * Detect drift between echoed cloud config and desired props. Only
 * user-declared optional fields are diffed so we don't fight server-side
 * defaults; credentials are write-only and handled separately.
 */
const drifted = (
  observed: ObservedLegacyPipeline,
  news: LegacyPipelineProps,
): boolean => {
  const d = news.destination;
  const path = observed.destination.path;
  if (path.bucket !== (d.bucket as string)) return true;
  if (d.prefix !== undefined && d.prefix !== (path.prefix ?? undefined)) {
    return true;
  }
  if (d.filepath !== undefined && d.filepath !== (path.filepath ?? undefined)) {
    return true;
  }
  if (d.filename !== undefined && d.filename !== (path.filename ?? undefined)) {
    return true;
  }
  if (
    d.compression !== undefined &&
    d.compression !== observed.destination.compression.type
  ) {
    return true;
  }
  const batch = observed.destination.batch;
  if (d.batch?.maxBytes !== undefined && d.batch.maxBytes !== batch.maxBytes) {
    return true;
  }
  if (
    d.batch?.maxDurationS !== undefined &&
    d.batch.maxDurationS !== batch.maxDurationS
  ) {
    return true;
  }
  if (d.batch?.maxRows !== undefined && d.batch.maxRows !== batch.maxRows) {
    return true;
  }
  // Sources — compare the declared set of source types and the declared
  // http options against what Cloudflare echoes.
  const desired = news.source ?? defaultSources;
  const observedTypes = observed.source.map((s) => s.type).sort();
  const desiredTypes = desired.map((s) => s.type).sort();
  if (observedTypes.join(",") !== desiredTypes.join(",")) return true;
  const desiredHttp = desired.find(
    (s): s is LegacyPipelineHttpSource => s.type === "http",
  );
  const observedHttp = observed.source.find((s) => s.type === "http");
  if (desiredHttp && observedHttp) {
    if (
      desiredHttp.authentication !== undefined &&
      desiredHttp.authentication !== (observedHttp.authentication ?? false)
    ) {
      return true;
    }
    if (desiredHttp.cors?.origins !== undefined) {
      const observedOrigins = observedHttp.cors?.origins ?? [];
      if (
        desiredHttp.cors.origins.length !== observedOrigins.length ||
        desiredHttp.cors.origins.some((o, i) => o !== observedOrigins[i])
      ) {
        return true;
      }
    }
  }
  return false;
};

const toAttributes = (
  observed: ObservedLegacyPipeline,
  accountId: string,
): LegacyPipelineAttributes => ({
  pipelineId: observed.id,
  accountId,
  name: observed.name,
  endpoint: observed.endpoint,
  bucket: observed.destination.path.bucket,
  version: observed.version,
});
