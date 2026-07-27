import * as pipelines from "@distilled.cloud/cloudflare/pipelines";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as EffectStream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const StreamTypeId = "Cloudflare.Pipelines.Stream" as const;
type StreamTypeId = typeof StreamTypeId;

/**
 * Scalar field types accepted by a structured stream schema.
 */
export type StreamFieldType =
  | "int32"
  | "int64"
  | "float32"
  | "float64"
  | "bool"
  | "string"
  | "binary"
  | "json";

/**
 * A single field of a structured stream schema. `timestamp` fields
 * additionally accept a `unit`.
 */
export type StreamField =
  | {
      /** Field type. */
      type: StreamFieldType;
      /** Field name as it appears in ingested events. */
      name: string;
      /** Whether the field must be present in every event. */
      required?: boolean;
      /** Name to expose to SQL when it differs from `name`. */
      sqlName?: string;
      /** Metadata key the field is populated from instead of the event body. */
      metadataKey?: string;
    }
  | {
      /** Timestamp field type. */
      type: "timestamp";
      /** Field name as it appears in ingested events. */
      name: string;
      /** Whether the field must be present in every event. */
      required?: boolean;
      /** Name to expose to SQL when it differs from `name`. */
      sqlName?: string;
      /** Metadata key the field is populated from instead of the event body. */
      metadataKey?: string;
      /**
       * Precision of the timestamp.
       * @default "millisecond"
       */
      unit?: "second" | "millisecond" | "microsecond" | "nanosecond";
    };

/**
 * Input format of events ingested by the stream.
 */
export interface StreamFormat {
  /** Only JSON ingestion is supported. */
  type: "json";
  /**
   * Accept events of any shape (no schema enforcement).
   */
  unstructured?: boolean;
  /**
   * How timestamps are rendered in ingested JSON.
   * @default "rfc3339"
   */
  timestampFormat?: "rfc3339" | "unix_millis";
  /** How decimals are encoded in ingested JSON. */
  decimalEncoding?: "number" | "string" | "bytes";
}

/**
 * HTTP ingest endpoint configuration. Mutable in place.
 */
export interface StreamHttp {
  /**
   * Whether the stream exposes an HTTP ingest endpoint.
   * @default true
   */
  enabled?: boolean;
  /**
   * Whether requests to the HTTP endpoint must carry a Cloudflare API
   * token.
   * @default false
   */
  authentication?: boolean;
  /** CORS configuration for browser-originated ingestion. */
  cors?: {
    /** Allowed origins, e.g. `["https://app.example.com"]` or `["*"]`. */
    origins?: string[];
  };
}

export interface StreamProps {
  /**
   * Name of the stream. Unique per account; must be alphanumeric and
   * underscores only (it is referenced as a SQL table name). If omitted,
   * a unique name is generated from the app, stage, and logical ID.
   * Changing the name triggers a replacement.
   * @default ${app}_${id}_${stage}_${suffix}
   */
  name?: string;
  /**
   * Structured schema of ingested events. Immutable — changing the schema
   * triggers a replacement. When omitted, the stream accepts unstructured
   * JSON events.
   */
  schema?: {
    /** Fields of the structured schema. */
    fields: StreamField[];
  };
  /**
   * Input format configuration. Immutable — changing it triggers a
   * replacement.
   * @default { type: "json" }
   */
  format?: StreamFormat;
  /**
   * HTTP ingest endpoint configuration. Mutable in place.
   * @default { enabled: true, authentication: false }
   */
  http?: StreamHttp;
  /**
   * Whether Workers can send events to this stream via a `pipelines`
   * binding. Mutable in place.
   * @default { enabled: true }
   */
  workerBinding?: {
    /** Whether the Worker binding is enabled. */
    enabled: boolean;
  };
}

export interface StreamAttributes {
  /** Cloudflare-assigned stream identifier. */
  streamId: string;
  /** Account that owns the stream. */
  accountId: string;
  /** Stream name (unique per account). */
  name: string;
  /** HTTP ingest endpoint URL, when HTTP ingestion is enabled. */
  endpoint: string | undefined;
  /** Whether the HTTP ingest endpoint is enabled. */
  httpEnabled: boolean;
  /** Whether the HTTP ingest endpoint requires authentication. */
  httpAuthentication: boolean;
  /** Allowed CORS origins of the HTTP ingest endpoint. */
  corsOrigins: string[] | undefined;
  /** Whether Workers can send events via a `pipelines` binding. */
  workerBindingEnabled: boolean;
  /** Current version of the stream. */
  version: number;
  /** When the stream was created. */
  createdAt: string;
  /** When the stream was last modified. */
  modifiedAt: string;
}

