/**
 * ProviderDriver / ProviderInstance — driver SPI as plain values.
 *
 * `ProviderDriver` is a record, not a Context.Service. The thing it produces
 * (`ProviderInstance`) is also a record — three captured closures
 * (`snapshot`, `adapter`, `textGeneration`), an id, and a driver kind. There
 * are intentionally no per-driver Context tags because tags are
 * singleton-per-runtime and we need many instances of the same driver.
 *
 * The only Effect service involved is `ProviderInstanceRegistry`, which
 * owns the live `Map<InstanceId, ProviderInstance>` and is itself a
 * singleton.
 *
 * Driver factories are functions of `(typed config, env)` where:
 *   - `typed config` is decoded once by the registry via `configSchema`,
 *     so drivers never deal with raw `unknown`.
 *   - `env` flows through Effect's R channel. Each driver declares the
 *     subset of infrastructure services it needs (FileSystem,
 *     ChildProcessSpawner, …) on its `create` return type; the registry
 *     layer's R is the union of those, and the runtime layer satisfies it.
 *
 * @module provider/ProviderDriver
 */
import type {
  ProviderDriverKind,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type { Effect, Schema, Scope } from "effect";

import type { TextGenerationShape } from "../textGeneration/TextGeneration.ts";
import type { ProviderAdapterError, ProviderDriverError } from "./Errors.ts";
import type { ProviderAdapterShape } from "./Services/ProviderAdapter.ts";
import type { ServerProviderShape } from "./Services/ServerProvider.ts";

/**
 * Static metadata advertised by a driver. Used for default presentation
 * and (later) settings UI. Doesn't need to be Effect-typed because nothing
 * about it is dynamic — drivers are registered at startup.
 */
export interface ProviderDriverMetadata {
  /** Human-readable name for the driver itself (e.g. "Codex"). */
  readonly displayName: string;
  /**
   * Whether the driver may be instantiated more than once concurrently.
   * Defaults to `true`. Set to `false` for drivers that wrap a global
   * resource (e.g. a single desktop app socket) — the registry then
   * rejects multi-instance configurations with a clear error.
   */
  readonly supportsMultipleInstances?: boolean;
}

/**
 * One materialized provider instance. Held by the registry, looked up by
 * `instanceId`, torn down by closing the scope it was created in.
 *
 * The three "shape" fields are captured closures owned by this instance —
 * stopping one instance cannot affect another, and starting a second
 * instance of the same driver does not reach into the first instance's
 * state.
 */
export interface ProviderInstance {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly continuationIdentity: ProviderContinuationIdentity;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly iconUrl?: string | undefined;
  readonly enabled: boolean;
  readonly snapshot: ServerProviderShape;
  readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
  readonly textGeneration: TextGenerationShape;
}

export interface ProviderContinuationIdentity {
  readonly driverKind: ProviderDriverKind;
  readonly continuationKey: string;
}

export function defaultProviderContinuationIdentity(input: {
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
}): ProviderContinuationIdentity {
  return {
    driverKind: input.driverKind,
    continuationKey: `${input.driverKind}:instance:${input.instanceId}`,
  };
}

/**
 * Inputs the registry passes to a driver's `create` function.
 *
 * `config` is the typed payload — already decoded by the registry through
 * `driver.configSchema`. Drivers never decode their own raw envelope.
 */
export interface ProviderDriverCreateInput<Config> {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly iconUrl?: string | undefined;
  readonly environment: ProviderInstanceEnvironment;
  readonly enabled: boolean;
  readonly config: Config;
}

/**
 * Driver SPI — registered as a plain value, not a Layer.
 *
 * `Config` is whatever the driver decoded from
 * `ProviderInstanceConfig.config`. `R` is the union of infrastructure
 * services the driver depends on; the registry layer aggregates `R` across
 * all registered drivers and the runtime supplies them.
 *
 * `create` is responsible for *all* per-instance state — process handles,
 * pubsub topics, refs, file watchers — and must release them when its
 * scope closes. Two calls to `create` with different `instanceId` /
 * `config` MUST yield instances with no shared mutable state.
 */
export interface ProviderDriver<Config, R = never> {
  readonly driverKind: ProviderDriverKind;
  readonly metadata: ProviderDriverMetadata;
  /**
   * Decoder for the opaque `ProviderInstanceConfig.config` envelope. The
   * registry runs this exactly once per (re)load of an instance; a decode
   * failure is surfaced as `ProviderDriverError` and downgraded to an
   * unavailable shadow snapshot.
   *
   * The `Encoded` parameter is intentionally left as `unknown` (not
   * `Config`) so schemas with `withDecodingDefault` / transformations — where
   * the encoded shape differs from the decoded shape — satisfy the SPI
   * without casts. The registry only ever decodes `unknown` envelopes here,
   * so the precise encoded type is irrelevant at this boundary.
   *
   * Using `Codec` rather than `Schema` pins `DecodingServices = never` — if
   * we used `Schema<Config>`, the erased `any` in `AnyProviderDriver` would
   * widen `DecodingServices` to `unknown` and poison the R channel of every
   * caller of `decodeUnknownEffect`.
   */
  readonly configSchema: Schema.Codec<Config, unknown>;
  /**
   * Default config payload used when the legacy
   * `ServerSettings.providers.<kind>` entry is empty or when the driver
   * is auto-bootstrapped without user configuration. Returning a typed
   * default keeps the migration path simple — no special-casing needed
   * to construct a "blank" instance.
   */
  readonly defaultConfig: () => Config;
  /**
   * Materialize one instance. The returned effect runs in a scope owned
   * by the registry; closing that scope releases every resource the
   * driver opened. Failures become unavailable shadow snapshots — the
   * driver MUST NOT throw defects.
   */
  readonly create: (
    input: ProviderDriverCreateInput<Config>,
  ) => Effect.Effect<ProviderInstance, ProviderDriverError, R | Scope.Scope>;
}

/**
 * Heterogeneous-array convenience: the registry stores drivers as
 * `ReadonlyArray<AnyProviderDriver<R>>` where `R` is the union of all
 * registered drivers' env requirements.
 */
// `any` here intentionally erases the per-driver Config; the registry
// already decoded it before invoking `create`, so downstream code never
// needs the original `Config` type. Using `unknown` instead would force
// `create` callers into casts since `unknown` is not assignable to a
// concrete `Config` from inside the driver body.
export type AnyProviderDriver<R = never> = ProviderDriver<any, R>;
