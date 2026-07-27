import type * as cf from "@cloudflare/workers-types";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { MinimumLogLevel } from "effect/References";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as EffectHttp from "effect/unstable/http/HttpEffect";
import {
  makeEntrypointLayer,
  reifyBoundConfigProvider,
} from "../../Runtime.ts";
import { Self } from "../../Self.ts";
import { Stack } from "../../Stack.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import cloudflare_workers from "./cloudflare_workers.ts";
import { isScopeEjected } from "./HttpServer.ts";
import {
  ErrorTag,
  type RpcErrorEnvelope,
  type RpcStreamEnvelope,
  encodeRpcError,
  toRpcStream,
} from "./Rpc.ts";
import {
  ExportedHandlerMethods,
  Worker,
  WorkerEnvironment,
  WorkerExecutionContext,
  deferredExecutionContext,
  fromExecutionContext,
} from "./Worker.ts";
import type { WorkerRuntimeContext } from "./WorkerRuntimeContext.ts";

/**
 * The isolate-lifetime artifacts produced by a single layer build: the built
 * service Context, the resolved export for this entrypoint, and the user's
 * RPC shape (a thunk — the shape is only populated once `serve` has run).
 */
export interface WorkerBuild<Export = any> {
  readonly context: Context.Context<any>;
  readonly export: Export;
  readonly shape: () => Record<string, any>;
}

/**
 * Makes the WorkerEntrypoint class and bridges to Effect fetch and RPC calls.
 */
export const makeWorkerBridge = (
  Base: typeof WorkerEntrypoint | typeof DurableObject,
  {
    stack,
    entrypoint,
  }: {
    stack: {
      name: string;
      stage: string;
    };
    entrypoint: any;
  },
) => {
  const { build } = getWorkerExport({
    entrypoint,
    stack,
    exportName: "default",
  });

  const processEvent = <T>(
    makeEffect: (
      build: WorkerBuild,
    ) => readonly [Effect.Effect<any, any, any>, Context.Context<never>],
    ctx: cf.ExecutionContext,
    onExit: (
      exit: Exit.Exit<any, any>,
      scope: Scope.Closeable,
    ) => T | Promise<T>,
  ): Promise<T> => {
    const scope = Scope.makeUnsafe();
    return build((promise) => ctx.waitUntil(promise as Promise<any>))
      .then(
        (built) => {
          const [eff, services] = makeEffect(built);
          return eff.pipe(
            // Per-event services take precedence over the captured services
            // and the built isolate context: the isolate context carries the
            // *deferred* WorkerExecutionContext (yieldable in the top-level
            // closure), which must be shadowed by the real per-event one
            // here, and the fresh request `Scope` so `Effect.addFinalizer`
            // in a handler attaches to the request scope (closed into
            // `ctx.waitUntil` below).
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(
                  WorkerExecutionContext,
                  fromExecutionContext(ctx),
                ),
                Layer.succeed(Scope.Scope, scope),
              ).pipe(
                Layer.provideMerge(Layer.succeedContext(services)),
                Layer.provideMerge(Layer.succeedContext(built.context)),
              ),
            ),
            Effect.runPromiseExit,
          );
        },
        // A failed isolate build reaches callers as a defect exit so the RPC
        // path can envelope-encode it like any other handler defect.
        (error) => Exit.die(error),
      )
      .then((exit) => onExit(exit, scope))
      .finally(() =>
        isScopeEjected(scope)
          ? undefined
          : Scope.close(scope, Exit.void).pipe(Effect.runPromise, (promise) =>
              ctx.waitUntil(promise),
            ),
      );
  };
  class WorkerBridge extends Base {
    constructor(
      public readonly ctx: any,
      public readonly env: any,
    ) {
      super(ctx, env);

      for (const methodName of ExportedHandlerMethods) {
        (this as any)[methodName] = async (input: any) =>
          processEvent(
            (built) =>
              built.export[methodName](input, this.env, this.ctx) as [
                Effect.Effect<any>,
                Context.Context<never>,
              ],
            this.ctx,
            (exit) =>
              exit._tag === "Success"
                ? Promise.resolve(exit.value)
                : Promise.reject(Cause.squash(exit.cause)),
          );
      }

      return new Proxy(this, {
        get: (target, prop) => {
          if (typeof prop !== "string") return (target as any)[prop];
          if (prop in target) return (target as any)[prop];
          return (...args: unknown[]) =>
            processEvent(
              (built) => {
                const dispatcher = built.shape()?.[prop];
                if (typeof dispatcher !== "function") {
                  return [
                    Effect.die(
                      new Error(
                        `Method "${prop}" not found on worker. ` +
                          `Make sure it's returned from the worker's default export.`,
                      ),
                    ),
                    Context.empty(),
                  ] as const;
                }
                const result = dispatcher(...args);
                // Effects (including nested-RPC values built by
                // `asEffectOrStream`, which are Effects *branded* as Streams)
                // must be run as effects — their resolved value may itself be
                // a `Stream`, which `handleRpcExit` then encodes. Only a
                // *genuine* `Stream` (not an Effect) is lifted into the
                // success channel so `handleRpcExit` encodes it directly.
                return [
                  Effect.isEffect(result)
                    ? (result as Effect.Effect<any>)
                    : Stream.isStream(result)
                      ? Effect.succeed(result)
                      : (result as Effect.Effect<any>),
                  Context.empty(),
                ] as const;
              },
              this.ctx,
              handleRpcExit,
            );
        },
      });
    }
  }

  // Stub prototype methods so Cloudflare's script-validate detects the
  // standard handler set; per-instance overrides above are what actually
  // run.
  for (const method of ExportedHandlerMethods) {
    Object.defineProperty(WorkerBridge.prototype, method, {
      value: function () {
        throw new Error(
          `Bridge method '${method}' was called before instance setup`,
        );
      },
      writable: true,
      configurable: true,
    });
  }

  return WorkerBridge;
};