export type Stream = Resource<
  StreamTypeId,
  StreamProps,
  StreamAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Pipelines stream — the ingestion endpoint of the Pipelines
 * product. Events are sent to a stream over HTTP (and/or from Workers via
 * a binding), transformed by a SQL {@link Pipeline}, and written to a
 * {@link Sink}.
 *
 * The stream's `schema` and `format` are fixed at creation (changing them
 * triggers a replacement); the HTTP endpoint and Worker-binding toggles
 * are mutable in place.
 * @resource
 * @product Pipelines
 * @category Storage & Databases
 * @section Creating a Stream
 * @example Unstructured stream with default settings
 * ```typescript
 * const stream = yield* Cloudflare.Pipelines.Stream("events", {});
 * ```
 *
 * @example Structured stream with a typed schema
 * ```typescript
 * const stream = yield* Cloudflare.Pipelines.Stream("clicks", {
 *   schema: {
 *     fields: [
 *       { type: "string", name: "url", required: true },
 *       { type: "timestamp", name: "ts", unit: "millisecond" },
 *     ],
 *   },
 * });
 * ```
 *
 * @section HTTP ingestion
 * @example Authenticated endpoint with CORS
 * ```typescript
 * const stream = yield* Cloudflare.Pipelines.Stream("events", {
 *   http: {
 *     enabled: true,
 *     authentication: true,
 *     cors: { origins: ["https://app.example.com"] },
 *   },
 * });
 * // POST events to stream.endpoint with an API token
 * ```
 *
 * @section Wiring into a Pipeline
 * @example Stream → SQL Pipeline → R2 Sink
 * ```typescript
 * const pipeline = yield* Cloudflare.Pipelines.Pipeline("etl", {
 *   sql: Output.interpolate`INSERT INTO ${sink.name} SELECT * FROM ${stream.name}`,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/pipelines/
 */
export const Stream = Resource<Stream>(StreamTypeId);

/**
 * Returns true if the given value is a Stream resource.
 */
export const isStream = (value: unknown): value is Stream =>
  Predicate.hasProperty(value, "Type") && value.Type === StreamTypeId;

export const StreamProvider = () =>
  Provider.succeed(Stream, {
    stables: ["streamId", "accountId", "name", "createdAt"],

    diff: Effect.fn(function* ({ id, olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      const o = olds as StreamProps | undefined;
      const newName = yield* streamName(id, news.name);
      const oldName = output?.name ?? (yield* streamName(id, o?.name));
      if (newName !== oldName) {
        return { action: "replace" } as const;
      }
      // Schema and format are immutable — only http/workerBinding are
      // patchable.
      if (o !== undefined && !stableEquals(news.schema, o.schema)) {
        return { action: "replace" } as const;
      }
      if (o !== undefined && !stableEquals(news.format, o.format)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      if (output?.streamId) {
        const observed = yield* getStream(acct, output.streamId);
        if (observed) return toAttributes(observed, acct);
      }
      // Cold read — stream names are unique per account, so an exact name
      // match identifies the resource. A generated name embeds the
      // instance id (proof of ownership); a user-provided name does not,
      // so gate takeover behind the adopt policy.
      const name = yield* streamName(id, olds?.name);
      const match = yield* findStreamByName(acct, name);
      if (match) {
        const attrs = toAttributes(match, acct);
        return olds?.name !== undefined ? Unowned(attrs) : attrs;
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* streamName(id, news.name);

      // 1. Observe — the cached streamId is a hint, not a guarantee; a
      //    missing stream falls through to a name lookup and then create.
      let observed = output?.streamId
        ? yield* getStream(output.accountId ?? accountId, output.streamId)
        : undefined;
      if (!observed) {
        observed = yield* findStreamByName(accountId, name);
      }

      // 2. Ensure — create when missing. Stream names are unique, so an
      //    AlreadyExists is a race (or recovery from a lost state write):
      //    fall back to the name lookup.
      if (!observed) {
        observed = yield* pipelines
          .createStream({
            accountId,
            name,
            format: news.format,
            schema: news.schema,
            http: news.http ? desiredHttp(news.http) : undefined,
            workerBinding: news.workerBinding,
          })
          .pipe(
            Effect.catchTag("StreamAlreadyExists", (error) =>
              findStreamByName(accountId, name).pipe(
                Effect.flatMap((match) =>
                  match ? Effect.succeed(match) : Effect.fail(error),
                ),
              ),
            ),
          );
      }

      // 3. Sync — http and workerBinding are the only mutable aspects.
      //    Diff observed cloud state against the declared desired state
      //    and PATCH only the delta; skip the API entirely on a no-op.
      const patch: pipelines.PatchStreamRequest = {
        accountId,
        streamId: observed.id,
      };
      let dirty = false;
      if (news.http !== undefined) {
        const desired = desiredHttp(news.http);
        if (
          desired.enabled !== observed.http.enabled ||
          desired.authentication !== observed.http.authentication ||
          !sameOrigins(desired.cors?.origins, observed.http.cors?.origins)
        ) {
          patch.http = desired;
          dirty = true;
        }
      }
      if (
        news.workerBinding !== undefined &&
        news.workerBinding.enabled !== observed.workerBinding.enabled
      ) {
        patch.workerBinding = { enabled: news.workerBinding.enabled };
        dirty = true;
      }
      if (dirty) {
        observed = yield* pipelines.patchStream(patch);
      }

      return toAttributes(observed, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      // A dependent pipeline's own deletion may still be propagating —
      // ride out `StreamInUse` (HTTP 422 "still in use") with a bounded
      // retry. A stream that is already gone is success.
      yield* pipelines
        .deleteStream({
          accountId: output.accountId,
          streamId: output.streamId,
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "StreamInUse",
            schedule: Schedule.max([
              Schedule.exponential("500 millis"),
              Schedule.recurs(8),
            ]),
          }),
          Effect.catchTag("StreamNotFound", () => Effect.void),
          Effect.catchTag("InvalidStreamId", () => Effect.void),
        );
    }),

    // Account-scoped collection: exhaustively paginate every stream in the
    // account and hydrate each into the same Attributes shape `read`
    // returns. The list item shape is structurally identical to the
    // get/create response consumed by `toAttributes`.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* pipelines.listStreams.pages({ accountId }).pipe(
        EffectStream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((s) => toAttributes(s, accountId)),
          ),
        ),
      );
    }),
  });

/**
 * The subset of stream state shared by get/list/create/patch responses.
 */
interface ObservedStream {
  id: string;
  name: string;
  endpoint?: string | null;
  http: {
    enabled: boolean;
    authentication: boolean;
    cors?: { origins?: readonly string[] | null } | null;
  };
  workerBinding: { enabled: boolean };
  version: number;
  createdAt: string;
  modifiedAt: string;
}

// Pipelines entity names must be alphanumeric/underscore only (they are
// referenced as SQL table names), so swap the default hyphen delimiter
// for underscores.
const streamName = (id: string, name: string | undefined) =>
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
 * Read a stream by id, mapping "gone" (`StreamNotFound`, Cloudflare error
 * code 1016, or `InvalidStreamId` for a malformed/foreign id) to
 * `undefined`.
 */
const getStream = (accountId: string, streamId: string) =>
  pipelines.getStream({ accountId, streamId }).pipe(
    Effect.map((s): ObservedStream | undefined => s),
    Effect.catchTag("StreamNotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidStreamId", () => Effect.succeed(undefined)),
  );

const findStreamByName = (accountId: string, name: string) =>
  pipelines.listStreams.items({ accountId }).pipe(
    EffectStream.runCollect,
    Effect.map((chunk): ObservedStream | undefined =>
      Array.from(chunk).find((s) => s.name === name),
    ),
  );

const desiredHttp = (http: StreamHttp) => ({
  enabled: http.enabled ?? true,
  authentication: http.authentication ?? false,
  cors: http.cors?.origins ? { origins: http.cors.origins } : undefined,
});

const sameOrigins = (
  desired: readonly string[] | undefined,
  observed: readonly string[] | null | undefined,
) => {
  // Only diff origins when the user declared them; Cloudflare's default
  // is not ours to fight.
  if (desired === undefined) return true;
  const have = observed ?? [];
  return (
    desired.length === have.length &&
    [...desired].sort().join(",") === [...have].sort().join(",")
  );
};

/**
 * Key-order-insensitive structural equality for plain JSON-ish prop
 * values (schemas, formats).
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
  observed: ObservedStream,
  accountId: string,
): StreamAttributes => ({
  streamId: observed.id,
  accountId,
  name: observed.name,
  endpoint: observed.endpoint ?? undefined,
  httpEnabled: observed.http.enabled,
  httpAuthentication: observed.http.authentication,
  corsOrigins: observed.http.cors?.origins
    ? [...observed.http.cors.origins]
    : undefined,
  workerBindingEnabled: observed.workerBinding.enabled,
  version: observed.version,
  createdAt: observed.createdAt,
  modifiedAt: observed.modifiedAt,
});
