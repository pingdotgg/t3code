import * as AWS from "@/AWS";
import { Role } from "@/AWS/IAM/Role.ts";
import { Endpoint, EndpointConfig, Model } from "@/AWS/SageMaker";
import * as Test from "@/Test/Alchemy";
import * as sagemaker from "@distilled.cloud/aws/sagemaker";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled patch carves EndpointNotFound
// out of the overloaded ValidationException. Runs in every CI pass.
test.provider(
  "describeEndpoint on a nonexistent endpoint fails with EndpointNotFound",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        sagemaker.describeEndpoint({
          EndpointName: "alchemy-nonexistent-sagemaker-endpoint-probe",
        }),
      );
      expect(error._tag).toBe("EndpointNotFound");
    }),
);

const findEndpoint = (name: string) =>
  sagemaker
    .describeEndpoint({ EndpointName: name })
    .pipe(Effect.catchTag("EndpointNotFound", () => Effect.succeed(undefined)));

// A live endpoint deploys real serving capacity: it takes ~3-10 minutes to
// reach InService and REQUIRES a working inference container. Gated behind:
//   AWS_TEST_SAGEMAKER_ENDPOINT=1
//   AWS_TEST_SAGEMAKER_IMAGE=<ECR URI of a serving container>
//   AWS_TEST_SAGEMAKER_MODEL_DATA=<s3://... model.tar.gz> (optional)
test.provider.skipIf(
  !process.env.AWS_TEST_SAGEMAKER_ENDPOINT ||
    !process.env.AWS_TEST_SAGEMAKER_IMAGE,
)(
  "create serverless endpoint, wait InService, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const image = process.env.AWS_TEST_SAGEMAKER_IMAGE!;
      const modelData = process.env.AWS_TEST_SAGEMAKER_MODEL_DATA;

      const { endpoint } = yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* Role("SageMakerEndpointRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "sagemaker.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            managedPolicyArns: [
              "arn:aws:iam::aws:policy/AmazonSageMakerFullAccess",
            ],
          });
          const model = yield* Model("EndpointTestModel", {
            executionRoleArn: role.roleArn,
            primaryContainer: {
              Image: image,
              ...(modelData ? { ModelDataUrl: modelData } : {}),
            },
          });
          const config = yield* EndpointConfig("EndpointTestConfig", {
            productionVariants: [
              {
                VariantName: "AllTraffic",
                ModelName: model.modelName,
                ServerlessConfig: { MemorySizeInMB: 2048, MaxConcurrency: 1 },
              },
            ],
          });
          const endpoint = yield* Endpoint("TestEndpoint", {
            endpointConfigName: config.endpointConfigName,
          });
          return { endpoint };
        }),
      );

      expect(endpoint.endpointArn).toContain(":endpoint/");
      expect(endpoint.endpointStatus).toBe("InService");

      // out-of-band verification via distilled
      const observed = yield* findEndpoint(endpoint.endpointName);
      expect(observed?.EndpointStatus).toBe("InService");

      // delete waits until the endpoint is fully gone
      yield* stack.destroy();
      expect(yield* findEndpoint(endpoint.endpointName)).toBeUndefined();
    }),
  { timeout: 1_500_000 },
);
