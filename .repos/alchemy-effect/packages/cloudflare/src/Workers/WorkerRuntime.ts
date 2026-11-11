import type * as cf from "@cloudflare/workers-types";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { fromCloudflareFetcher, type Fetcher } from "../Fetcher.ts";
import { resolveAccessContext, type WorkerExecutionContextAccess } from "./WorkerAccess.ts";

export const WorkerTypeId = "Cloudflare.Worker";
export type WorkerTypeId = typeof WorkerTypeId;

export class WorkerEnvironment extends Context.Service<WorkerEnvironment, Record<string, any>>()(
  "Cloudflare.Workers.WorkerEnvironment",
) {}

export class CachePurgeError extends Data.TaggedError("CachePurgeError")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * Effect-native view of the Workers Cache runtime API on the execution
 * context (`ctx.cache`). Only available when the Worker has Workers Cache
 * enabled (the `cache` prop or `yield* Cloudflare.cache()`).
 */
export interface WorkerExecutionContextCache {
  /**
   * Purge cached responses by `Cache-Tag`, path prefix, or everything.
   */
  purge(
    options: cf.CachePurgeOptions,
  ): Effect.Effect<cf.CachePurgeResult, CachePurgeError, RuntimeContext>;
}

/**
 * Raised by `ctx.exports.Name(...)` when this Worker has no loopback for the named
 * entrypoint: the name is not an entrypoint exported by the Worker's main
 * module, or `ctx.exports` is unavailable (the `disable_ctx_exports`
 * compatibility flag).
 */
export class EntrypointUnavailableError extends Data.TaggedError("EntrypointUnavailableError")<{
  message: string;
  entrypoint: string;
}> {}

/**
 * Options for minting a loopback stub to one of this Worker's own
 * entrypoints. See {@link WorkerExecutionContext} `exports`.
 */
export interface EntrypointOptions {
  /**
   * Properties the target entrypoint reads from `ctx.props` — via
   * `WorkerExecutionContext.props` in an Effect Worker. Must be
   * structured-cloneable.
   */
  props?: Record<string, unknown>;
}

/**
 * Mint a {@link Fetcher} for an entrypoint of this Worker from workerd's
 * `exports` loopback (`ctx.exports[name]({ props })`), shared by
 * {@link WorkerExecutionContext} and `DurableObjectState`.
 * @internal
 */
export const getLoopbackEntrypoint = (
  exports: cf.ExecutionContext["exports"] | undefined,
  name = "default",
  options?: EntrypointOptions,
): Effect.Effect<Fetcher, EntrypointUnavailableError> =>
  Effect.suspend(() => {
    const loopback = (exports as Record<string, unknown> | undefined)?.[name];
    if (typeof loopback !== "function") {
      return Effect.fail(
        new EntrypointUnavailableError({
          entrypoint: name,
          message:
            exports === undefined
              ? `ctx.exports is not available, so entrypoint "${name}" cannot be ` +
                "minted — remove the `disable_ctx_exports` compatibility flag."
              : `"${name}" is not a WorkerEntrypoint exported by this Worker's main module.`,
        }),
      );
    }
    return Effect.succeed(
      fromCloudflareFetcher(
        (loopback as (opts: { props?: Record<string, unknown> }) => cf.Fetcher)({
          props: options?.props ?? {},
        }),
      ),
    );
  });

/**
 * This Worker's own entrypoints, by export name (`default` for the Worker's
 * own Effect handlers): the Effect view of workerd's `ctx.exports`. Calling
 * one mints a stub that delivers `props` as the target's `ctx.props`.
 */
export type EntrypointExports = {
  readonly [name: string]: (
    options?: EntrypointOptions,
  ) => Effect.Effect<Fetcher, EntrypointUnavailableError, RuntimeContext>;
};

/**
 * Build {@link EntrypointExports} over a lookup of workerd's `exports`
 * (resolved when an entry is called, not when it is read).
 * @internal
 */
export const makeEntrypointExports = (
  call: (
    name: string,
    options?: EntrypointOptions,
  ) => Effect.Effect<Fetcher, EntrypointUnavailableError, RuntimeContext>,
): EntrypointExports =>
  new Proxy({} as EntrypointExports, {
    get: (_, name) =>
      typeof name === "string" ? (options?: EntrypointOptions) => call(name, options) : undefined,
  });

