import * as pipelines from "@distilled.cloud/cloudflare/pipelines";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import type { PropsInput } from "alchemy/Input";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource, type ResourceClass } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import type * as Schema from "effect/Schema";
import * as EffectStream from "effect/Stream";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import {
  canonicalStreamFields,
  isEffectSchema,
  StreamSchemaUnsupported,
  streamFieldsFromSchema,
  type StreamFieldsSchema,
} from "./StreamSchema.ts";

const StreamTypeId = "Cloudflare.Pipelines.Stream" as const;
type StreamTypeId = typeof StreamTypeId;

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
   * token with the `Pipelines Send` permission.
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
   * Structured schema of ingested events — either an explicit field list
   * or an Effect Schema (`Schema.Struct` / `Schema.Class`), which is
   * converted to the field list and also types and encodes the records
   * sent through `WriteStream` / `StreamSink`.
   *
   * Immutable — changing the (derived) field list triggers a replacement,
   * which drops buffered events and dependent pipelines. Equivalent
   * spellings (a field list ⇄ the matching Effect Schema) are a no-op.
   * When omitted, the stream accepts unstructured JSON events.
   */
  schema?: StreamFieldsSchema | Schema.Top;
  /**
   * Input format configuration. Immutable — changing it triggers a
   * replacement.
   * @default { type: "json" }
   */
  format?: StreamFormat;
  /**
   * HTTP ingest endpoint configuration. Mutable in place.
   *
   * - omitted / `false` — no public HTTP endpoint (`{ enabled: false }`)
   * - `true` — endpoint enabled, API-token authentication required
   * - an object — explicit settings
   * @default false
   */
  http?: boolean | StreamHttp;
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

/**
 * A Pipelines stream. `A` is the record type sent through `WriteStream` /
 * `StreamSink` — the Effect Schema's `Type` when the stream was declared
 * with one.
 */
export interface Stream<A = unknown> extends Resource<
  StreamTypeId,
  StreamProps,
  StreamAttributes,
  never,
  Providers
> {
  /**
   * The Effect Schema the stream was declared with, if any. Used by the
   * producer clients to encode records; never persisted.
   */
  readonly RecordSchema: Schema.Top | undefined;
  /** Phantom record type. */
  readonly "~record"?: A;
}

/**
 * The record type a producer sends to a `Stream<A>`: the declared Effect
 * Schema's `Type`, or an untyped JSON object.
 */
export type StreamRecord<A> = unknown extends A ? Record<string, unknown> : A;

/**
 * Props of a stream declared with an Effect Schema.
 */
export type StreamSchemaProps<S extends Schema.Top> = PropsInput<Omit<StreamProps, "schema">> & {
  schema: S;
};

const StreamResource = Resource<Stream>(StreamTypeId);

/**
 * The Stream constructor: the plain resource constructor plus an overload
 * that infers the record type from an Effect Schema `schema`.
 */
export type StreamClass = {
  <const S extends Schema.Top>(
    id: string,
    props: StreamSchemaProps<S>,
  ): Effect.Effect<Stream<S["Type"]>, never, Providers>;
} & ResourceClass<Stream>;

/**
 * Convert an Effect Schema `schema` prop into the persisted field list and
 * keep the schema aside for the producer clients. Dies with a clear
 * {@link StreamSchemaUnsupported} when the schema has no stream
 * representation — this runs while the program is constructed, before
 * anything is planned.
 */
const normalizeStreamProps = (
  props: unknown,
): Effect.Effect<{ props: unknown; recordSchema: Schema.Top | undefined }> =>
  Effect.suspend((): Effect.Effect<{ props: unknown; recordSchema: Schema.Top | undefined }> => {
    const schema = (props as { schema?: unknown } | undefined)?.schema;
    if (!isEffectSchema(schema)) {
      return Effect.succeed({ props, recordSchema: undefined });
    }
    return resolveSchema(schema).pipe(
      Effect.map((resolved) => ({
        props: { ...(props as object), schema: resolved },
        recordSchema: schema,
      })),
      Effect.orDie,
    );
  });

const constructStream = (id: string, props: unknown) =>
  Effect.gen(function* () {
    let recordSchema: Schema.Top | undefined;
    const capture = (n: { props: unknown; recordSchema: Schema.Top | undefined }) => {
      recordSchema = n.recordSchema;
      return n.props;
    };
    const normalized = Effect.isEffect(props)
      ? // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- props are untyped; Effect-valued props are resolved by the engine
        (props as Effect.Effect<unknown>).pipe(
          Effect.flatMap(normalizeStreamProps),
          Effect.map(capture),
        )
      : capture(yield* normalizeStreamProps(props));
    const construct = StreamResource as unknown as (
      id: string,
      props: unknown,
    ) => Effect.Effect<Stream, never, Providers>;
    const stream = yield* construct(id, normalized);
    (stream as { RecordSchema: Schema.Top | undefined }).RecordSchema = recordSchema;
    return stream;
  });

