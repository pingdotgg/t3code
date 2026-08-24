import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
import * as Test from "./Test.ts";
import * as ag from "@distilled.cloud/aws/api-gateway";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { assertRestApiDeleted } from "./assertions.ts";

const { test } = Test.make({ providers: AWS.providers() });

// DeleteRestApi has a hard regional quota of roughly one request every 30s.
// Exercise create/read/list and both directions of the mutable media-type
// lifecycle on one deterministic API rather than provisioning and deleting
// four equivalent parents. Every former assertion remains out-of-band; the
// file now pays the deletion wall once.
test.provider.skipIf(!!process.env.FAST)(
  "REST API lifecycle, binary media updates, and list",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const api = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiLifecycle", {
            endpointConfiguration: { types: ["REGIONAL"] },
            binaryMediaTypes: ["application/octet-stream"],
          });
        }),
      );

      expect(api.restApiId).toBeDefined();
      expect(api.rootResourceId).toBeDefined();
      expect(api.binaryMediaTypes?.includes("application/octet-stream")).toBe(
        true,
      );

      const created = yield* ag.getRestApi({ restApiId: api.restApiId });
      expect(created.id).toEqual(api.restApiId);

      const provider = yield* Provider.findProvider(AWS.ApiGateway.RestApi);
      const all = yield* provider.list();
      expect(all.some((a) => a.restApiId === api.restApiId)).toBe(true);

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiLifecycle", {
            endpointConfiguration: { types: ["REGIONAL"] },
            binaryMediaTypes: ["application/octet-stream", "image/png"],
          });
        }),
      );

      const widened = yield* ag.getRestApi({ restApiId: api.restApiId });
      expect(widened.binaryMediaTypes?.includes("image/png")).toBe(true);

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiLifecycle", {
            endpointConfiguration: { types: ["REGIONAL"] },
            binaryMediaTypes: ["image/png"],
          });
        }),
      );

      const narrowed = yield* ag.getRestApi({ restApiId: api.restApiId });
      expect(narrowed.binaryMediaTypes?.includes("image/png")).toBe(true);
      expect(
        narrowed.binaryMediaTypes?.includes("application/octet-stream"),
      ).toBe(false);

      yield* stack.destroy();
      yield* assertRestApiDeleted(api.restApiId);
    }),
);
