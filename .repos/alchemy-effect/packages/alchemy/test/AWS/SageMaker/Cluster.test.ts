import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { Role } from "@/AWS/IAM/Role.ts";
import { Bucket } from "@/AWS/S3/Bucket.ts";
import { Cluster } from "@/AWS/SageMaker";
import * as Test from "@/Test/Alchemy";
import * as s3 from "@distilled.cloud/aws/s3";
import * as sagemaker from "@distilled.cloud/aws/sagemaker";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove describeCluster returns the typed
// ResourceNotFound for a nonexistent HyperPod cluster. Runs in every CI pass.
test.provider(
  "describeCluster on a nonexistent cluster fails with ResourceNotFound",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        sagemaker.describeCluster({
          ClusterName: "alchemy-nonexistent-hyperpod-cluster-probe",
        }),
      );
      expect(error._tag).toBe("ResourceNotFound");
    }),
);

const findCluster = (name: string) =>
  sagemaker
    .describeCluster({ ClusterName: name })
    .pipe(Effect.catchTag("ResourceNotFound", () => Effect.succeed(undefined)));

// A live HyperPod cluster provisions real ML compute and takes 10-25 minutes
// to reach InService (plus several minutes to delete). Gated behind:
//   AWS_TEST_SAGEMAKER_HYPERPOD=1
test.provider.skipIf(!process.env.AWS_TEST_SAGEMAKER_HYPERPOD)(
  "create minimal Slurm HyperPod cluster, wait InService, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { accountId } = yield* AWSEnvironment.current;
      // The AmazonSageMakerClusterInstanceRolePolicy managed policy only
      // grants read access to buckets whose name starts with `sagemaker-`.
      const bucketName = `sagemaker-alchemy-hyperpod-test-${accountId}`;

      const supporting = Effect.gen(function* () {
        const bucket = yield* Bucket("HyperPodLifecycleBucket", {
          bucketName,
          forceDestroy: true,
        });
        const role = yield* Role("HyperPodInstanceRole", {
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
            "arn:aws:iam::aws:policy/AmazonSageMakerClusterInstanceRolePolicy",
          ],
        });
        return { bucket, role };
      });

      // Step 1: bucket + role only — the lifecycle script must exist in S3
      // before cluster creation starts.
      const { bucket } = yield* stack.deploy(supporting);
      yield* s3.putObject({
        Bucket: bucket.bucketName,
        Key: "lifecycle/on_create.sh",
        Body: new TextEncoder().encode(
          '#!/bin/bash\nset -e\necho "alchemy hyperpod on_create complete"\n',
        ),
        ContentType: "text/x-shellscript",
      });

      // Step 2: add the cluster.
      const { cluster } = yield* stack.deploy(
        Effect.gen(function* () {
          const { role } = yield* supporting;
          const cluster = yield* Cluster("TestHyperPod", {
            instanceGroups: {
              controller: {
                InstanceType: "ml.t3.medium",
                InstanceCount: 1,
                ExecutionRole: role.roleArn,
                LifeCycleConfig: {
                  // bucketName is the deterministic string computed above —
                  // interpolating bucket.bucketName here would coerce an
                  // unresolved Output.
                  SourceS3Uri: `s3://${bucketName}/lifecycle`,
                  OnCreate: "on_create.sh",
                },
              },
            },
            nodeRecovery: "None",
            tags: { purpose: "alchemy-test" },
          });
          return { cluster };
        }),
      );

      expect(cluster.clusterArn).toContain(":cluster/");
      expect(cluster.clusterStatus).toBe("InService");

      // Out-of-band verification via distilled.
      const described = yield* findCluster(cluster.clusterName);
      expect(described?.ClusterStatus).toBe("InService");
      expect(
        described?.InstanceGroups?.map((g) => g.InstanceGroupName),
      ).toEqual(["controller"]);

      // Destroy and verify gone.
      yield* stack.destroy();
      const gone = yield* findCluster(cluster.clusterName);
      expect(gone).toBeUndefined();
    }),
  { timeout: 3_600_000 },
);
