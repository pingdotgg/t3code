import * as AWS from "@/AWS";
import { MethodResource } from "@/AWS/ApiGateway/Method.ts";
import * as Provider from "@/Provider";
import * as Test from "./Test.ts";
import * as ag from "@distilled.cloud/aws/api-gateway";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { assertRestApiDeleted } from "./assertions.ts";

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
);
