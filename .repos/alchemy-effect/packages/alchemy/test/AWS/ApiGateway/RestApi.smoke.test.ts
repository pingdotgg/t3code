import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment";
import * as Output from "@/Output";
import * as Test from "./Test.ts";
import { expect } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { TestFunction, TestFunctionLive } from "../Lambda/handler.ts";
import { assertRestApiDeleted } from "./assertions.ts";

const { test } = Test.make({ providers: AWS.providers() });

test.provider.skipIf(!!process.env.FAST)(
  "REST API proxies to Lambda (primitives)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { region, accountId } = yield* AWSEnvironment.current;

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* TestFunction.pipe(Effect.provide(TestFunctionLive));

          const api = yield* AWS.ApiGateway.RestApi("AgSmokeApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });

          const proxyResource = yield* AWS.ApiGateway.Resource("AgSmokeProxy", {
            restApi: api,
            parentId: api.rootResourceId,
            pathPart: "{proxy+}",
          });

          const invokeUri = Output.map(
            fn.functionArn,
            (arn: string) =>
              `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${arn}/invocations`,
          );

          yield* AWS.ApiGateway.Method("AgSmokeRootAny", {
            restApi: api,
            httpMethod: "ANY",
            authorizationType: "NONE",
            integration: {
              type: "AWS_PROXY",
              integrationHttpMethod: "POST",
              uri: invokeUri,
            },
          });

          yield* AWS.ApiGateway.Method("AgSmokeProxyAny", {
            restApi: api,
            resourceId: proxyResource.resourceId,
            httpMethod: "ANY",
            authorizationType: "NONE",
            integration: {
              type: "AWS_PROXY",
              integrationHttpMethod: "POST",
              uri: invokeUri,
            },
          });

          const deployment = yield* AWS.ApiGateway.Deployment("AgSmokeDep", {
            restApi: api,
            description: "smoke",
          });

          const stage = yield* AWS.ApiGateway.Stage("AgSmokeStage", {
            restApi: api,
            stageName: "test",
            deploymentId: deployment.deploymentId,
          });

          yield* AWS.Lambda.Permission("AgSmokePerm", {
            action: "lambda:InvokeFunction",
            functionName: fn.functionName,
            principal: "apigateway.amazonaws.com",
            sourceArn: Output.map(
              api.restApiId,
              (id: string) =>
                `arn:aws:execute-api:${region}:${accountId}:${id}/*/*/*`,
            ),
          });

          const invokeUrl = Output.map(
            Output.all(api.restApiId, stage.stageName),
            ([id, sn]: [string, string]) =>
              `https://${id}.execute-api.${region}.amazonaws.com/${sn}/`,
          );

          return { invokeUrl, restApiId: api.restApiId };
        }),
      );

      const response = yield* HttpClient.get(out.invokeUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`invoke URL returned ${response.status}`)),
        ),
        Effect.retry({
          // Stage propagation + Lambda permission can take 30–90s after the
          // last create. Cap exponential at 10s so we keep polling at a
          // steady cadence instead of doubling out to multi-minute waits.
          schedule: Schedule.max([
            Schedule.exponential(500).pipe(
              Schedule.modifyDelay(({ duration: d }) =>
                Effect.succeed(
                  Duration.isGreaterThan(d, Duration.seconds(10))
                    ? Duration.seconds(10)
                    : d,
                ),
              ),
            ),
            Schedule.recurs(20),
          ]),
        }),
      );

      expect(response.status).toBe(200);
      expect(yield* response.text).toBe("Hello, world!");

      yield* stack.destroy();
      yield* assertRestApiDeleted(out.restApiId);
    }),
  { timeout: 600_000 },
);