/**
 * One isolate-lifetime layer build per entrypoint module. The generated
 * entry passes the same `meta.entrypoint` object to `makeWorkerBridge`,
 * `makeDurableObjectBridge`, and `makeWorkflowBridge`, so keying on it
 * shares a single build (one run of the user's init closure) across the
 * default worker and every Durable Object / Workflow class in the isolate.
 */
const sharedBuilds = new WeakMap<
  object,
  (pin: (promise: Promise<unknown>) => unknown) => Promise<Context.Context<any>>
>();

const getSharedBuild = (
  entrypoint: any,
  stack: { name: string; stage: string },
) => {
  let shared = sharedBuilds.get(entrypoint);
  if (shared !== undefined) {
    return shared;
  }

  const tag = Self as any as Context.Service<
    never,
    Worker & {
      RuntimeContext: WorkerRuntimeContext;
    }
  >;

  const layer = makeEntrypointLayer(tag, entrypoint);

  const platform = Layer.mergeAll(
    NodeServices.layer,
    FetchHttpClient.layer,
    // TODO(sam): wire this up to telemetry more directly
    Logger.layer([Logger.consolePretty()]),
  );

  // Private scope for the isolate-lifetime layer build. Never closed —
  // workerd has no isolate-teardown hook, so finalizers attached here can
  // never run. It exists only because `Layer.buildWithMemoMap` requires a
  // scope argument (`Layer.scoped`-style layers attach their finalizers to
  // it). It is deliberately NOT provided as the ambient `Scope.Scope` of the
  // init context: request-coupled resources are acquired inside handlers
  // against the per-event scope that `processEvent` provides.
  const instanceScope = Scope.makeUnsafe();
  const memoMap = Layer.makeMemoMapUnsafe();

  const globalContext = Layer.unwrap(
    cloudflare_workers.pipe(
      Effect.map(({ env }) =>
        layer.pipe(
          Layer.provideMerge(
            Layer.succeed(Stack, {
              name: stack.name,
              stage: stack.stage,
              bindings: {},
              resources: {},
              actions: {},
            }),
          ),
          Layer.provideMerge(platform),
          Layer.provideMerge(
            Layer.succeed(
              ConfigProvider.ConfigProvider,
              ConfigProvider.orElse(
                ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
                // Auto-bound `Config` values arrive in `env` as
                // `{"_tag":"Redacted","value":...}` markers; reify them so a
                // `Config` re-read inside a request handler decodes the raw
                // source value instead of the marker JSON.
                reifyBoundConfigProvider(
                  ConfigProvider.fromUnknown(env),
                  env as Record<string, unknown>,
                ),
              ),
            ),
          ),
          Layer.provideMerge(Layer.succeed(WorkerEnvironment, env)),
          // Init-phase ExecutionContext: yieldable from the Worker's
          // top-level closure (and Layers); its RuntimeContext-colored
          // methods defer to the real per-event context provided by
          // `processEvent`.
          Layer.provideMerge(
            Layer.succeed(WorkerExecutionContext, deferredExecutionContext),
          ),
          Layer.provideMerge(
            Layer.succeed(
              CloudflareEnvironment,
              // TODO(sam): fix this with maybe a CloudflareAccountId Effect service
              // @ts-expect-error - this is hacky, but we only need and have this property
              Effect.succeed({
                account: (env as any).ALCHEMY_CLOUDFLARE_ACCOUNT_ID,
              }),
            ),
          ),
          Layer.provideMerge(
            Layer.succeed(
              MinimumLogLevel,
              (env as any).DEBUG ? "Debug" : "Info",
            ),
          ),
        ),
      ),
    ),
  );

  let built: Promise<Context.Context<any>> | undefined;

  /**
   * Build the isolate-lifetime layer stack exactly once; every subsequent
   * event (and every export sharing this entrypoint) reuses the memoized
   * Context.
   *
   * `pin` registers the in-flight build promise with the calling event
   * (`ctx.waitUntil` / `state.waitUntil`). Every awaiting event must pin:
   * workerd schedules a promise's continuations back into its origin request
   * context and *drops* them if that context has ended
   * (`handle_cross_request_promise_resolution`), so the origin event must be
   * kept alive until the build settles or concurrent cold-start requests
   * would hang.
   *
   * Only success is memoized — a transient init failure (e.g. a flaky
   * `Config` read in user init) resets the memo and heals on the next event.
   */
  shared = (pin) => {
    const promise = (built ??= Effect.runPromise(
      Layer.buildWithMemoMap(globalContext, memoMap, instanceScope).pipe(
        // Strip the build's memo map from the exposed context so a Layer the
        // user `Effect.provide`s *inside a handler* builds per event instead
        // of sharing one instance (pinned to the first request's IoContext)
        // across concurrent events.
        Effect.map(Context.omit(Layer.CurrentMemoMap)),
      ),
    ).catch((error) => {
      built = undefined;
      throw error;
    }));
    pin(promise.catch(() => {}));
    return promise;
  };
  sharedBuilds.set(entrypoint, shared);
  return shared;
};

