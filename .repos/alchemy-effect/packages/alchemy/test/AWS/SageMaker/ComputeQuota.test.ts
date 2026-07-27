import * as AWS from "@/AWS";
import { ComputeQuota } from "@/AWS/SageMaker";
import * as Test from "@/Test/Alchemy";
import * as sagemaker from "@distilled.cloud/aws/sagemaker";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove describeComputeQuota returns the typed
// ResourceNotFound for a nonexistent quota id.
test.provider(
  "describeComputeQuota on a nonexistent id fails with ResourceNotFound",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        sagemaker.describeComputeQuota({
          ComputeQuotaId: "abcdef012345",
        }),
      );
      expect(error._tag).toBe("ResourceNotFound");
    }),
);

const findQuota = (quotaId: string) =>
  sagemaker
    .describeComputeQuota({ ComputeQuotaId: quotaId })
    .pipe(Effect.catchTag("ResourceNotFound", () => Effect.succeed(undefined)));

// Compute quotas require an EKS-orchestrated HyperPod cluster, which takes
// ~30 minutes and real ML + EKS capacity to stand up. Gated behind an
// existing cluster:
//   AWS_TEST_SAGEMAKER_HYPERPOD_EKS_CLUSTER_ARN=<arn of an EKS HyperPod cluster>
test.provider.skipIf(!process.env.AWS_TEST_SAGEMAKER_HYPERPOD_EKS_CLUSTER_ARN)(
  "create compute quota, update it, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const clusterArn =
        process.env.AWS_TEST_SAGEMAKER_HYPERPOD_EKS_CLUSTER_ARN!;

      const { quota } = yield* stack.deploy(
        Effect.gen(function* () {
          const quota = yield* ComputeQuota("TestQuota", {
            clusterArn,
            computeQuotaTarget: {
              TeamName: "alchemy-research",
              FairShareWeight: 10,
            },
            computeQuotaConfig: {
              ComputeQuotaResources: [
                { InstanceType: "ml.t3.medium", Count: 1 },
              ],
            },
            activationState: "Enabled",
            tags: { purpose: "alchemy-test" },
          });
          return { quota };
        }),
      );

      expect(quota.computeQuotaArn).toContain(":compute-quota/");
      expect(quota.clusterArn).toBe(clusterArn);

      // Out-of-band verification via distilled.
      const described = yield* findQuota(quota.computeQuotaId);
      expect(described?.Status).toBe("Created");
      expect(described?.ComputeQuotaTarget?.TeamName).toBe("alchemy-research");

      // Update in place — the id must remain stable and the version bump.
      const { quota: updated } = yield* stack.deploy(
        Effect.gen(function* () {
          const quota = yield* ComputeQuota("TestQuota", {
            clusterArn,
            computeQuotaTarget: {
              TeamName: "alchemy-research",
              FairShareWeight: 20,
            },
            computeQuotaConfig: {
              ComputeQuotaResources: [
                { InstanceType: "ml.t3.medium", Count: 2 },
              ],
            },
            activationState: "Enabled",
            tags: { purpose: "alchemy-test" },
          });
          return { quota };
        }),
      );
      expect(updated.computeQuotaId).toBe(quota.computeQuotaId);
      expect(updated.computeQuotaVersion).toBeGreaterThan(
        quota.computeQuotaVersion,
      );

      // Destroy and verify gone.
      yield* stack.destroy();
      const gone = yield* findQuota(quota.computeQuotaId);
      expect(gone === undefined || gone.Status === "Deleted").toBe(true);
    }),
  { timeout: 600_000 },
);