/**
 * The shape of {@link WorkerExecutionContext}.
 */
export interface WorkerExecutionContextService {
  /**
   * Run an Effect in the background without blocking the response, keeping
   * the Worker alive until it settles. The Effect runs with the caller's
   * full context (services, tracing), and the resulting promise is
   * registered with workerd's `ctx.waitUntil`.
   *
   * `Cloudflare.waitUntil` is shorthand that skips yielding the context
   * first:
   *
   * ```typescript
   * yield* Cloudflare.waitUntil(writeAuditLog(event));
   * // same as
   * yield* (yield* Cloudflare.WorkerExecutionContext).waitUntil(writeAuditLog(event));
   * ```
   */
  waitUntil<A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<void, never, R | RuntimeContext>;
  /**
   * Forward the request to the origin if the Worker throws an unhandled
   * exception, instead of returning an error page.
   */
  passThroughOnException(): Effect.Effect<void, never, RuntimeContext>;
  /**
   * The Workers Cache runtime API (`ctx.cache`).
   */
  readonly cache: WorkerExecutionContextCache;
  /**
   * The Cloudflare Access context for the current request (`ctx.access`),
   * or `undefined` when the request did not pass through Access. Under
   * `alchemy dev` the Worker's `dev.access` config simulates it.
   */
  readonly access: Effect.Effect<WorkerExecutionContextAccess | undefined, never, RuntimeContext>;
  /**
   * The properties this invocation was called with (`ctx.props`): the
   * `props` of the service binding or loopback stub the caller went
   * through, e.g. `Cloudflare.WorkerEntrypoint(worker, { props })` or
   * {@link exports}. An empty object for an external request.
   */
  readonly props: Effect.Effect<Record<string, unknown>, never, RuntimeContext>;
  /**
   * This Worker's own entrypoints (workerd's `ctx.exports`):
   * `yield* ctx.exports.default({ props })` mints a stub to the Worker's
   * own Effect handlers that delivers `props` as the target's `ctx.props`;
   * `ctx.exports.Name(...)` targets a named `WorkerEntrypoint`. The
   * {@link Fetcher} can be passed to APIs that route traffic to a Worker
   * entrypoint, such as a container's `interceptOutboundHttps` or a
   * dynamic Worker's `globalOutbound`; its `raw` is the native `Fetcher`.
   */
  readonly exports: EntrypointExports;
  /**
   * The raw workerd ExecutionContext, for interop with async APIs.
   */
  readonly raw: cf.ExecutionContext;
}

/**
 * The workerd `ExecutionContext` of the current event.
 *
 * A `Context.Reference`: the Worker's init phase (plan and runtime module
 * init) never stores it, so yielding it there returns
 * {@link deferredExecutionContext}, whose methods resolve the live per-event
 * context when run inside a handler. Because init never stores the key, a
 * context captured at init (e.g. by `HttpApiBuilder.group`, which re-provides
 * its build-time context over each handler) can't shadow the per-event one
 * the bridge provides.
 */
export const WorkerExecutionContext = Context.Reference<WorkerExecutionContextService>(
  "Cloudflare.Workers.WorkerExecutionContext",
  { defaultValue: () => deferredExecutionContext },
);
export type WorkerExecutionContext = typeof WorkerExecutionContext;

export const fromExecutionContext = (
  ctx: cf.ExecutionContext,
  env?: Record<string, unknown>,
): WorkerExecutionContextService => ({
  raw: ctx,
  access: Effect.sync(() => resolveAccessContext(ctx, env)),
  props: Effect.sync(() => (ctx.props as Record<string, unknown> | undefined) ?? {}),
  exports: makeEntrypointExports((name, options) =>
    getLoopbackEntrypoint(ctx.exports, name, options),
  ),
  waitUntil: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<R>();
      // Register the promise with workerd un-awaited — waitUntil extends the
      // invocation's lifetime without blocking the response.
      yield* Effect.sync(() => ctx.waitUntil(Effect.runPromiseWith(context)(effect)));
    }),
  passThroughOnException: () => Effect.sync(() => ctx.passThroughOnException()),
  cache: {
    purge: (options) =>
      ctx.cache
        ? Effect.tryPromise({
            try: () => ctx.cache!.purge(options),
            catch: (cause) =>
              new CachePurgeError({
                message: cause instanceof Error ? cause.message : "Unknown cache purge error",
                cause,
              }),
          })
        : Effect.fail(
            new CachePurgeError({
              message:
                "ctx.cache is not available — enable Workers Cache on this " +
                "Worker (the `cache` prop or `yield* Cloudflare.cache()`) " +
                "and note it is not supported in local dev.",
            }),
          ),
  },
});

