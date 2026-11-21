// @effect-diagnostics anyUnknownInErrorContext:off - Preserve the generic HTTP contracts at the runtime handler registry boundary.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { builtinService } from "@t3tools/shared/pluginKernel";

/** Routes retain stable request Effects while the same public service API changes their implementation. */
export const builtinHttpRoute =
  (pluginId: string): typeof HttpRouter.add =>
  (method, path, handler, options) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const operation =
          typeof handler === "function"
            ? Effect.flatMap(HttpServerRequest.HttpServerRequest, handler)
            : Effect.isEffect(handler)
              ? handler
              : Effect.succeed(handler);
        const live = yield* builtinService(
          pluginId,
          `t3/http/${method}/${String(path)}`,
          Effect.succeed(operation),
        );
        return HttpRouter.add(method, path, live, options);
      }),
    );

interface RouteService {
  readonly routes: readonly HttpRouter.Route<unknown, unknown>[];
}
const routeService = (value: unknown): value is RouteService =>
  typeof value === "object" && value !== null && "routes" in value && Array.isArray(value.routes);

/** Register the generated request handler, after decoding and auth middleware are assembled. */
export const builtinHttpApiGroup = (pluginId: string): typeof HttpApiBuilder.group => {
  const build = (...args: readonly unknown[]) => {
    const source = Reflect.apply(HttpApiBuilder.group, undefined, args) as Layer.Layer<
      unknown,
      unknown,
      unknown
    >;
    return Layer.effectContext(
      Effect.gen(function* () {
        const context = yield* Layer.build(source);
        const services = new Map(context.mapUnsafe);
        for (const [key, service] of services)
          if (routeService(service)) {
            const routes = yield* Effect.forEach(service.routes, (route) =>
              builtinService(
                pluginId,
                `t3/http/${route.method}/${String(route.path)}`,
                Effect.succeed(route.handler),
              ).pipe(Effect.map((handler) => ({ ...route, handler }))),
            );
            services.set(key, { ...service, routes });
          }
        return Context.makeUnsafe<unknown>(services);
      }),
    );
  };
  return build as typeof HttpApiBuilder.group;
};
