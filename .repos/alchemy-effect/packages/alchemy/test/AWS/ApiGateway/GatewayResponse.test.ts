import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
import * as Test from "./Test.ts";
import * as ag from "@distilled.cloud/aws/api-gateway";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { assertRestApiDeleted } from "./assertions.ts";

const { test } = Test.make({ providers: AWS.providers() });

test.provider.skipIf(!!process.env.FAST)(
  "create and delete gateway response",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { api } = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.ApiGateway.RestApi("AgGwRespApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
          yield* AWS.ApiGateway.GatewayResponse("AgDefault4xx", {
            restApiId: api.restApiId,
            responseType: "DEFAULT_4XX",
            responseTemplates: {
              "application/json": '{"message":"test"}',
            },
          });
          return { api };
        }),
      );

      const g = yield* ag.getGatewayResponse({
        restApiId: api.restApiId,
        responseType: "DEFAULT_4XX",
      });
      expect(g.responseType).toEqual("DEFAULT_4XX");

      yield* stack.destroy();
      yield* assertRestApiDeleted(api.restApiId);
    }),
);

test.provider.skipIf(!!process.env.FAST)(
  "update gateway response status and templates",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { api } = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.ApiGateway.RestApi("AgGwRespUpdateApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
          yield* AWS.ApiGateway.GatewayResponse("AgDefault5xx", {
            restApiId: api.restApiId,
            responseType: "DEFAULT_5XX",
            statusCode: "500",
            responseTemplates: {
              "application/json": '{"message":"v1"}',
            },
          });
          return { api };
        }),
      );

      yield* stack.deploy(
        Effect.gen(function* () {
          const apiAgain = yield* AWS.ApiGateway.RestApi("AgGwRespUpdateApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
          yield* AWS.ApiGateway.GatewayResponse("AgDefault5xx", {
            restApiId: apiAgain.restApiId,
            responseType: "DEFAULT_5XX",
            statusCode: "502",
            responseTemplates: {
              "application/json": '{"message":"v2"}',
            },
          });
        }),
      );

      const g = yield* ag.getGatewayResponse({
        restApiId: api.restApiId,
        responseType: "DEFAULT_5XX",
      });
      expect(g.statusCode).toEqual("502");
      expect(g.responseTemplates?.["application/json"]).toEqual(
        '{"message":"v2"}',
      );

      yield* stack.destroy();
      yield* assertRestApiDeleted(api.restApiId);
    }),
  // Three sequential deploy/destroy cycles against API Gateway's account-wide
  // throttle: ~95s alone, >120s under a saturated full-suite run.
  { timeout: 240_000 },
);

test.provider.skipIf(!!process.env.FAST)(
  "list enumerates the deployed gateway response",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { api } = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.ApiGateway.RestApi("AgGwRespListApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
          yield* AWS.ApiGateway.GatewayResponse("AgListDefault4xx", {
            restApiId: api.restApiId,
            responseType: "DEFAULT_4XX",
            responseTemplates: {
              "application/json": '{"message":"list"}',
            },
          });
          return { api };
        }),
      );

      const provider = yield* Provider.findProvider(
        AWS.ApiGateway.GatewayResponse,
      );
      const all = yield* provider.list();

      expect(
        all.some(
          (g) =>
            g.restApiId === api.restApiId && g.responseType === "DEFAULT_4XX",
        ),
      ).toBe(true);

      yield* stack.destroy();
      yield* assertRestApiDeleted(api.restApiId);
    }),
);