export const getWorkerExport = <Export = any>({
  entrypoint,
  stack,
  exportName,
}: {
  entrypoint: any;
  stack: { name: string; stage: string };
  exportName: string;
}) => {
  const tag = Self as any as Context.Service<
    never,
    Worker & {
      RuntimeContext: WorkerRuntimeContext;
    }
  >;

  const runtimeContext = tag.pipe(Effect.map((func) => func.RuntimeContext));
  const exported = runtimeContext.pipe(
    Effect.flatMap((context) => context.exports),
    Effect.flatMap((exports) =>
      Effect.isEffect(exports[exportName])
        ? exports[exportName]
        : Effect.succeed(exports[exportName]),
    ),
  ) as Effect.Effect<Export>;

  const sharedBuild = getSharedBuild(entrypoint, stack);

  let built: Promise<WorkerBuild<Export>> | undefined;

  /**
   * Resolve this export against the shared isolate build; memoized so
   * listener assembly and the captured services context resolve once per
   * export. Same success-only memoization contract as the shared build.
   */
  const build = (
    pin: (promise: Promise<unknown>) => unknown,
  ): Promise<WorkerBuild<Export>> => {
    const promise = (built ??= sharedBuild(pin)
      .then((context) =>
        Effect.runPromise(
          Effect.all([exported, runtimeContext]).pipe(
            Effect.map(
              ([exp, rc]): WorkerBuild<Export> => ({
                context,
                export: exp,
                shape: rc.shape,
              }),
            ),
            Effect.provideContext(context),
          ),
        ),
      )
      .catch((error) => {
        built = undefined;
        throw error;
      }));
    pin(promise.catch(() => {}));
    return promise;
  };

  return { build };
};

