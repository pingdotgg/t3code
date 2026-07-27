import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment";
import * as Output from "@/Output";
import * as Provider from "@/Provider";
import * as Test from "./Test.ts";
import * as ag from "@distilled.cloud/aws/api-gateway";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { TestFunction, TestFunctionLive } from "../Lambda/handler.ts";
import { assertRestApiDeleted } from "./assertions.ts";

const { test } = Test.make({ providers: AWS.providers() });

const authorizerUri = process.env.ALCHEMY_TEST_AUTHORIZER_URI;

/**
 * Requires a Lambda authorizer invocation URI accepted by API Gateway.
 */
test.provider.skipIf(!!process.env.FAST || !authorizerUri)(
  "create and update Lambda TOKEN authorizer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

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
            authorizerResultTtl: "60 seconds",
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
            authorizerResultTtl: "120 seconds",
          });
        }),
      );

      const remote = yield* ag.getAuthorizer({
        restApiId: api.restApiId,
        authorizerId: authorizer.authorizerId,
      });
      expect(remote.authorizerResultTtlInSeconds).toEqual(120);

      yield* stack.destroy();
      yield* assertRestApiDeleted(api.restApiId);
    }),
);

test.provider.skipIf(!!process.env.FAST)(
  "list enumerates the deployed authorizer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { region } = yield* AWSEnvironment.current;

      const { authorizer } = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* TestFunction.pipe(Effect.provide(TestFunctionLive));
          const api = yield* AWS.ApiGateway.RestApi("AgAuthorizerListApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
          const authorizer = yield* AWS.ApiGateway.Authorizer(
            "AgAuthorizerList",
            {
              restApiId: api.restApiId,
              type: "TOKEN",
              authorizerUri: Output.map(
                fn.functionArn,
                (arn: string) =>
                  `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${arn}/invocations`,
              ),
              identitySource: "method.request.header.Authorization",
            },
          );
          return { authorizer };
        }),
      );

      const provider = yield* Provider.findProvider(AWS.ApiGateway.Authorizer);
      const all = yield* provider.list();

      expect(all.some((a) => a.authorizerId === authorizer.authorizerId)).toBe(
        true,
      );

      yield* stack.destroy();
      yield* assertRestApiDeleted(authorizer.restApiId);
    }),
  { timeout: 300_000 },
);
