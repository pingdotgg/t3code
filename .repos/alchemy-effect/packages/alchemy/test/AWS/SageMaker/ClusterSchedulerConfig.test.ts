import * as AWS from "@/AWS";
import { ClusterSchedulerConfig } from "@/AWS/SageMaker";
import * as Test from "@/Test/Alchemy";
import * as sagemaker from "@distilled.cloud/aws/sagemaker";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove describeClusterSchedulerConfig returns
// the typed ResourceNotFound for a nonexistent policy id.
test.provider(
  "describeClusterSchedulerConfig on a nonexistent id fails with ResourceNotFound",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        sagemaker.describeClusterSchedulerConfig({
          ClusterSchedulerConfigId: "abcdef012345",
        }),
      );
      expect(error._tag).toBe("ResourceNotFound");
    }),
);

const findConfig = (configId: string) =>
  sagemaker
    .describeClusterSchedulerConfig({ ClusterSchedulerConfigId: configId })
    .pipe(Effect.catchTag("ResourceNotFound", () => Effect.succeed(undefined)));

// Cluster policies require an EKS-orchestrated HyperPod cluster, which takes
// ~30 minutes and real ML + EKS capacity to stand up. Gated behind an
// existing cluster:
//   AWS_TEST_SAGEMAKER_HYPERPOD_EKS_CLUSTER_ARN=<arn of an EKS HyperPod cluster>
//
// AWS allows ONE cluster policy per cluster. When the provided cluster
// already carries one (e.g. the examples/aws-hyperpod stack's), this test
// verifies the typed conflict instead of the full lifecycle.
test.provider.skipIf(!process.env.AWS_TEST_SAGEMAKER_HYPERPOD_EKS_CLUSTER_ARN)(
  "create cluster policy, update it, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const clusterArn =
        process.env.AWS_TEST_SAGEMAKER_HYPERPOD_EKS_CLUSTER_ARN!;

      const existing = yield* sagemaker.listClusterSchedulerConfigs({
        ClusterArn: clusterArn,
      });
      if (
        (existing.ClusterSchedulerConfigSummaries ?? []).some(
          (s) => s.Status !== "Deleted",
        )
      ) {
        // One policy per cluster: creating a second must fail with the
        // typed ClusterSchedulerConfigAlreadyExists tag.
        const error = yield* Effect.flip(
          sagemaker.createClusterSchedulerConfig({
            Name: "alchemy-conflict-probe",
            ClusterArn: clusterArn,
            SchedulerConfig: { FairShare: "Enabled" },
          }),
        );
        expect(error._tag).toBe("ClusterSchedulerConfigAlreadyExists");
        return;
      }

      const { policy } = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* ClusterSchedulerConfig("TestPolicy", {
            clusterArn,
            schedulerConfig: {
              PriorityClasses: [{ Name: "training", Weight: 75 }],
              FairShare: "Enabled",
            },
            description: "alchemy test policy",
            tags: { purpose: "alchemy-test" },
          });
          return { policy };
        }),
      );

      expect(policy.clusterSchedulerConfigArn).toContain(
        ":cluster-scheduler-config/",
      );
      expect(policy.clusterArn).toBe(clusterArn);

      // Out-of-band verification via distilled.
      const described = yield* findConfig(policy.clusterSchedulerConfigId);
      expect(described?.Status).toBe("Created");
      expect(described?.SchedulerConfig?.PriorityClasses).toEqual([
        { Name: "training", Weight: 75 },
      ]);

      // Update in place — the id must remain stable and the version bump.
      const { policy: updated } = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* ClusterSchedulerConfig("TestPolicy", {
            clusterArn,
            schedulerConfig: {
              PriorityClasses: [
                { Name: "inference", Weight: 100 },
                { Name: "training", Weight: 75 },
              ],
              FairShare: "Enabled",
            },
            description: "alchemy test policy v2",
            tags: { purpose: "alchemy-test" },
          });
          return { policy };
        }),
      );
      expect(updated.clusterSchedulerConfigId).toBe(
        policy.clusterSchedulerConfigId,
      );
      expect(updated.clusterSchedulerConfigVersion).toBeGreaterThan(
        policy.clusterSchedulerConfigVersion,
      );

      // Destroy and verify gone.
      yield* stack.destroy();
      const gone = yield* findConfig(policy.clusterSchedulerConfigId);
      expect(gone === undefined || gone.Status === "Deleted").toBe(true);
    }),
  { timeout: 600_000 },
);
