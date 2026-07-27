import * as AWS from "@/AWS";
import { Cluster, Hsm } from "@/AWS/CloudHSMV2";
import * as Test from "@/Test/Alchemy";
import * as cloudhsm from "@distilled.cloud/aws/cloudhsm-v2";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated probes: describeClusters is a filtered list — an unknown cluster id
// yields an empty page rather than a typed NotFound. Proves auth + the
// response schema decode in every CI pass at near-zero cost.
test.provider(
  "describeClusters with an unknown cluster id filter returns an empty page",
  () =>
    Effect.gen(function* () {
      const response = yield* cloudhsm.describeClusters({
        Filters: { clusterIds: ["cluster-aaaaaaaaaaa"] },
      });
      expect(response.Clusters ?? []).toHaveLength(0);
    }),
);

// Ungated typed-error probe: prove the distilled union carries the not-found
// tag the provider's delete path depends on.
test.provider(
  "deleteCluster on a nonexistent cluster fails with CloudHsmResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        cloudhsm.deleteCluster({ ClusterId: "cluster-aaaaaaaaaaa" }),
      );
      expect(error._tag).toBe("CloudHsmResourceNotFoundException");
    }),
);

// Resolve two default-for-AZ subnets (distinct AZs) from the default VPC.
const defaultNetwork = Effect.gen(function* () {
  const vpc = yield* getDefaultVpc;
  const subnets = yield* EC2.describeSubnets({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "default-for-az", Values: ["true"] },
    ],
  });
  // CloudHSM is not offered in every AZ — pick subnets from the region's
  // first AZs (suffix a/b) only.
  const picked = (subnets.Subnets ?? [])
    .filter((s) => /[ab]$/.test(s.AvailabilityZone ?? ""))
    .sort((l, r) =>
      (l.AvailabilityZone ?? "").localeCompare(r.AvailabilityZone ?? ""),
    )
    .slice(0, 2);
  const subnetIds = picked
    .map((s) => s.SubnetId)
    .filter((id): id is string => id !== undefined);
  const availabilityZones = picked
    .map((s) => s.AvailabilityZone)
    .filter((az): az is string => az !== undefined);
  if (subnetIds.length < 2) {
    return yield* Effect.die(
      new Error("default VPC is missing default-for-az subnets in AZs a/b"),
    );
  }
  return { subnetIds, availabilityZones };
});

// Deletion is verified as INITIATED (DELETE_IN_PROGRESS, irreversible) or
// fully gone (absent / DELETED).
const assertClusterDeleting = (clusterId: string) =>
  Effect.gen(function* () {
    const response = yield* cloudhsm.describeClusters({
      Filters: { clusterIds: [clusterId] },
    });
    const state = response.Clusters?.[0]?.State ?? "gone";
    if (
      state !== "gone" &&
      state !== "DELETED" &&
      state !== "DELETE_IN_PROGRESS"
    ) {
      return yield* Effect.fail(
        new Error(`cluster '${clusterId}' still exists (state: ${state})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(18),
      ]),
    }),
  );

// A CloudHSM cluster provisions in a few minutes but its HSM takes ~10-20
// minutes and bills hourly while it exists (~$1.45/hr). The full lifecycle is
// gated behind AWS_TEST_CLOUDHSM=1 and always destroys what it created.
test.provider.skipIf(!process.env.AWS_TEST_CLOUDHSM)(
  "create CloudHSM cluster with one HSM, verify, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const network = yield* defaultNetwork;

      const { cluster, hsm } = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* Cluster("HsmCluster", {
            hsmType: "hsm2m.medium",
            subnetIds: network.subnetIds,
            tags: { fixture: "cloudhsm-cluster" },
          });
          const hsm = yield* Hsm("Primary", {
            clusterId: cluster.clusterId,
            availabilityZone: network.availabilityZones[0],
          });
          return { cluster, hsm };
        }),
      );

      expect(cluster.clusterId).toMatch(/^cluster-/);
      expect(["UNINITIALIZED", "INITIALIZED", "ACTIVE", "DEGRADED"]).toContain(
        cluster.state,
      );
      expect(cluster.hsmType).toBe("hsm2m.medium");
      expect(cluster.vpcId).toBeDefined();
      expect(cluster.securityGroup).toBeDefined();
      expect(cluster.subnetIds.length).toBe(2);
      expect(hsm.hsmId).toMatch(/^hsm-/);
      expect(hsm.clusterId).toBe(cluster.clusterId);
      expect(hsm.state).toBe("ACTIVE");
      expect(hsm.eniIp).toBeDefined();

      // Out-of-band verification via distilled.
      const described = yield* cloudhsm.describeClusters({
        Filters: { clusterIds: [cluster.clusterId] },
      });
      const observed = described.Clusters?.[0];
      expect(observed?.ClusterId).toBe(cluster.clusterId);
      expect(observed?.HsmType).toBe("hsm2m.medium");
      expect(
        observed?.TagList?.some(
          (tag) => tag.Key === "fixture" && tag.Value === "cloudhsm-cluster",
        ),
      ).toBe(true);
      expect(observed?.Hsms?.some((h) => h.HsmId === hsm.hsmId)).toBe(true);

      // Destroy immediately — HSMs bill hourly — and verify deletion was
      // initiated out-of-band (HSM first, then cluster).
      yield* stack.destroy();
      yield* assertClusterDeleting(cluster.clusterId);
    }),
  // HSM create (~10-20 min) + HSM delete wait + cluster delete, one test.
  { timeout: 2_400_000 },
);
