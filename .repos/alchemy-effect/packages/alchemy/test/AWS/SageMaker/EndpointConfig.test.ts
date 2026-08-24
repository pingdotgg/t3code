import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { Role } from "@/AWS/IAM/Role.ts";
import { EndpointConfig, Model } from "@/AWS/SageMaker";
import * as Test from "@/Test/Alchemy";
import * as sagemaker from "@distilled.cloud/aws/sagemaker";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { sklearnImage } from "./images.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled patch carves
// EndpointConfigNotFound out of the overloaded ValidationException.
test.provider(
  "describeEndpointConfig on a nonexistent config fails with EndpointConfigNotFound",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        sagemaker.describeEndpointConfig({
          EndpointConfigName: "alchemy-nonexistent-sagemaker-config-probe",
        }),
      );
      expect(error._tag).toBe("EndpointConfigNotFound");
    }),
);

const findConfig = (name: string) =>
  sagemaker
    .describeEndpointConfig({ EndpointConfigName: name })
    .pipe(
      Effect.catchTag("EndpointConfigNotFound", () =>
        Effect.succeed(undefined),
      ),
    );

test.provider(
  "create serverless endpoint config, verify out-of-band, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { region } = yield* AWSEnvironment.current;
      const image = sklearnImage(region);

      const { model, config } = yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* Role("SageMakerConfigRole", {
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
              "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
            ],
          });
          const model = yield* Model("ConfigTestModel", {
            executionRoleArn: role.roleArn,
            primaryContainer: { Image: image },
          });
          const config = yield* EndpointConfig("TestConfig", {
            productionVariants: [
              {
                VariantName: "AllTraffic",
                ModelName: model.modelName,
                ServerlessConfig: { MemorySizeInMB: 1024, MaxConcurrency: 1 },
              },
            ],
            tags: { purpose: "alchemy-test" },
          });
          return { model, config };
        }),
      );

      expect(config.endpointConfigName).toBeDefined();
      expect(config.endpointConfigArn).toContain(":endpoint-config/");

      // out-of-band verification via distilled
      const observed = yield* findConfig(config.endpointConfigName);
      expect(observed?.EndpointConfigArn).toBe(config.endpointConfigArn);
      const variant = observed?.ProductionVariants?.[0];
      expect(variant?.ModelName).toBe(model.modelName);
      expect(variant?.ServerlessConfig?.MemorySizeInMB).toBe(1024);

      // internal ownership tags applied
      const tags = yield* sagemaker
        .listTags({ ResourceArn: config.endpointConfigArn })
        .pipe(Effect.map((r) => r.Tags ?? []));
      const tagMap = Object.fromEntries(tags.map((t) => [t.Key, t.Value]));
      expect(tagMap["alchemy::id"]).toBe("TestConfig");
      expect(tagMap.purpose).toBe("alchemy-test");

      yield* stack.destroy();
      expect(yield* findConfig(config.endpointConfigName)).toBeUndefined();
    }),
  { timeout: 240_000 },
);