/**
 * A Cloudflare Pipelines stream — the ingestion endpoint of the Pipelines
 * product (also exported as `Cloudflare.Basin.Stream`). Events are sent to
 * a stream from Workers (`WriteStream` / `StreamSink`) or over HTTP,
 * transformed by a SQL {@link Pipeline}, and written to a {@link Sink}.
 *
 * The stream's `schema` and `format` are fixed at creation (changing them
 * triggers a replacement, which drops buffered events and dependent
 * pipelines); the HTTP endpoint and Worker-binding toggles are mutable in
 * place.
 *
 * Pipelines is ingest-only — there is no event source on a stream. To
 * process data after it lands, subscribe to the sink's bucket with
 * `Cloudflare.R2.BucketEventNotification`.
 *
 * Cloudflare accepts records that violate a structured stream's schema
 * (they are dropped later, during processing). Declare the schema as an
 * Effect Schema to have the producer clients validate and encode every
 * record before it is sent.
 *
 * :::caution
 * A stream declared without `http` has **no** public ingest endpoint
 * (`http: { enabled: false }`). Earlier versions sent nothing, and
 * Cloudflare's default is a public, unauthenticated endpoint. Existing
 * streams are updated in place on the next deploy; set `http: true`
 * (authenticated) or `http: { enabled: true }` to keep an endpoint.
 * :::
 *
 * ### Creating a Stream
 * **Example:** Unstructured stream with default settings
 * ```typescript
 * const stream = yield* Cloudflare.Basin.Stream("events", {});
 * ```
 *
 * **Example:** Structured stream from an Effect Schema
 * ```typescript
 * class PageView extends Schema.Class<PageView>("PageView")({
 *   url: Schema.String,
 *   at: Schema.Date,
 *   tags: Schema.Array(Schema.String),
 *   user: Schema.optional(Schema.Struct({ id: Schema.String })),
 * }) {}
 *
 * // Stream<PageView>: WriteStream / StreamSink are typed and encode records
 * const stream = yield* Cloudflare.Basin.Stream("PageViews", {
 *   schema: PageView,
 * });
 * ```
 *
 * **Example:** Structured stream with an explicit field list
 * ```typescript
 * const stream = yield* Cloudflare.Basin.Stream("clicks", {
 *   schema: {
 *     fields: [
 *       { type: "string", name: "url", required: true },
 *       { type: "timestamp", name: "ts", unit: "millisecond" },
 *       { type: "list", name: "tags", items: { type: "string" } },
 *       {
 *         type: "struct",
 *         name: "user",
 *         fields: [{ type: "string", name: "id" }],
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * ### HTTP ingestion
 * **Example:** Authenticated endpoint
 * ```typescript
 * const stream = yield* Cloudflare.Basin.Stream("events", { http: true });
 * // POST a JSON array to stream.endpoint with a `Pipelines Send` token,
 * // or use Cloudflare.Basin.WriteStreamHttp / WriteStreamLocal.
 * ```
 *
 * **Example:** Public endpoint with CORS
 * ```typescript
 * const stream = yield* Cloudflare.Basin.Stream("beacons", {
 *   http: {
 *     enabled: true,
 *     authentication: false,
 *     cors: { origins: ["https://app.example.com"] },
 *   },
 * });
 * ```
 *
 * ### Wiring into a Pipeline
 * **Example:** Stream → SQL Pipeline → Sink
 * ```typescript
 * const pipeline = yield* Cloudflare.Basin.Pipeline("etl", {
 *   sql: Output.interpolate`INSERT INTO ${sink.name} SELECT * FROM ${stream.name}`,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/pipelines/
 *
 * @resource
 * @product Pipelines
 * @category Storage & Databases
 */
