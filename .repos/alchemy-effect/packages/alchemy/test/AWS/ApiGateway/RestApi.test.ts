import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as ag from "@distilled.cloud/aws/api-gateway";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const runLive = process.env.ALCHEMY_RUN_LIVE_AWS_APIGATEWAY_TESTS === "true";

test.provider.skipIf(!runLive)("create and delete REST API", (stack) =>
  Effect.gen(function* () {
    const api = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* AWS.ApiGateway.RestApi("AgRestApiLifecycle", {
          endpointConfiguration: { types: ["REGIONAL"] },
        });
      }),
    );

    expect(api.restApiId).toBeDefined();
    expect(api.rootResourceId).toBeDefined();

    const remote = yield* ag.getRestApi({ restApiId: api.restApiId });
    expect(remote.id).toEqual(api.restApiId);

    yield* stack.destroy();
  }),
);

test.provider.skipIf(!runLive)(
  "binary media types update applies via patch",
  (stack) =>
    Effect.gen(function* () {
      const api = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiBinary", {
            endpointConfiguration: { types: ["REGIONAL"] },
            binaryMediaTypes: ["application/octet-stream"],
          });
        }),
      );

      expect(api.binaryMediaTypes?.includes("application/octet-stream")).toBe(
        true,
      );

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiBinary", {
            endpointConfiguration: { types: ["REGIONAL"] },
            binaryMediaTypes: ["application/octet-stream", "image/png"],
          });
        }),
      );

      const remote = yield* ag.getRestApi({ restApiId: api.restApiId });
      expect(remote.binaryMediaTypes?.includes("image/png")).toBe(true);

      yield* stack.destroy();
    }),
);

test.provider.skipIf(!runLive)(
  "binary media types removal applies via patch",
  (stack) =>
    Effect.gen(function* () {
      const api = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiBinaryRemoval", {
            endpointConfiguration: { types: ["REGIONAL"] },
            binaryMediaTypes: ["application/octet-stream", "image/png"],
          });
        }),
      );

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiBinaryRemoval", {
            endpointConfiguration: { types: ["REGIONAL"] },
            binaryMediaTypes: ["image/png"],
          });
        }),
      );

      const remote = yield* ag.getRestApi({ restApiId: api.restApiId });
      expect(remote.binaryMediaTypes?.includes("image/png")).toBe(true);
      expect(
        remote.binaryMediaTypes?.includes("application/octet-stream"),
      ).toBe(false);

      yield* stack.destroy();
    }),
);
