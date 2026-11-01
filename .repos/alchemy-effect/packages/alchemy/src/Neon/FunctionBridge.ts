import * as NodeServices from "@effect/platform-node/NodeServices";
import { waitUntil as nativeWaitUntil } from "@neon/functions";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as EffectHttp from "effect/http/HttpEffect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { safeHttpEffect } from "../Http.ts";
import { makeEntrypointLayer, reifyBoundConfigProvider } from "../Runtime.ts";
import { RuntimeContext } from "../RuntimeContext.ts";
import { Self } from "../Self.ts";
import { StackContext } from "../StackContext.ts";
import { FunctionEnvironment, FunctionRequest } from "./FunctionEnvironment.ts";
import type { FunctionRuntimeContext } from "./FunctionRuntimeContext.ts";
import { FunctionUpgradeSockets } from "./FunctionUpgrade.ts";

const closeRequestScope = (scope: Scope.Closeable) => {
  nativeWaitUntil(
    Effect.runPromise(
      Scope.close(scope, Exit.void).pipe(
        Effect.timeout("15 seconds"),
        Effect.ignoreCause({ log: "Error" }),
      ),
    ),
  );
};

/** Build a Node-only Fetch bridge once per process, with a fresh scope for every request. */
export const makeFunctionBridge = (entrypoint: unknown) => {
  const instanceScope = Scope.makeUnsafe();
  const tag = Self as unknown as Context.Service<
    never,
    { RuntimeContext: FunctionRuntimeContext }
  >;
  const platform = Layer.mergeAll(
    NodeServices.layer,
    FetchHttpClient.layer,
    Layer.succeed(FunctionEnvironment, process.env),
    Layer.succeed(
      ConfigProvider.ConfigProvider,
      reifyBoundConfigProvider(
        ConfigProvider.orElse(
          ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
          ConfigProvider.fromEnv(),
        ),
        process.env,
      ),
    ),
    Layer.succeed(StackContext, {
      name: process.env.ALCHEMY_STACK_NAME ?? "NeonFunction",
      stage: process.env.ALCHEMY_STAGE ?? "runtime",
      bindings: {},
      resources: {},
      actions: {},
    }),
  );
  const build = Layer.buildWithScope(
    makeEntrypointLayer(tag, entrypoint).pipe(Layer.provideMerge(platform)),
    instanceScope,
  ).pipe(
    Effect.flatMap((context) =>
      tag.pipe(
        Effect.flatMap((host) =>
          host.RuntimeContext.handler.pipe(
            Effect.map((handler) => ({
              ...handler,
              runtime: host.RuntimeContext,
              built: context,
            })),
          ),
        ),
        Effect.provideContext(context),
      ),
    ),
    Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? Infinity : 0)),
    Effect.runSync,
  );
  const close = Scope.close(instanceScope, Exit.void).pipe(
    Effect.timeout("4 seconds"),
    Effect.ignoreCause({ log: "Error" }),
  );
  process.once("SIGINT", () => {
    Effect.runFork(close);
  });

  return {
    fetch: (request: Request) =>
      Effect.gen(function* () {
        const built = yield* build;
        const response = yield* Deferred.make<Response>();
        const services = Context.mergeAll(
          built.built,
          built.context,
          Context.make(RuntimeContext, built.runtime),
          Context.make(FunctionRequest, request),
          Context.make(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(request),
          ),
        );
        const handler = safeHttpEffect(
          built.dispatch(new URL(request.url).pathname),
        ).pipe(Effect.interruptible);
        return yield* EffectHttp.toHandled(handler, (req, res) =>
          Effect.gen(function* () {
            const scope = yield* Effect.scope;
            const context = yield* Effect.context<never>();
            if (res.body._tag === "Raw" && res.body.body instanceof Response) {
              // Neon attaches upgrade metadata to this exact object.
              const socket = FunctionUpgradeSockets.get(res.body.body);
              if (socket && socket.readyState !== socket.CLOSED) {
                EffectHttp.scopeDisableClose(scope);
                const onClose = () =>
                  closeRequestScope(scope as Scope.Closeable);
                socket.addEventListener("close", onClose, { once: true });
                request.signal.addEventListener("abort", onClose, {
                  once: true,
                });
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    socket.removeEventListener("close", onClose);
                    request.signal.removeEventListener("abort", onClose);
                  }),
                );
                if (request.signal.aborted) onClose();
              }
              yield* Deferred.succeed(response, res.body.body);
              return;
            }
            const withoutBody = req.method === "HEAD";
            const transferred = HttpServerResponse.omitsBody(res, withoutBody)
              ? res
              : EffectHttp.scopeTransferToStream(res);
            const web = HttpServerResponse.toWeb(transferred, {
              withoutBody,
              context,
            });
            // The body outlives fetch; propagate actual request aborts to its producer.
            yield* Deferred.succeed(
              response,
              res.body._tag === "Stream" && web.body
                ? new Response(
                    web.body.pipeThrough(
                      new TransformStream<Uint8Array, Uint8Array>(),
                      {
                        signal: request.signal,
                      },
                    ),
                    {
                      status: web.status,
                      statusText: web.statusText,
                      headers: web.headers,
                    },
                  )
                : web,
            );
          }),
        ).pipe(
          Effect.andThen(Deferred.await(response)),
          Effect.provideContext(services),
        );
      }).pipe((effect) =>
        Effect.runPromise(effect, { signal: request.signal }),
      ),
  };
};
