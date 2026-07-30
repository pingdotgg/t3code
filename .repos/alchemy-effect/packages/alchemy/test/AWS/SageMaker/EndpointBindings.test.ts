import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import SageMakerEndpointTestFunctionLive, {
  SageMakerEndpointTestFunction,
} from "./endpoint-handler";

// A live endpoint deploys real serving capacity (~3-10 min to InService) and
// requires a working inference container. Same gate as Endpoint.test.ts:
//   AWS_TEST_SAGEMAKER_ENDPOINT=1
//   AWS_TEST_SAGEMAKER_IMAGE=<ECR URI of a serving container>
const gated =
  !process.env.AWS_TEST_SAGEMAKER_ENDPOINT ||
  !process.env.AWS_TEST_SAGEMAKER_IMAGE;

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "SageMakerEndpointBindings");

let baseUrl: string;

describe("SageMaker Endpoint Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      if (gated) return;

      yield* sharedStack.destroy();
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* SageMakerEndpointTestFunction;
        }).pipe(Effect.provide(SageMakerEndpointTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");

      yield* HttpClient.get(`${baseUrl}/health`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(75),
          ]),
        }),
      );
    }),
    { timeout: 1_500_000 },
  );

  afterAll.skipIf(gated)(sharedStack.destroy(), { timeout: 1_200_000 });

  describe("DescribeEndpoint", () => {
    test.provider.skipIf(gated)(
      "reads the bound endpoint's live status (injected endpoint name)",
      () =>
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const response = yield* client.get(`${baseUrl}/describe-endpoint`);
          expect(response.status).toBe(200);
          const body = (yield* response.json) as {
            endpointName: string;
            status: string;
            variants: string[];
          };
          expect(body.status).toBe("InService");
          expect(body.variants).toContain("AllTraffic");
        }),
      { timeout: 120_000 },
    );
  });

  describe("UpdateEndpointWeightsAndCapacities", () => {
    test.provider.skipIf(gated)(
      "the binding registers on the runtime (IAM grant proven by deploy)",
      () =>
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const response = yield* client.get(`${baseUrl}/bindings`);
          const body = (yield* response.json) as { bound: string[] };
          expect(body.bound).toContain("updateWeights");
        }),
      { timeout: 60_000 },
    );
  });
});
