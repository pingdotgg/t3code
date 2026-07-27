import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { InstanceProfile } from "@/AWS/IAM/InstanceProfile.ts";
import { Role } from "@/AWS/IAM/Role.ts";
import {
  Component,
  DistributionConfiguration,
  ImagePipeline,
  ImageRecipe,
  InfrastructureConfiguration,
} from "@/AWS/ImageBuilder";
import * as Test from "@/Test/Alchemy";
import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag every read/delete path in this service depends on. Runs in
// every CI pass at near-zero cost.
test.provider(
  "getComponent on a nonexistent ARN fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      const error = yield* Effect.flip(
        imagebuilder.getComponent({
          componentBuildVersionArn: `arn:aws:imagebuilder:${region}:${accountId}:component/alchemy-nonexistent-probe/1.0.0/1`,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// Ungated typed-error probe: the Smithy model omits ResourceNotFoundException
// from GetImage / DeleteImage / CancelImageCreation even though the wire
// returns it — patched in distilled (patches/imagebuilder.json). This pins
// the patch so the image data-plane bindings can rely on the typed tag.
test.provider(
  "getImage/deleteImage on a nonexistent ARN fail with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      const arn = `arn:aws:imagebuilder:${region}:${accountId}:image/alchemy-nonexistent-probe/1.0.0/1`;
      const getError = yield* Effect.flip(
        imagebuilder.getImage({ imageBuildVersionArn: arn }),
      );
      expect(getError._tag).toBe("ResourceNotFoundException");
      const deleteError = yield* Effect.flip(
        imagebuilder.deleteImage({ imageBuildVersionArn: arn }),
      );
      expect(deleteError._tag).toBe("ResourceNotFoundException");
    }),
);

const componentData = (marker: string) =>
  [
    "name: alchemy-test-component",
    "description: no-op component used by alchemy live tests",
    "schemaVersion: 1.0",
    "phases:",
    "  - name: build",
    "    steps:",
    "      - name: hello",
    "        action: ExecuteBash",
    "        inputs:",
    "          commands:",
    `            - echo ${marker}`,
  ].join("\n");

/** Poll until an Image Builder resource is gone (typed NotFound). */
const untilGone = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(get);
    if (Result.isSuccess(result)) {
      return yield* Effect.fail(new Error("resource still exists"));
    }
    if (result.failure._tag !== "ResourceNotFoundException") {
      return yield* Effect.fail(
        new Error(`unexpected error: ${result.failure._tag}`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("3 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "image builder config lifecycle: create, update, replace, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { region } = yield* AWSEnvironment.current;
      const parentImage = `arn:aws:imagebuilder:${region}:aws:image/amazon-linux-2023-x86/x.x.x`;

      const program = (options: {
        componentVersion: string;
        distributionDescription: string;
        pipelineDescription: string;
      }) =>
        Effect.gen(function* () {
          const role = yield* Role("BuilderRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "ec2.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            managedPolicyArns: [
              "arn:aws:iam::aws:policy/EC2InstanceProfileForImageBuilder",
              "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
            ],
          });
          const profile = yield* InstanceProfile("BuilderProfile", {
            roleName: role.roleName,
          });
          const component = yield* Component("Setup", {
            platform: "Linux",
            semanticVersion: options.componentVersion,
            data: componentData("hello-from-alchemy"),
            tags: { fixture: "imagebuilder" },
          });
          const recipe = yield* ImageRecipe("Recipe", {
            parentImage,
            semanticVersion: options.componentVersion,
            components: [{ componentArn: component.componentBuildVersionArn }],
            tags: { fixture: "imagebuilder" },
          });
          const infra = yield* InfrastructureConfiguration("Infra", {
            instanceProfileName: profile.instanceProfileName,
            instanceTypes: ["t3.micro"],
            terminateInstanceOnFailure: true,
            tags: { fixture: "imagebuilder" },
          });
          const distribution = yield* DistributionConfiguration("Dist", {
            description: options.distributionDescription,
            distributions: [
              {
                region,
                amiDistributionConfiguration: {
                  name: "alchemy-imagebuilder-test-{{ imagebuilder:buildDate }}",
                  amiTags: { fixture: "imagebuilder" },
                },
              },
            ],
            tags: { fixture: "imagebuilder" },
          });
          const pipeline = yield* ImagePipeline("Pipeline", {
            imageRecipeArn: recipe.imageRecipeArn,
            infrastructureConfigurationArn:
              infra.infrastructureConfigurationArn,
            distributionConfigurationArn:
              distribution.distributionConfigurationArn,
            description: options.pipelineDescription,
            status: "DISABLED",
            // Duration-typed test timeout — converted to wire minutes.
            imageTestsConfiguration: {
              imageTestsEnabled: false,
              timeout: "2 hours",
            },
            tags: { fixture: "imagebuilder" },
          });
          return { component, recipe, infra, distribution, pipeline };
        });

      // 1. Create.
      const created = yield* stack.deploy(
        program({
          componentVersion: "1.0.0",
          distributionDescription: "alchemy imagebuilder test",
          pipelineDescription: "alchemy imagebuilder pipeline",
        }),
      );

      expect(created.component.componentBuildVersionArn).toContain(
        ":component/",
      );
      expect(created.component.componentBuildVersionArn).toContain("/1.0.0/1");
      expect(created.component.platform).toBe("Linux");
      expect(created.recipe.imageRecipeArn).toContain(":image-recipe/");
      expect(created.infra.infrastructureConfigurationArn).toContain(
        ":infrastructure-configuration/",
      );
      expect(created.distribution.distributionConfigurationArn).toContain(
        ":distribution-configuration/",
      );
      expect(created.pipeline.imagePipelineArn).toContain(":image-pipeline/");
      expect(created.pipeline.status).toBe("DISABLED");

      // Out-of-band verification via distilled.
      const observedPipeline = yield* imagebuilder.getImagePipeline({
        imagePipelineArn: created.pipeline.imagePipelineArn,
      });
      expect(observedPipeline.imagePipeline?.imageRecipeArn).toBe(
        created.recipe.imageRecipeArn,
      );
      expect(
        observedPipeline.imagePipeline?.infrastructureConfigurationArn,
      ).toBe(created.infra.infrastructureConfigurationArn);
      expect(observedPipeline.imagePipeline?.status).toBe("DISABLED");
      // The Duration-typed test timeout landed as wire minutes.
      expect(
        observedPipeline.imagePipeline?.imageTestsConfiguration?.timeoutMinutes,
      ).toBe(120);
      expect(observedPipeline.imagePipeline?.tags?.["alchemy::id"]).toBe(
        "Pipeline",
      );

      const observedRecipe = yield* imagebuilder.getImageRecipe({
        imageRecipeArn: created.recipe.imageRecipeArn,
      });
      expect(observedRecipe.imageRecipe?.components?.[0]?.componentArn).toBe(
        created.component.componentBuildVersionArn,
      );
      expect(observedRecipe.imageRecipe?.parentImage).toBe(parentImage);

      const observedInfra = yield* imagebuilder.getInfrastructureConfiguration({
        infrastructureConfigurationArn:
          created.infra.infrastructureConfigurationArn,
      });
      expect(
        observedInfra.infrastructureConfiguration?.instanceProfileName,
      ).toBe(created.infra.instanceProfileName);
      expect(observedInfra.infrastructureConfiguration?.instanceTypes).toEqual([
        "t3.micro",
      ]);

      // 2. Update mutable configs in place (same ARNs).
      const updated = yield* stack.deploy(
        program({
          componentVersion: "1.0.0",
          distributionDescription: "alchemy imagebuilder test (updated)",
          pipelineDescription: "alchemy imagebuilder pipeline (updated)",
        }),
      );
      expect(updated.distribution.distributionConfigurationArn).toBe(
        created.distribution.distributionConfigurationArn,
      );
      expect(updated.pipeline.imagePipelineArn).toBe(
        created.pipeline.imagePipelineArn,
      );
      const updatedDistribution =
        yield* imagebuilder.getDistributionConfiguration({
          distributionConfigurationArn:
            updated.distribution.distributionConfigurationArn,
        });
      expect(updatedDistribution.distributionConfiguration?.description).toBe(
        "alchemy imagebuilder test (updated)",
      );
      const updatedPipeline = yield* imagebuilder.getImagePipeline({
        imagePipelineArn: updated.pipeline.imagePipelineArn,
      });
      expect(updatedPipeline.imagePipeline?.description).toBe(
        "alchemy imagebuilder pipeline (updated)",
      );

      // 3. Replace immutable versions: bumping the component version
      //    replaces component + recipe; the pipeline updates in place to
      //    the new recipe ARN.
      const replaced = yield* stack.deploy(
        program({
          componentVersion: "1.0.1",
          distributionDescription: "alchemy imagebuilder test (updated)",
          pipelineDescription: "alchemy imagebuilder pipeline (updated)",
        }),
      );
      expect(replaced.component.componentBuildVersionArn).not.toBe(
        created.component.componentBuildVersionArn,
      );
      expect(replaced.component.componentBuildVersionArn).toContain("/1.0.1/1");
      expect(replaced.recipe.imageRecipeArn).not.toBe(
        created.recipe.imageRecipeArn,
      );
      expect(replaced.pipeline.imagePipelineArn).toBe(
        created.pipeline.imagePipelineArn,
      );
      const replacedPipeline = yield* imagebuilder.getImagePipeline({
        imagePipelineArn: replaced.pipeline.imagePipelineArn,
      });
      expect(replacedPipeline.imagePipeline?.imageRecipeArn).toBe(
        replaced.recipe.imageRecipeArn,
      );

      // 4. Destroy and verify everything is gone out-of-band.
      yield* stack.destroy();
      yield* untilGone(
        imagebuilder.getImagePipeline({
          imagePipelineArn: replaced.pipeline.imagePipelineArn,
        }),
      );
      yield* untilGone(
        imagebuilder.getImageRecipe({
          imageRecipeArn: replaced.recipe.imageRecipeArn,
        }),
      );
      yield* untilGone(
        imagebuilder.getComponent({
          componentBuildVersionArn: replaced.component.componentBuildVersionArn,
        }),
      );
      yield* untilGone(
        imagebuilder.getInfrastructureConfiguration({
          infrastructureConfigurationArn:
            replaced.infra.infrastructureConfigurationArn,
        }),
      );
      yield* untilGone(
        imagebuilder.getDistributionConfiguration({
          distributionConfigurationArn:
            replaced.distribution.distributionConfigurationArn,
        }),
      );
    }),
  { timeout: 180_000 },
);