export const makeRpcProxy = (
  self: any,
  userShape: Effect.Effect<any>,
  processEvent: (
    eff: Effect.Effect<[Effect.Effect<any>, Context.Context<never>]>,
  ) => Promise<any>,
) =>
  new Proxy(self, {
    get: (target, prop) => {
      if (typeof prop !== "string") return (target as any)[prop];
      if (prop in target) return (target as any)[prop];
      return (...args: unknown[]) =>
        userShape
          .pipe(
            Effect.map((shape) => shape[prop]),
            Effect.flatMap((dispatcher) => {
              if (typeof dispatcher !== "function") {
                return Effect.die(
                  new Error(
                    `Method "${prop}" not found on worker. ` +
                      `Make sure it's returned from the worker's default export.`,
                  ),
                );
              }
              const result = dispatcher(...args);
              // Effects (including nested-RPC values built by
              // `asEffectOrStream`, which are Effects *branded* as Streams)
              // must be run as effects — their resolved value may itself be a
              // `Stream`, which `handleRpcExit` then encodes. Only a *genuine*
              // `Stream` (not an Effect) is lifted into the success channel so
              // `handleRpcExit` encodes it directly.
              return Effect.isEffect(result)
                ? (result as Effect.Effect<any>)
                : Stream.isStream(result)
                  ? Effect.succeed(result)
                  : (result as Effect.Effect<any>);
            }),
            processEvent,
          )
          .then((exit) => handleRpcExit(exit));
    },
  });

export const handleRpcExit = async (
  exit: Exit.Exit<any, any>,
  scope?: Scope.Closeable,
) => {
  if (exit._tag === "Success") {
    if (Stream.isStream(exit.value)) {
      let stream = exit.value as Stream.Stream<any, any, any>;
      if (scope !== undefined && !isScopeEjected(scope)) {
        // The RPC transport drains the encoded ReadableStream *after* this
        // function returns, so the request scope must outlive the handler:
        // eject it from the bridge's close-on-return path and close it when
        // the stream settles instead — mirroring `scopeTransferToStream` on
        // the fetch path.
        EffectHttp.scopeDisableClose(scope);
        stream = stream.pipe(
          Stream.onExit((streamExit) => Scope.close(scope, streamExit)),
        );
      }
      return await Effect.runPromise(
        toRpcStream(stream) as Effect.Effect<RpcStreamEnvelope>,
      );
    }
    return exit.value;
  }
  const failReason = exit.cause.reasons.find(Cause.isFailReason);
  if (failReason) {
    return {
      _tag: ErrorTag,
      error: encodeRpcError(failReason.error),
    } satisfies RpcErrorEnvelope;
  }
  const dieReason = exit.cause.reasons.find(Cause.isDieReason);
  throw (
    dieReason?.defect ?? new Error("RPC method failed with an unexpected cause")
  );
};
