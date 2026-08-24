import * as ApiGatewayV2 from "@/AWS/ApiGatewayV2";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "bindings-handler.ts");

export class ApiGatewayV2BindingsFunction extends Lambda.Function<Lambda.Function>()(
  "ApiGatewayV2BindingsFunction",
) {}

/**
 * Fixture Lambda for the ApiGatewayV2 runtime bindings. It owns a minimal
 * HTTP API (one `HTTP_PROXY` route + an auto-deployed `$default` stage) so
 * the control-plane bindings have a live target, and exposes one route per
 * binding:
 *
 * - `GET /export`             → `ExportApi` (OpenAPI 3.0 export)
 * - `POST /reset-authorizers` → `ResetAuthorizersCache`
 */
export default ApiGatewayV2BindingsFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    // Minimal HTTP API + route + stage the bindings target.
    const api = yield* ApiGatewayV2.Api("AgV2BindingsApi", {
      protocolType: "HTTP",
    });
    const integration = yield* ApiGatewayV2.Integration(
      "AgV2BindingsUpstream",
      {
        api,
        integrationType: "HTTP_PROXY",
        integrationUri: "https://example.com",
        integrationMethod: "ANY",
        payloadFormatVersion: "1.0",
      },
    );
    yield* ApiGatewayV2.Route("AgV2BindingsPing", {
      api,
      routeKey: "GET /ping",
      integration,
    });
    const stage = yield* ApiGatewayV2.Stage("AgV2BindingsStage", {
      api,
      autoDeploy: true,
    });

    const exportApi = yield* ApiGatewayV2.ExportApi(api);
    const resetAuthorizersCache =
      yield* ApiGatewayV2.ResetAuthorizersCache(stage);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/export") {
          const exported = yield* exportApi({ OutputType: "JSON" }).pipe(
            Effect.orDie,
          );
          const document = exported.body
            ? yield* Stream.mkString(Stream.decodeText(exported.body)).pipe(
                Effect.orDie,
              )
            : "";
          const spec = yield* Effect.try(
            () =>
              JSON.parse(document) as {
                openapi?: string;
                paths?: Record<string, unknown>;
              },
          ).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            openapi: spec.openapi,
            paths: Object.keys(spec.paths ?? {}),
          });
        }

        if (request.method === "POST" && pathname === "/reset-authorizers") {
          // The stage has no Lambda-authorizer cache, so API Gateway may
          // answer with a typed NotFound — the IAM grant is still
          // exercised (a missing grant surfaces as an auth error instead,
          // failing the route with a 500).
          const flushed = yield* resetAuthorizersCache().pipe(
            Effect.map(() => true),
            Effect.catchTag("NotFoundException", () => Effect.succeed(false)),
            Effect.orDie,
          );
          return yield* HttpServerResponse.json({ flushed });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, path: pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ApiGatewayV2.ExportApiHttp,
        ApiGatewayV2.ResetAuthorizersCacheHttp,
      ),
    ),
  ),
);
