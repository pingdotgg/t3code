import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { Role } from "@/AWS/IAM/Role.ts";
import { Model } from "@/AWS/SageMaker";
import * as Test from "@/Test/Alchemy";
import * as sagemaker from "@distilled.cloud/aws/sagemaker";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { sklearnImage } from "./images.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled patch carves ModelNotFound
// out of the overloaded ValidationException. Runs in every CI pass.
test.provider(
  "describeModel on a nonexistent model fails with ModelNotFound",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        sagemaker.describeModel({
          ModelName: "alchemy-nonexistent-sagemaker-model-probe",
        }),
      );
      expect(error._tag).toBe("ModelNotFound");
    }),
);

const findModel = (modelName: string) =>
  sagemaker
    .describeModel({ ModelName: modelName })
    .pipe(Effect.catchTag("ModelNotFound", () => Effect.succeed(undefined)));

const sagemakerRole = Role("SageMakerModelRole", {
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
  // CreateModel validates the execution role can pull the container image.
  managedPolicyArns: [
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
  ],
});

test.provider(
  "create model, verify out-of-band, replace on container change, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { region } = yield* AWSEnvironment.current;
      const image = sklearnImage(region);

      const deployModel = (env: Record<string, string>) =>
        stack.deploy(
          Effect.gen(function* () {
            const role = yield* sagemakerRole;
            const model = yield* Model("TestModel", {
              executionRoleArn: role.roleArn,
              primaryContainer: {
                Image: image,
                Environment: env,
              },
              tags: { purpose: "alchemy-test" },
            });
            return { model };
          }),
        );

      const { model } = yield* deployModel({ MODEL_VERSION: "1" });
      expect(model.modelName).toBeDefined();
      expect(model.modelArn).toContain(":model/");

      // out-of-band verification via distilled
      const observed = yield* findModel(model.modelName);
      expect(observed?.ModelArn).toBe(model.modelArn);
      expect(observed?.PrimaryContainer?.Image).toBe(image);
      expect(observed?.PrimaryContainer?.Environment?.MODEL_VERSION).toBe("1");

      // internal ownership + user tags applied
      const tags = yield* sagemaker
        .listTags({ ResourceArn: model.modelArn })
        .pipe(Effect.map((r) => r.Tags ?? []));
      const tagMap = Object.fromEntries(tags.map((t) => [t.Key, t.Value]));
      expect(tagMap["alchemy::id"]).toBe("TestModel");
      expect(tagMap.purpose).toBe("alchemy-test");

      // Models are immutable: a container change must REPLACE the model.
      const { model: replaced } = yield* deployModel({ MODEL_VERSION: "2" });
      expect(replaced.modelName).not.toBe(model.modelName);
      const observedReplacement = yield* findModel(replaced.modelName);
      expect(
        observedReplacement?.PrimaryContainer?.Environment?.MODEL_VERSION,
      ).toBe("2");
      // the replaced model is deleted
      expect(yield* findModel(model.modelName)).toBeUndefined();

      yield* stack.destroy();
      expect(yield* findModel(replaced.modelName)).toBeUndefined();
    }),
  { timeout: 240_000 },
);
