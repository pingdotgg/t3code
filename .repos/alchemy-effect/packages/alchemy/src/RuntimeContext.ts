import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { HttpEffect } from "./Http.ts";
import type { Output } from "./Output.ts";

export interface BaseRuntimeContext {
  Type: string;
  id: string;
  env: Record<string, any>;
  /**
   * Read a value by its (already-canonical) key. The key is used verbatim;
   * callers must {@link sanitizeKey} first. See {@link sanitizeKey}.
   */
  get<T>(key: string): Effect.Effect<T | undefined>;
  /**
   * Store an output under the given (already-canonical) key, returning the key.
   * The key is used verbatim; callers must {@link sanitizeKey} first.
   */
  set(id: string, output: Output): Effect.Effect<string>;
  exports?: Effect.Effect<Record<string, any>>;
  serve?<Req = never>(
    handler: HttpEffect<Req>,
    options?: { shape?: Record<string, unknown> },
  ): Effect.Effect<void, never, Req>;
  shape?: () => Record<string, unknown>;
  /** additional services to provide to the plan  */
  planServices?: Layer.Layer<any>;
}

/**
 * Canonicalize a logical key into a key that is safe to use as the name of an
 * environment variable / binding (`[a-zA-Z][a-zA-Z0-9_]*`).
 *
 * `RuntimeContext.set`/`get` are dumb key/value stores: they read and write the
 * key **verbatim**. It is the *caller's* responsibility to hand them a
 * canonical key, since the caller is the one that knows the logical key may
 * contain `.`/`-` (e.g. a dotted config name from `Platform`, or an
 * `Output.toString()` like `"QueueSinkQueue.queueUrl"`). Callers run the key
 * through this before calling `set`/`get` so both sides agree.
 */
export const sanitizeKey = (key: string): string =>
  key.replaceAll(/[^a-zA-Z0-9]/g, "_");

/**
 * The wire format `RuntimeContext.set`/`get` use to carry a `Redacted` value
 * through an environment variable. `JSON.stringify(Redacted)` emits the
 * literal string `"<redacted>"` and loses the value, so secrets are
 * serialized as this marker and the runtime `get` path rebuilds the wrapper.
 */
export interface RedactedMarker {
  readonly _tag: "Redacted";
  readonly value: unknown;
}

/**
 * Detect the (already JSON-parsed) {@link RedactedMarker} shape. After
 * `JSON.parse` the marker is a plain object — `Redacted.isRedacted` is
 * always `false` on it — so detection is structural.
 */
export const isRedactedMarker = (value: unknown): value is RedactedMarker =>
  typeof value === "object" &&
  value !== null &&
  (value as { _tag?: unknown })._tag === "Redacted" &&
  "value" in value;

/**
 * Serialize a binding value for an env var: `Redacted` values are packed as
 * a {@link RedactedMarker}, everything else is plain `JSON.stringify`.
 */
export const packEnvValue = (value: unknown): string =>
  Redacted.isRedacted(value)
    ? JSON.stringify({
        _tag: "Redacted",
        value: Redacted.value(value),
      } satisfies RedactedMarker)
    : JSON.stringify(value);

/**
 * Like {@link packEnvValue}, but a `Redacted` input keeps its `Redacted`
 * wrapper on the *outside* of the packed string, so deploy-time code can
 * route secrets through a dedicated channel (Cloudflare `secret_text`,
 * Secrets Store) instead of leaking them as plain env vars. The inner
 * payload still carries the marker for the runtime `get` accessor.
 */
export const packEnvValueKeepRedacted = (
  value: unknown,
): string | Redacted.Redacted<string> =>
  Redacted.isRedacted(value)
    ? Redacted.make(packEnvValue(value))
    : packEnvValue(value);

/**
 * Parse an env-var string produced by {@link packEnvValue} back into its
 * value: rebuild `Redacted` from the marker, return other JSON values
 * as-is, and fall back to the raw string for non-JSON input (e.g. an env
 * var the user set directly). `undefined` passes through.
 *
 * Runtime `get` accessors MUST feed this from the raw environment
 * (`process.env[key]` / the platform env object) — never through
 * `Config.string`: the ambient runtime `ConfigProvider` reifies bound
 * values (unwrapping the marker before it could be detected here), and
 * during init the ambient provider is the interceptor installed in
 * `Platform.ts`, whose runtime branch calls back into `ctx.get(key)` —
 * resolving through `Config` would re-enter it for the same key and
 * recurse forever.
 */
export const unpackEnvValue = <T>(raw: string | undefined): T | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRedactedMarker(parsed)) {
      return Redacted.make(parsed.value) as unknown as T;
    }
    return parsed as T;
  } catch {
    return raw as unknown as T; // assume it's just a string
  }
};

/**
 * Context of the runtime environment.
 *
 * E.g. the context of a running Worker, Task, Process, Function
 */
export class RuntimeContext extends Context.Service<
  RuntimeContext,
  BaseRuntimeContext
>()("RuntimeContext") {
  static phantom = Layer.empty as Layer.Layer<RuntimeContext>;
}

export const CurrentRuntimeContext = Effect.serviceOption(RuntimeContext).pipe(
  Effect.map(Option.getOrUndefined),
);
