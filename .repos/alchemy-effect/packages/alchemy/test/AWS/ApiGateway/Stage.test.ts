import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
import * as Test from "./Test.ts";
import * as ag from "@distilled.cloud/aws/api-gateway";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { assertRestApiDeleted } from "./assertions.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Stage create, mutable settings, and list all use the same API/method/
// deployment topology. One lifecycle preserves every cloud assertion while
// avoiding three redundant DeleteRestApi quota windows.
test.provider.skipIf(!!process.env.FAST)(
  "stage lifecycle, settings updates, and list",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployStage = (variables: Record<string, string>, burst: number) =>
        stack.deploy(
          Effect.gen(function* () {
            const api = yield* AWS.ApiGateway.RestApi("AgStageApi", {
              endpointConfiguration: { types: ["REGIONAL"] },
            });
            yield* AWS.ApiGateway.Method("AgStageMock", {
              restApi: api,
              httpMethod: "GET",
              authorizationType: "NONE",
              integration: { type: "MOCK" },
            });
            const deployment = yield* AWS.ApiGateway.Deployment("AgStageDep", {
              restApi: api,
            });
            const stage = yield* AWS.ApiGateway.Stage("AgStageDev", {
              restApi: api,
              stageName: "dev",
              deploymentId: deployment.deploymentId,
              variables,
              methodSettings: {
                "*/*": {
                  throttlingBurstLimit: burst,
                  throttlingRateLimit: burst * 10,
                },
              },
            });
            return { api, stage };
          }),
        );

      const { api, stage } = yield* deployStage({ K: "1" }, 10);
      expect(stage.stageName).toEqual("dev");

      yield* deployStage({ K: "2" }, 20);

      const remote = yield* ag.getStage({
        restApiId: api.restApiId,
        stageName: "dev",
      });
      expect(remote.variables?.K).toEqual("2");
      expect(remote.methodSettings?.["*/*"]?.throttlingBurstLimit).toEqual(20);
      expect(remote.methodSettings?.["*/*"]?.throttlingRateLimit).toEqual(200);

      const provider = yield* Provider.findProvider(
        AWS.ApiGateway.StageResource,
      );
      const all = yield* provider.list();
      expect(
        all.some(
          (item) =>
            item.restApiId === stage.restApiId &&
            item.stageName === stage.stageName,
        ),
      ).toBe(true);

      yield* stack.destroy();
      yield* assertRestApiDeleted(api.restApiId);
    }),
);
