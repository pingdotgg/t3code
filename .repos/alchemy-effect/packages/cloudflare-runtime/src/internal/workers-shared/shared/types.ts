// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import * as Schema from "effect/Schema";

/**
 * Strip `readonly` modifiers recursively. The upstream Cloudflare worker code
 * mutates these config values freely (e.g. `config.compatibility_flags.push(...)`),
 * so we expose mutable types rather than Schema's default `readonly` inference.
 */
type Mutable<T> =
  T extends ReadonlyArray<infer U>
    ? Array<Mutable<U>>
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T;

const InternalConfigFields = {
  account_id: Schema.optional(Schema.Number),
  script_id: Schema.optional(Schema.Number),
  debug: Schema.optional(Schema.Boolean),
};

const StaticRoutingSchema = Schema.Struct({
  user_worker: Schema.Array(Schema.String),
  asset_worker: Schema.optional(Schema.Array(Schema.String)),
});

export type StaticRouting = Mutable<typeof StaticRoutingSchema.Type>;

export const RouterConfigSchema = Schema.Struct({
  invoke_user_worker_ahead_of_assets: Schema.optional(Schema.Boolean),
  static_routing: Schema.optional(StaticRoutingSchema),
  has_user_worker: Schema.optional(Schema.Boolean),
  ...InternalConfigFields,
});

export const EyeballRouterConfigSchema = Schema.NullOr(
  Schema.Struct({
    limitedAssetsOnly: Schema.optional(Schema.Boolean),
  }),
);

const MetadataStaticRedirectEntry = Schema.Struct({
  status: Schema.Number,
  to: Schema.String,
  lineNumber: Schema.Number,
});

const MetadataRedirectEntry = Schema.Struct({
  status: Schema.Number,
  to: Schema.String,
});

const MetadataStaticRedirects = Schema.Record(
  Schema.String,
  MetadataStaticRedirectEntry,
);
export type MetadataStaticRedirects = Mutable<
  typeof MetadataStaticRedirects.Type
>;
const MetadataRedirects = Schema.Record(Schema.String, MetadataRedirectEntry);
export type MetadataRedirects = Mutable<typeof MetadataRedirects.Type>;

const MetadataHeaderEntry = Schema.Struct({
  set: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  unset: Schema.optional(Schema.Array(Schema.String)),
});

const MetadataHeaders = Schema.Record(Schema.String, MetadataHeaderEntry);
export type MetadataHeaders = Mutable<typeof MetadataHeaders.Type>;

export const RedirectsSchema = Schema.Struct({
  version: Schema.Literal(1),
  staticRules: MetadataStaticRedirects,
  rules: MetadataRedirects,
});

export const HeadersSchema = Schema.Struct({
  version: Schema.Literal(2),
  rules: MetadataHeaders,
});

export const AssetConfigSchema = Schema.Struct({
  compatibility_date: Schema.optional(Schema.String),
  compatibility_flags: Schema.optional(Schema.Array(Schema.String)),
  html_handling: Schema.optional(
    Schema.Literals([
      "auto-trailing-slash",
      "force-trailing-slash",
      "drop-trailing-slash",
      "none",
    ]),
  ),
  not_found_handling: Schema.optional(
    Schema.Literals(["single-page-application", "404-page", "none"]),
  ),
  redirects: Schema.optional(RedirectsSchema),
  headers: Schema.optional(HeadersSchema),
  has_static_routing: Schema.optional(Schema.Boolean),
  ...InternalConfigFields,
});

export type EyeballRouterConfig = Mutable<
  typeof EyeballRouterConfigSchema.Type
>;
export type RouterConfig = Mutable<typeof RouterConfigSchema.Type>;
export type AssetConfig = Mutable<typeof AssetConfigSchema.Type>;

export interface UnsafePerformanceTimer {
  readonly timeOrigin: number;
  now: () => number;
}

export interface JaegerTracing {
  enterSpan<T extends Array<unknown>, R = void>(
    name: string,
    span: (s: Span, ...args: T) => R,
    ...args: T
  ): R;
  getSpanContext(): SpanContext | null;
  runWithSpanContext<T extends Array<unknown>>(
    spanContext: SpanContext | null,
    callback: (...args: T) => unknown,
    ...args: T
  ): unknown;

  readonly traceId: string | null;
  readonly spanId: string | null;
  readonly parentSpanId: string | null;
  readonly cfTraceIdHeader: string | null;
}

export interface Span {
  addLogs(logs: JaegerRecord): void;
  setTags(tags: JaegerRecord): void;
  end(): void;

  isRecording: boolean;
}

export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  traceFlags: number;
}

export type JaegerValue = string | number | boolean;
export type JaegerRecord = Record<string, JaegerValue>;

export interface ColoMetadata {
  metalId: number;
  coloId: number;
  coloRegion: string;
  coloTier: number;
}
