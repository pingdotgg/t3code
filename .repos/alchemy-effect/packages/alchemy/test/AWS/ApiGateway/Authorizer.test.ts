import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as ag from "@distilled.cloud/aws/api-gateway";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const runLive = process.env.ALCHEMY_RUN_LIVE_AWS_APIGATEWAY_TESTS === "true";
const authorizerUri = process.env.ALCHEMY_TEST_AUTHORIZER_URI;

/**
 * Requires a Lambda authorizer invocation URI accepted by API Gateway.
 */
test.provider.skipIf(!runLive || !authorizerUri)(
  "create and update Lambda TOKEN authorizer",
  (stack) =>
    Effect.gen(function* () {
      const uri = authorizerUri!;

      const { api, authorizer } = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.ApiGateway.RestApi("AgAuthorizerApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
          const authorizer = yield* AWS.ApiGateway.Authorizer("AgAuthorizer", {
            restApiId: api.restApiId,
            type: "TOKEN",
            authorizerUri: uri,
            identitySource: "method.request.header.Authorization",
            authorizerResultTtlInSeconds: 60,
          });
          return { api, authorizer };
        }),
      );

      yield* stack.deploy(
        Effect.gen(function* () {
          const apiAgain = yield* AWS.ApiGateway.RestApi("AgAuthorizerApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
          yield* AWS.ApiGateway.Authorizer("AgAuthorizer", {
            restApiId: apiAgain.restApiId,
            type: "TOKEN",
            authorizerUri: uri,
            identitySource: "method.request.header.Authorization",
            authorizerResultTtlInSeconds: 120,
          });
        }),
      );

      const remote = yield* ag.getAuthorizer({
        restApiId: api.restApiId,
        authorizerId: authorizer.authorizerId,
      });
      expect(remote.authorizerResultTtlInSeconds).toEqual(120);

      yield* stack.destroy();
    }),
);