export const Stream: StreamClass = Object.assign(
  (...args: [id: string, props?: unknown] | [methods: object]) =>
    typeof args[0] === "object"
      ? Object.assign(Stream, args[0])
      : constructStream(args[0], (args as [string, unknown])[1]),
  StreamResource,
  Effectable.Prototype({
    label: `Resource<${StreamTypeId}>`,
    evaluate: () => Effect.succeed((id: string, props: unknown) => constructStream(id, props)),
  }),
) as unknown as StreamClass;

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
      if (o === undefined) return undefined;
      // Schema and format are immutable. Compare CANONICAL derived values
      // so equivalent spellings (field list ⇄ Effect Schema, omitted ⇄
      // explicit defaults) never replace.
      const newSchema = yield* canonicalSchema(news.schema);
      const oldSchema = yield* canonicalSchema(o.schema);
      if (!stableEquals(newSchema, oldSchema)) {
        return { action: "replace" } as const;
      }
      if (!stableEquals(canonicalFormat(news.format), canonicalFormat(o.format))) {
        return { action: "replace" } as const;
      }
      if (output === undefined) return undefined;
      // http/workerBinding are patchable: diff desired against the last
      // observed state, so the secure http default reaches streams created
      // before it existed.
      const httpConverged = httpMatches(desiredHttp(news.http), {
        enabled: output.httpEnabled,
        authentication: output.httpAuthentication,
        origins: output.corsOrigins,
      });
      const bindingConverged =
        news.workerBinding === undefined ||
        news.workerBinding.enabled === output.workerBindingEnabled;
      return httpConverged && bindingConverged
        ? ({ action: "noop" } as const)
        : ({ action: "update" } as const);
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
      const http = desiredHttp(news.http);

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
        const schema = yield* resolveSchema(news.schema);
        observed = yield* pipelines
          .createStream({
            accountId,
            name,
            format: news.format,
            // The distilled field union does not model nested `items` /
            // `fields`; they pass through to the wire verbatim.
            schema: schema as pipelines.CreateStreamRequest["schema"],
            http,
            workerBinding: news.workerBinding,
          })
          .pipe(
            Effect.catchTag("StreamAlreadyExists", (error) =>
              findStreamByName(accountId, name).pipe(
                Effect.flatMap((match) => (match ? Effect.succeed(match) : Effect.fail(error))),
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
      if (
        !httpMatches(http, {
          enabled: observed.http.enabled,
          authentication: observed.http.authentication,
          origins: observed.http.cors?.origins,
        })
      ) {
        patch.http = http;
        dirty = true;
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
            schedule: Schedule.max([Schedule.exponential("500 millis"), Schedule.recurs(8)]),
          }),
          Effect.catchTags({
            StreamNotFound: () => Effect.void,
            InvalidStreamId: () => Effect.void,
          }),
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
    Effect.catchTags({
      StreamNotFound: () => Effect.undefined,
      InvalidStreamId: () => Effect.undefined,
    }),
  );

const findStreamByName = (accountId: string, name: string) =>
  pipelines.listStreams.items({ accountId }).pipe(
    EffectStream.runCollect,
    Effect.map((chunk): ObservedStream | undefined =>
      Array.from(chunk).find((s) => s.name === name),
    ),
  );

/** Resolve a `schema` prop (field list or Effect Schema) to the field-list form. */
const resolveSchema = (
  schema: StreamFieldsSchema | Schema.Top | undefined,
): Effect.Effect<StreamFieldsSchema | undefined, StreamSchemaUnsupported> =>
  isEffectSchema(schema)
    ? Effect.try({
        try: () => ({ fields: streamFieldsFromSchema(schema) }),
        catch: (error) =>
          error instanceof StreamSchemaUnsupported
            ? error
            : new StreamSchemaUnsupported({ path: "", message: String(error) }),
      })
    : Effect.succeed(schema as StreamFieldsSchema | undefined);

const canonicalSchema = (schema: StreamFieldsSchema | Schema.Top | undefined) =>
  resolveSchema(schema).pipe(
    Effect.map((resolved) =>
      resolved === undefined ? undefined : canonicalStreamFields(resolved.fields),
    ),
  );

const canonicalFormat = (format: StreamFormat | undefined) => {
  const f = format ?? { type: "json" as const };
  return {
    type: f.type,
    unstructured: f.unstructured,
    timestampFormat: f.timestampFormat ?? "rfc3339",
    decimalEncoding: f.decimalEncoding,
  };
};

interface DesiredHttp {
  enabled: boolean;
  authentication: boolean;
  cors?: { origins: string[] };
}

/**
 * Desired HTTP ingest settings. Omitted (or `false`) means no endpoint —
 * Cloudflare's own default is a public, unauthenticated endpoint.
 */
const desiredHttp = (http: boolean | StreamHttp | undefined): DesiredHttp => {
  if (http === undefined || http === false) {
    return { enabled: false, authentication: false };
  }
  if (http === true) return { enabled: true, authentication: true };
  return {
    enabled: http.enabled ?? true,
    authentication: http.authentication ?? false,
    cors: http.cors?.origins ? { origins: http.cors.origins } : undefined,
  };
};

const httpMatches = (
  desired: DesiredHttp,
  observed: {
    enabled: boolean;
    authentication: boolean;
    origins: readonly string[] | null | undefined;
  },
) => {
  // A disabled endpoint's auth/CORS settings are inert.
  if (!desired.enabled) return !observed.enabled;
  return (
    observed.enabled &&
    desired.authentication === observed.authentication &&
    sameOrigins(desired.cors?.origins, observed.origins)
  );
};

const sameOrigins = (
  desired: readonly string[] | undefined,
  observed: readonly string[] | null | undefined,
) => {
  // Only diff origins when the user declared them; Cloudflare's default
  // is not ours to fight.
  if (desired === undefined) return true;
  const have = observed ?? [];
  return (
    desired.length === have.length && [...desired].sort().join(",") === [...have].sort().join(",")
  );
};

/**
 * Key-order-insensitive structural equality for plain JSON-ish prop
 * values (schemas, formats).
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

const toAttributes = (observed: ObservedStream, accountId: string): StreamAttributes => ({
  streamId: observed.id,
  accountId,
  name: observed.name,
  endpoint: observed.endpoint ?? undefined,
  httpEnabled: observed.http.enabled,
  httpAuthentication: observed.http.authentication,
  corsOrigins: observed.http.cors?.origins ? [...observed.http.cors.origins] : undefined,
  workerBindingEnabled: observed.workerBinding.enabled,
  version: observed.version,
  createdAt: observed.createdAt,
  modifiedAt: observed.modifiedAt,
});