/**
 * A {@link WorkerExecutionContext} whose methods resolve the live per-event
 * context from the calling fiber at call time. The reference's default, so
 * the service can be yielded and closed over in the Worker's top-level
 * closure; every method is colored with
 * `RuntimeContext`, so it can only be *run* inside a handler, where the
 * bridge provides the real per-event context that these methods defer to.
 */
export const deferredExecutionContext: WorkerExecutionContextService = {
  get raw(): cf.ExecutionContext {
    throw new Error("WorkerExecutionContext.raw is only available inside a request handler");
  },
  waitUntil: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    liveExecutionContext.pipe(Effect.flatMap((live) => live.waitUntil(effect))) as Effect.Effect<
      void,
      never,
      R | RuntimeContext
    >,
  passThroughOnException: () =>
    liveExecutionContext.pipe(
      Effect.flatMap((live) => live.passThroughOnException()),
    ) as Effect.Effect<void, never, RuntimeContext>,
  cache: {
    purge: (options) =>
      liveExecutionContext.pipe(
        Effect.flatMap((live) => live.cache.purge(options)),
      ) as Effect.Effect<cf.CachePurgeResult, CachePurgeError, RuntimeContext>,
  },
  exports: makeEntrypointExports(
    (name, options) =>
      liveExecutionContext.pipe(
        Effect.flatMap((live) => live.exports[name](options)),
      ) as Effect.Effect<Fetcher, EntrypointUnavailableError, RuntimeContext>,
  ),
  get props() {
    return liveExecutionContext.pipe(Effect.flatMap((live) => live.props)) as Effect.Effect<
      Record<string, unknown>,
      never,
      RuntimeContext
    >;
  },
  // A getter so this module-level literal doesn't eagerly reference
  // `liveExecutionContext` before its declaration below.
  get access() {
    return liveExecutionContext.pipe(Effect.flatMap((live) => live.access)) as Effect.Effect<
      WorkerExecutionContextAccess | undefined,
      never,
      RuntimeContext
    >;
  },
};

const liveExecutionContext = WorkerExecutionContext.pipe(
  Effect.flatMap((live) =>
    live === deferredExecutionContext
      ? Effect.die(new Error("WorkerExecutionContext can only be used inside a request handler"))
      : Effect.succeed(live),
  ),
);

/**
 * Run an Effect in the background without blocking the response, keeping the
 * Worker alive until it settles. Shorthand for
 * `(yield* WorkerExecutionContext).waitUntil(effect)`.
 *
 * @example
 * ```typescript
 * fetch: Effect.gen(function* () {
 *   yield* Cloudflare.waitUntil(writeAuditLog(event));
 *   return HttpServerResponse.text("accepted", { status: 202 });
 * }),
 * ```
 */
export const waitUntil = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, R | RuntimeContext> =>
  WorkerExecutionContext.pipe(Effect.flatMap((ctx) => ctx.waitUntil(effect)));

export type WorkerEvent = Exclude<
  {
    [type in keyof cf.ExportedHandler]: {
      kind: "Cloudflare.Workers.WorkerEvent";
      type: type;
      input: Parameters<Exclude<cf.ExportedHandler[type], undefined>>[0];
      env: Parameters<Exclude<cf.ExportedHandler[type], undefined>>[1];
      context: Parameters<Exclude<cf.ExportedHandler[type], undefined>>[2];
    };
  }[keyof cf.ExportedHandler],
  undefined
>;

export const isWorkerEvent = (value: any): value is WorkerEvent =>
  value?.kind === "Cloudflare.Workers.WorkerEvent";

export const ExportedHandlerMethods = [
  "fetch",
  "tail",
  "trace",
  "tailStream",
  "scheduled",
  "test",
  "email",
  "queue",
] as const satisfies (keyof cf.ExportedHandler)[];
