import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
import * as Test from "./Test.ts";
import * as ag from "@distilled.cloud/aws/api-gateway";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { assertRestApiDeleted } from "./assertions.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Both resource cases require the same parent and child shape. Keep their
// out-of-band read and provider-list assertions in one lifecycle so the
// regional DeleteRestApi throttle is crossed once rather than twice.
test.provider.skipIf(!!process.env.FAST)(
  "API Gateway resource lifecycle and list",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

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

      const provider = yield* Provider.findProvider(
        AWS.ApiGateway.GatewayResource,
      );
      const all = yield* provider.list();
      expect(all.some((r) => r.resourceId === res.resourceId)).toBe(true);

      yield* stack.destroy();
      yield* assertRestApiDeleted(api.restApiId);
    }),
);
