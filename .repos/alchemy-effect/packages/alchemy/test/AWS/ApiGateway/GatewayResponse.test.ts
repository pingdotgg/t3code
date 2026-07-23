import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as ag from "@distilled.cloud/aws/api-gateway";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const runLive = process.env.ALCHEMY_RUN_LIVE_AWS_APIGATEWAY_TESTS === "true";

test.provider.skipIf(!runLive)("create and delete gateway response", (stack) =>
  Effect.gen(function* () {
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
  }),
);

test.provider.skipIf(!runLive)(
  "update gateway response status and templates",
  (stack) =>
    Effect.gen(function* () {
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
    }),
);
