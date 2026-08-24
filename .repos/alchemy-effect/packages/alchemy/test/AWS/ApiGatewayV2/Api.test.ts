import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as agw2 from "@distilled.cloud/aws/apigatewayv2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class ApiStillExists extends Data.TaggedError("ApiStillExists")<{
  readonly apiId: string;
}> {}

/** Poll until `getApi` returns the typed NotFoundException. */
const assertApiDeleted = (apiId: string) =>
  agw2.getApi({ ApiId: apiId }).pipe(
    Effect.flatMap(() => Effect.fail(new ApiStillExists({ apiId }))),
    Effect.retry({
      while: (e) => e._tag === "ApiStillExists",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
    Effect.catchTag("NotFoundException", () => Effect.void),
  );

test.provider(
  "create, update, delete HTTP API",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const api = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGatewayV2.Api("LifecycleApi", {
            description: "v1",
          });
        }),
      );

      expect(api.apiId).toBeTruthy();
      expect(api.protocolType).toBe("HTTP");
      expect(api.apiEndpoint).toContain("execute-api");

      // Out-of-band verification via distilled.
      const remote = yield* agw2.getApi({ ApiId: api.apiId });
      expect(remote.Description).toBe("v1");
      // Internal Alchemy tags brand the API.
      expect(Object.keys(remote.Tags ?? {}).length).toBeGreaterThan(0);

      // Update description + CORS in place (same apiId).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGatewayV2.Api("LifecycleApi", {
            description: "v2",
            corsConfiguration: {
              AllowOrigins: ["https://example.com"],
              AllowMethods: ["GET"],
            },
          });
        }),
      );
      expect(updated.apiId).toBe(api.apiId);

      const afterUpdate = yield* agw2.getApi({ ApiId: api.apiId });
      expect(afterUpdate.Description).toBe("v2");
      expect(afterUpdate.CorsConfiguration?.AllowOrigins).toEqual([
        "https://example.com",
      ]);

      // Removing CORS deletes the configuration.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGatewayV2.Api("LifecycleApi", {
            description: "v2",
          });
        }),
      );
      const afterCorsRemoval = yield* agw2.getApi({ ApiId: api.apiId });
      expect(afterCorsRemoval.CorsConfiguration).toBeUndefined();

      yield* stack.destroy();
      yield* assertApiDeleted(api.apiId);
    }),
  { timeout: 240_000 },
);

test.provider(
  "protocolType change replaces the API",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const httpApi = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGatewayV2.Api("ReplaceApi", {});
        }),
      );
      expect(httpApi.protocolType).toBe("HTTP");

      const wsApi = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGatewayV2.Api("ReplaceApi", {
            protocolType: "WEBSOCKET",
          });
        }),
      );

      expect(wsApi.protocolType).toBe("WEBSOCKET");
      expect(wsApi.apiId).not.toBe(httpApi.apiId);
      expect(wsApi.routeSelectionExpression).toBe("$request.body.action");

      // The replaced HTTP API is deleted.
      yield* assertApiDeleted(httpApi.apiId);

      yield* stack.destroy();
      yield* assertApiDeleted(wsApi.apiId);
    }),
  { timeout: 240_000 },
);

test.provider(
  "stage, integration, and route lifecycle on one API",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployPrimitives = (upstreamPath: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const api = yield* AWS.ApiGatewayV2.Api("PrimApi", {});
            const integration = yield* AWS.ApiGatewayV2.Integration(
              "PrimIntegration",
              {
                api,
                integrationType: "HTTP_PROXY",
                integrationUri: `https://checkip.amazonaws.com${upstreamPath}`,
                integrationMethod: "GET",
                payloadFormatVersion: "1.0",
              },
            );
            const route = yield* AWS.ApiGatewayV2.Route("PrimRoute", {
              api,
              routeKey: "GET /ip",
              integration,
            });
            const stage = yield* AWS.ApiGatewayV2.Stage("PrimStage", {
              api,
              autoDeploy: true,
              description: "primitives",
            });
            return {
              apiId: api.apiId,
              integrationId: integration.integrationId,
              routeId: route.routeId,
              routeKey: route.routeKey,
              stageName: stage.stageName,
              invokeUrl: stage.invokeUrl,
            };
          }),
        );

      const out = yield* deployPrimitives("/");

      expect(out.stageName).toBe("$default");
      expect(out.invokeUrl).toContain(out.apiId);

      // Out-of-band verification of each primitive via distilled.
      const integ = yield* agw2.getIntegration({
        ApiId: out.apiId,
        IntegrationId: out.integrationId,
      });
      expect(integ.IntegrationType).toBe("HTTP_PROXY");
      expect(integ.IntegrationUri).toBe("https://checkip.amazonaws.com/");

      const route = yield* agw2.getRoute({
        ApiId: out.apiId,
        RouteId: out.routeId,
      });
      expect(route.RouteKey).toBe("GET /ip");
      expect(route.Target).toBe(`integrations/${out.integrationId}`);

      const stage = yield* agw2.getStage({
        ApiId: out.apiId,
        StageName: "$default",
      });
      expect(stage.AutoDeploy).toBe(true);
      expect(stage.Description).toBe("primitives");

      // Second deploy is a no-op / in-place sync (same physical ids).
      const again = yield* deployPrimitives("/");
      expect(again.apiId).toBe(out.apiId);
      expect(again.integrationId).toBe(out.integrationId);
      expect(again.routeId).toBe(out.routeId);

      yield* stack.destroy();
      yield* assertApiDeleted(out.apiId);
    }),
  { timeout: 240_000 },
);
