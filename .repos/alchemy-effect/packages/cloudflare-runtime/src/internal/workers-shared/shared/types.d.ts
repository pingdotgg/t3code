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
      ? {
          -readonly [K in keyof T]: Mutable<T[K]>;
        }
      : T;
declare const StaticRoutingSchema: Schema.Struct<{
  readonly user_worker: Schema.$Array<Schema.String>;
  readonly asset_worker: Schema.optional<Schema.$Array<Schema.String>>;
}>;
export type StaticRouting = Mutable<typeof StaticRoutingSchema.Type>;
export declare const RouterConfigSchema: Schema.Struct<{
  readonly account_id: Schema.optional<Schema.Number>;
  readonly script_id: Schema.optional<Schema.Number>;
  readonly debug: Schema.optional<Schema.Boolean>;
  readonly invoke_user_worker_ahead_of_assets: Schema.optional<Schema.Boolean>;
  readonly static_routing: Schema.optional<
    Schema.Struct<{
      readonly user_worker: Schema.$Array<Schema.String>;
      readonly asset_worker: Schema.optional<Schema.$Array<Schema.String>>;
    }>
  >;
  readonly has_user_worker: Schema.optional<Schema.Boolean>;
}>;
export declare const EyeballRouterConfigSchema: Schema.NullOr<
  Schema.Struct<{
    readonly limitedAssetsOnly: Schema.optional<Schema.Boolean>;
  }>
>;
declare const MetadataStaticRedirects: Schema.$Record<
  Schema.String,
  Schema.Struct<{
    readonly status: Schema.Number;
    readonly to: Schema.String;
    readonly lineNumber: Schema.Number;
  }>
>;
export type MetadataStaticRedirects = Mutable<
  typeof MetadataStaticRedirects.Type
>;
declare const MetadataRedirects: Schema.$Record<
  Schema.String,
  Schema.Struct<{
    readonly status: Schema.Number;
    readonly to: Schema.String;
  }>
>;
export type MetadataRedirects = Mutable<typeof MetadataRedirects.Type>;
declare const MetadataHeaders: Schema.$Record<
  Schema.String,
  Schema.Struct<{
    readonly set: Schema.optional<Schema.$Record<Schema.String, Schema.String>>;
    readonly unset: Schema.optional<Schema.$Array<Schema.String>>;
  }>
>;
export type MetadataHeaders = Mutable<typeof MetadataHeaders.Type>;
export declare const RedirectsSchema: Schema.Struct<{
  readonly version: Schema.Literal<1>;
  readonly staticRules: Schema.$Record<
    Schema.String,
    Schema.Struct<{
      readonly status: Schema.Number;
      readonly to: Schema.String;
      readonly lineNumber: Schema.Number;
    }>
  >;
  readonly rules: Schema.$Record<
    Schema.String,
    Schema.Struct<{
      readonly status: Schema.Number;
      readonly to: Schema.String;
    }>
  >;
}>;
export declare const HeadersSchema: Schema.Struct<{
  readonly version: Schema.Literal<2>;
  readonly rules: Schema.$Record<
    Schema.String,
    Schema.Struct<{
      readonly set: Schema.optional<
        Schema.$Record<Schema.String, Schema.String>
      >;
      readonly unset: Schema.optional<Schema.$Array<Schema.String>>;
    }>
  >;
}>;
export declare const AssetConfigSchema: Schema.Struct<{
  readonly account_id: Schema.optional<Schema.Number>;
  readonly script_id: Schema.optional<Schema.Number>;
  readonly debug: Schema.optional<Schema.Boolean>;
  readonly compatibility_date: Schema.optional<Schema.String>;
  readonly compatibility_flags: Schema.optional<Schema.$Array<Schema.String>>;
  readonly html_handling: Schema.optional<
    Schema.Literals<
      readonly [
        "auto-trailing-slash",
        "force-trailing-slash",
        "drop-trailing-slash",
        "none",
      ]
    >
  >;
  readonly not_found_handling: Schema.optional<
    Schema.Literals<readonly ["single-page-application", "404-page", "none"]>
  >;
  readonly redirects: Schema.optional<
    Schema.Struct<{
      readonly version: Schema.Literal<1>;
      readonly staticRules: Schema.$Record<
        Schema.String,
        Schema.Struct<{
          readonly status: Schema.Number;
          readonly to: Schema.String;
          readonly lineNumber: Schema.Number;
        }>
      >;
      readonly rules: Schema.$Record<
        Schema.String,
        Schema.Struct<{
          readonly status: Schema.Number;
          readonly to: Schema.String;
        }>
      >;
    }>
  >;
  readonly headers: Schema.optional<
    Schema.Struct<{
      readonly version: Schema.Literal<2>;
      readonly rules: Schema.$Record<
        Schema.String,
        Schema.Struct<{
          readonly set: Schema.optional<
            Schema.$Record<Schema.String, Schema.String>
          >;
          readonly unset: Schema.optional<Schema.$Array<Schema.String>>;
        }>
      >;
    }>
  >;
  readonly has_static_routing: Schema.optional<Schema.Boolean>;
}>;
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
export {};
//# sourceMappingURL=types.d.ts.map
