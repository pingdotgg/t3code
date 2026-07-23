import type * as cf from "@cloudflare/workers-types";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { MinimumLogLevel } from "effect/References";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { ExecutionContext } from "../../ExecutionContext.ts";
import { makeEntrypointLayer } from "../../Runtime.ts";
import { Self } from "../../Self.ts";
import { Stack } from "../../Stack.ts";
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
} from "./Worker.ts";
import type { WorkerRuntimeContext } from "./WorkerRuntimeContext.ts";

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
  const { globalContext, exported, shape } = getWorkerExport({
    entrypoint,
    stack,
    exportName: "default",
  });

  const processEvent = (
    eff: Effect.Effect<
      readonly [Effect.Effect<any, any, any>, Context.Context<never>],
      any,
      any
    >,
    ctx: cf.ExecutionContext,
  ) => {
    const scope = Scope.makeUnsafe();
    return eff
      .pipe(
        Effect.flatMap(([eff, context]) =>
          Effect.provide(
            eff,
            pipe(
              Layer.succeedContext(context),
              Layer.provideMerge(Layer.succeedContext(context)),
              Layer.provideMerge(Layer.succeed(WorkerExecutionContext, ctx)),
              Layer.provideMerge(
                Layer.succeed(ExecutionContext, {
                  scope,
                  cache: {},
                }),
              ),
            ),
          ),
        ),
        Effect.provide(
          Layer.provideMerge(globalContext, Layer.succeed(Scope.Scope, scope)),
        ),
        Effect.runPromiseExit,
      )
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
          exported
            .pipe(
              Effect.map((_default) => _default[methodName]),
              Effect.map(
                (f) =>
                  f(input, this.env, this.ctx) as [
                    Effect.Effect<any>,
                    Context.Context<never>,
                  ],
              ),
              (eff) => processEvent(eff, this.ctx),
            )
            .then((exit) =>
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
            shape
              .pipe(
                Effect.map((shape: any) => shape[prop]),
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
                  // A streaming RPC method returns a `Stream` directly rather
                  // than an `Effect`. Lift it into the success channel so the
                  // inner effect resolves to the `Stream` and `handleRpcExit`
                  // can encode it as a stream envelope. Anything else is the
                  // `Effect` it claims to be (its resolved value may itself be
                  // a `Stream`, which `handleRpcExit` also handles).
                  return Effect.succeed([
                    Stream.isStream(result)
                      ? Effect.succeed(result)
                      : (result as Effect.Effect<any>),
                    Context.empty(),
                  ] as const);
                }),
                (eff) => processEvent(eff, this.ctx),
              )
              .then(handleRpcExit);
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
  const shape = runtimeContext.pipe(Effect.map((context) => context.shape()));
  const exported = runtimeContext.pipe(
    Effect.flatMap((context) => context.exports),
    Effect.flatMap((exports) =>
      Effect.isEffect(exports[exportName])
        ? exports[exportName]
        : Effect.succeed(exports[exportName]),
    ),
  ) as Effect.Effect<Export>;

  const layer = makeEntrypointLayer(tag, entrypoint);

  const platform = Layer.mergeAll(
    NodeServices.layer,
    FetchHttpClient.layer,
    // TODO(sam): wire this up to telemetry more directly
    Logger.layer([Logger.consolePretty()]),
  );

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
                ConfigProvider.fromUnknown(env),
              ),
            ),
          ),
          Layer.provideMerge(Layer.succeed(WorkerEnvironment, env)),
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

  return {
    globalContext,
    exported,
    shape,
  };
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
              // A streaming RPC method returns a `Stream` directly rather than
              // an `Effect`. Lift it into the success channel so the resulting
              // `Exit.value` is the `Stream` and `handleRpcExit` can encode it
              // as a stream envelope. Anything else is the `Effect` it claims
              // to be and is run normally (its resolved value may itself be a
              // `Stream`, which `handleRpcExit` also handles).
              return Stream.isStream(result)
                ? Effect.succeed(result)
                : (result as Effect.Effect<any>);
            }),
            processEvent,
          )
          .then(handleRpcExit);
    },
  });

export const handleRpcExit = async (exit: Exit.Exit<any, any>) => {
  if (exit._tag === "Success") {
    if (Stream.isStream(exit.value)) {
      return await Effect.runPromise(
        toRpcStream(exit.value) as Effect.Effect<RpcStreamEnvelope>,
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
