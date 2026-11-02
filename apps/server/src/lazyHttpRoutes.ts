import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HttpRouter, HttpServerError, HttpServerRequest } from "effect/http";

export const lazyHttpRoutes = <A, E, R>(
  path: HttpRouter.PathInput,
  load: Effect.Effect<Layer.Layer<A, E, R>>,
) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<
        Exclude<HttpRouter.Request.Without<R>, HttpRouter.HttpRouter> | Scope.Scope
      >();
      // Initialization belongs to the server scope; request services stay on each invocation.
      const initialize = yield* Effect.cached(
        load.pipe(
          Effect.flatMap((routes) =>
            Layer.buildWithMemoMap(
              Layer.provideMerge(routes, HttpRouter.layer),
              Layer.makeMemoMapUnsafe(),
              Context.get(context, Scope.Scope),
            ),
          ),
          Effect.map((services) =>
            Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
              // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- HttpRouter exposes unknown failures; normalize them at the HTTP boundary.
              Context.get(services, HttpRouter.HttpRouter)
                .asHttpEffect()
                .pipe(
                  Effect.mapError((cause) =>
                    HttpServerError.isHttpServerError(cause)
                      ? cause
                      : new HttpServerError.HttpServerError({
                          reason: new HttpServerError.InternalError({ request, cause }),
                        }),
                  ),
                  Effect.provideContext(services),
                ),
            ),
          ),
          Effect.provideContext(context),
          Effect.forkIn(Context.get(context, Scope.Scope)),
        ),
      );
      yield* router.add(
        "*",
        path,
        initialize.pipe(
          Effect.flatMap(Fiber.join),
          Effect.flatMap((handler) => handler),
        ),
      );
    }),
  );
