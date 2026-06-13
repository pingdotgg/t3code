import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
 * Context of the runtime environment.
 *
 * E.g. the context of a running Worker, Task, Process, Function
 */
export class RuntimeContext extends Context.Service<
  RuntimeContext,
  BaseRuntimeContext
>()("RuntimeContext") {}

export const CurrentRuntimeContext = Effect.serviceOption(RuntimeContext).pipe(
  Effect.map(Option.getOrUndefined),
);
