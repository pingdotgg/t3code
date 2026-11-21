import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { authenticateRawRouteWithScope } from "../http.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { PluginService } from "./PluginService.ts";

/** Generation-scoped bearer paths support ESM imports from remote and desktop clients. */
export const pluginAssetRouteLayer = HttpRouter.add(
  "GET",
  "/api/plugins/assets/*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.empty({ status: 400 });
    const parsed = yield* Effect.try({
      try: () =>
        url.value.pathname.slice("/api/plugins/assets/".length).split("/").map(decodeURIComponent),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => []));
    const [id, rawRevision, token, ...path] = parsed;
    if (!id || !rawRevision || !token || !path.length || !/^\d+$/.test(rawRevision))
      return HttpServerResponse.empty({ status: 404 });
    const plugins = yield* PluginService;
    const file = yield* plugins.resolveAsset(id, Number(rawRevision), token, path.join("/"));
    if (!file) return HttpServerResponse.empty({ status: 404 });
    return yield* HttpServerResponse.file(file, {
      headers: {
        "cache-control": "private, no-cache",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        ...(file.endsWith(".mjs") || file.endsWith(".js")
          ? { "content-type": "text/javascript; charset=utf-8" }
          : {}),
      },
    });
  }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 404 }))),
);

/** Extension routes stay inside their authenticated namespace and use the active generation. */
export const pluginHttpRouteLayer = HttpRouter.add(
  "*",
  "/api/extensions/*",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.empty({ status: 400 });
    const [id, ...segments] = url.value.pathname.slice("/api/extensions/".length).split("/");
    if (!id) return HttpServerResponse.empty({ status: 404 });
    const plugins = yield* PluginService;
    return yield* plugins.handleHttp(id, request.method, "/" + segments.join("/"), request);
  }).pipe(
    Effect.catchTags({
      PluginError: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
    }),
  ),
);
