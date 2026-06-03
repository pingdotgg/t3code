import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as ag from "@distilled.cloud/aws/api-gateway";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const runLive = process.env.ALCHEMY_RUN_LIVE_AWS_APIGATEWAY_TESTS === "true";

test.provider.skipIf(!runLive)(
  "create and delete API Gateway resource",
  (stack) =>
    Effect.gen(function* () {
      const { api, res } = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.ApiGateway.RestApi("AgResApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
          const res = yield* AWS.ApiGateway.Resource("AgSubPath", {
            restApi: api,
            parentId: api.rootResourceId,
            pathPart: "items",
          });
          return { api, res };
        }),
      );

      const remote = yield* ag.getResource({
        restApiId: api.restApiId,
        resourceId: res.resourceId,
      });
      expect(remote.pathPart).toEqual("items");

      yield* stack.destroy();
    }),
);
