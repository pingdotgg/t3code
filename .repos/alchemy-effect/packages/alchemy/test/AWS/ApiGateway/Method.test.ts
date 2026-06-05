import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as ag from "@distilled.cloud/aws/api-gateway";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const runLive = process.env.ALCHEMY_RUN_LIVE_AWS_APIGATEWAY_TESTS === "true";

test.provider.skipIf(!runLive)("create and delete MOCK method", (stack) =>
  Effect.gen(function* () {
    const { api } = yield* stack.deploy(
      Effect.gen(function* () {
        const api = yield* AWS.ApiGateway.RestApi("AgMethodApi", {
          endpointConfiguration: { types: ["REGIONAL"] },
        });
        yield* AWS.ApiGateway.Method("AgMockGet", {
          restApi: api,
          httpMethod: "GET",
          authorizationType: "NONE",
          integration: {
            type: "MOCK",
            requestTemplates: { "application/json": '{"statusCode": 200}' },
          },
        });
        return { api };
      }),
    );

    const method = yield* ag.getMethod({
      restApiId: api.restApiId,
      resourceId: api.rootResourceId,
      httpMethod: "GET",
    });
    expect(method.httpMethod).toEqual("GET");

    yield* stack.destroy();
  }),
);
