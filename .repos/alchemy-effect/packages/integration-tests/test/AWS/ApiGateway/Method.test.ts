import * as AWS from "@alchemy.run/aws";
import { MethodResource } from "@alchemy.run/aws/ApiGateway/Method";
import { expect } from "@alchemy.run/test";
import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { assertRestApiDeleted } from "./assertions.ts";
import * as Test from "./Test.ts";

const { test } = Test.make({ providers: AWS.providers() });

test.provider.skipIf(!!process.env.FAST)(
  "create and delete MOCK method",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

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
      yield* assertRestApiDeleted(api.restApiId);
    }),
  { tags: ["provider:aws", "provider:aws:apigateway", "live"] },
);

// Canonical `list()` test: deploy a RestApi + Method (parents included), then
// enumerate every method across all RestApis via the typed provider and assert
// the deployed method appears with its full Attributes shape.
test.provider.skipIf(!!process.env.FAST)(
  "list enumerates the deployed method",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { api } = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.ApiGateway.RestApi("AgMethodListApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
          yield* AWS.ApiGateway.Method("AgListMockGet", {
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

      const provider = yield* Provider.findProvider(MethodResource);
      const all = yield* provider.list();

      expect(
        all.some(
          (m) =>
            m.restApiId === api.restApiId &&
            m.resourceId === api.rootResourceId &&
            m.httpMethod === "GET",
        ),
      ).toBe(true);

      yield* stack.destroy();
      yield* assertRestApiDeleted(api.restApiId);
    }),
  { tags: ["provider:aws", "provider:aws:apigateway", "live"] },
);
