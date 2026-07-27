import * as AWS from "@/AWS";
import { Pipeline } from "@/AWS/CodePipeline/Pipeline.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as codepipeline from "@distilled.cloud/aws/codepipeline";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Output from "@/Output";

const { test } = Test.make({ providers: AWS.providers() });

const pipelineName = "alchemy-test-codepipeline";

const getPipeline = codepipeline
  .getPipeline({ name: pipelineName })
  .pipe(
    Effect.catchTag("PipelineNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

// Build the stack: an S3 source bucket (must be versioned for an S3 source
// action), an artifact bucket, a pipeline role, and the pipeline itself.
const makeStack = (objectKey: string) =>
  Effect.gen(function* () {
    const source = yield* AWS.S3.Bucket("PipelineSource", {
      versioning: "Enabled",
      forceDestroy: true,
    });
    const artifacts = yield* AWS.S3.Bucket("PipelineArtifacts", {
      forceDestroy: true,
    });
    const role = yield* AWS.IAM.Role("PipelineRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "codepipeline.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      inlinePolicies: {
        Artifacts: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: [
                "s3:GetObject",
                "s3:GetObjectVersion",
                "s3:PutObject",
                "s3:GetBucketVersioning",
                "s3:ListBucket",
              ],
              Resource: [
                source.bucketArn,
                Output.interpolate`${source.bucketArn}/*` as any,
                artifacts.bucketArn,
                Output.interpolate`${artifacts.bucketArn}/*` as any,
              ],
            },
          ],
        },
      },
    });
    return yield* Pipeline("LifecyclePipeline", {
      pipelineName,
      roleArn: role.roleArn,
      artifactStore: { type: "S3", location: artifacts.bucketName },
      stages: [
        {
          name: "Source",
          actions: [
            {
              name: "S3Source",
              category: "Source",
              owner: "AWS",
              provider: "S3",
              outputArtifacts: ["SourceOutput"],
              configuration: {
                S3Bucket: source.bucketName,
                S3ObjectKey: objectKey,
                PollForSourceChanges: "false",
              },
            },
          ],
        },
        {
          name: "Approve",
          actions: [
            {
              name: "ManualApproval",
              category: "Approval",
              owner: "AWS",
              provider: "Manual",
            },
          ],
        },
      ],
    });
  });

test.provider(
  "lifecycle: create S3-source pipeline, update, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const deployed = yield* stack.deploy(makeStack("source.zip"));
      expect(deployed.pipelineName).toBe(pipelineName);
      expect(deployed.pipelineArn).toContain(`:${pipelineName}`);

      // Out-of-band verification via distilled.
      const created = yield* getPipeline;
      expect(created?.pipeline?.name).toBe(pipelineName);
      expect(created?.pipeline?.stages?.length).toBe(2);
      expect(created?.pipeline?.stages?.[0]?.name).toBe("Source");
      expect(
        created?.pipeline?.stages?.[0]?.actions?.[0]?.configuration
          ?.S3ObjectKey,
      ).toBe("source.zip");

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(Pipeline);
      const all = yield* provider.list();
      expect(all.some((p) => p.pipelineName === pipelineName)).toBe(true);

      // Update — change the source object key in place (no replacement).
      yield* stack.deploy(makeStack("release.zip"));
      const updated = yield* getPipeline;
      expect(
        updated?.pipeline?.stages?.[0]?.actions?.[0]?.configuration
          ?.S3ObjectKey,
      ).toBe("release.zip");

      // Destroy — pipeline is deleted; verify it is gone out-of-band.
      yield* stack.destroy();
      const after = yield* getPipeline;
      expect(after).toBeUndefined();
    }),
  { timeout: 300_000 },
);
