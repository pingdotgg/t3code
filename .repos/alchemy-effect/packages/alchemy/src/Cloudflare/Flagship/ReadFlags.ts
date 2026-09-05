import type * as cf from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { App } from "./App.ts";

/**
 * Bind a {@link App} to a Worker and obtain the Effect-native flag-evaluation
 * client (`get`, `getBooleanValue`, `getStringValue`, …).
 *
 * `ReadFlags` is a single identifier that is simultaneously the binding's
 * Context tag, its type, and the callable —
 * `yield* Cloudflare.Flagship.ReadFlags(app)`.
 *
 * @example Evaluating a flag inside a Worker
 * ```typescript
 * const flags = yield* Cloudflare.Flagship.ReadFlags(MyApp);
 * const enabled = yield* flags.getBooleanValue("new-checkout", false);
 * ```
 *
 * @binding
 * @product Flagship
 * @category Developer Platform
 */
export interface ReadFlags extends Binding.Service<
  ReadFlags,
  "Cloudflare.Flagship.ReadFlags",
  (app: App) => Effect.Effect<ReadFlagsClient>
> {}

export const ReadFlags = Binding.Service<ReadFlags>(
  "Cloudflare.Flagship.ReadFlags",
);

export class FlagshipError extends Data.TaggedError("FlagshipError")<{
  message: string;
  cause: unknown;
}> {}

/** An Effect produced by a {@link ReadFlagsClient} operation. */
type FlagshipEffect<A> = Effect.Effect<A, FlagshipError, RuntimeContext>;

// Re-exported so callers don't reach into the `@cloudflare/workers-types`
// namespace directly.
export type EvaluationContext = cf.FlagshipEvaluationContext;
export type EvaluationDetails<T> = cf.FlagshipEvaluationDetails<T>;

/**
 * Effect-native client for a Cloudflare Flagship (feature flags) binding.
 *
 * Mirrors the runtime {@link cf.Flagship} binding one-to-one, translating each
 * promise-returning method into an Effect. Flagship evaluation never throws —
 * it falls back to the provided `defaultValue` — so the {@link FlagshipError}
 * channel only surfaces unexpected runtime failures (e.g. a misconfigured
 * binding). Use `Cloudflare.Flagship.ReadFlags(app)` inside a Worker's init
 * phase to obtain it.
 */
export interface ReadFlagsClient {
  /**
   * Effect resolving to the raw Cloudflare Flagship runtime binding.
   */
  raw: Effect.Effect<cf.Flagship, never, RuntimeContext>;
  /**
   * Get a flag value without type checking. Use when the flag type is not
   * known at compile time.
   */
  get(
    flagKey: string,
    defaultValue?: unknown,
    context?: EvaluationContext,
  ): FlagshipEffect<unknown>;
  /**
   * Get a boolean flag value, falling back to `defaultValue` when evaluation
   * fails or the flag type does not match.
   */
  getBooleanValue(
    flagKey: string,
    defaultValue: boolean,
    context?: EvaluationContext,
  ): FlagshipEffect<boolean>;
  /**
   * Get a string flag value, falling back to `defaultValue` when evaluation
   * fails or the flag type does not match.
   */
  getStringValue(
    flagKey: string,
    defaultValue: string,
    context?: EvaluationContext,
  ): FlagshipEffect<string>;
  /**
   * Get a number flag value, falling back to `defaultValue` when evaluation
   * fails or the flag type does not match.
   */
  getNumberValue(
    flagKey: string,
    defaultValue: number,
    context?: EvaluationContext,
  ): FlagshipEffect<number>;
  /**
   * Get a typed object flag value, falling back to `defaultValue` when
   * evaluation fails or the flag type does not match.
   */
  getObjectValue<T extends object>(
    flagKey: string,
    defaultValue: T,
    context?: EvaluationContext,
  ): FlagshipEffect<T>;
  /**
   * Get a boolean flag value with full evaluation details (variant, reason,
   * error code).
   */
  getBooleanDetails(
    flagKey: string,
    defaultValue: boolean,
    context?: EvaluationContext,
  ): FlagshipEffect<EvaluationDetails<boolean>>;
  /**
   * Get a string flag value with full evaluation details (variant, reason,
   * error code).
   */
  getStringDetails(
    flagKey: string,
    defaultValue: string,
    context?: EvaluationContext,
  ): FlagshipEffect<EvaluationDetails<string>>;
  /**
   * Get a number flag value with full evaluation details (variant, reason,
   * error code).
   */
  getNumberDetails(
    flagKey: string,
    defaultValue: number,
    context?: EvaluationContext,
  ): FlagshipEffect<EvaluationDetails<number>>;
  /**
   * Get a typed object flag value with full evaluation details (variant,
   * reason, error code).
   */
  getObjectDetails<T extends object>(
    flagKey: string,
    defaultValue: T,
    context?: EvaluationContext,
  ): FlagshipEffect<EvaluationDetails<T>>;
}
