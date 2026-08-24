import * as AWS from "@/AWS";
import { Cluster } from "@/AWS/EKS";
import { VirtualCluster } from "@/AWS/EMRContainers";
import { Role } from "@/AWS/IAM";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as emrc from "@distilled.cloud/aws/emr-containers";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Deterministic names — same on every run of the test case.
const EKS_CLUSTER_NAME = "alchemy-test-emrc-eks";
const VC_NAME = "alchemy-test-emrc-vc";

// Ungated typed-error probe: proves the tags the observe/read/delete paths
// depend on. describeVirtualCluster on a well-formed nonexistent id must
// surface the typed ResourceNotFoundException; deleteVirtualCluster on the
// same id must surface the typed ValidationException the idempotent delete
// path swallows (its typed union has no not-found tag — the API reports
// missing/terminated ids as validation errors).
test.provider("typed error semantics on a nonexistent virtual cluster", () =>
  Effect.gen(function* () {
    const id = "abcdefabcdefabcdefabcdef01";

    const describeError = yield* Effect.flip(
      emrc.describeVirtualCluster({ id }),
    );
    expect(describeError._tag).toBe("ResourceNotFoundException");

    const deleteError = yield* Effect.flip(emrc.deleteVirtualCluster({ id }));
    expect(deleteError._tag).toBe("ValidationException");
  }),
);

// Ungated typed-error probe for the job-run data plane the VC-scoped
// bindings (DescribeJobRun / CancelJobRun / ListJobRuns) call: each op on a
// well-formed nonexistent virtual cluster id must surface a typed tag from
// its inferred error union — never a catch-all. Observed live: the API
// reports job-run-addressed ops on a nonexistent virtual cluster as
// validation errors, and ListJobRuns succeeds with an empty page.
// (StartJobRun's tag depends on the caller's IAM scope — AccessDenied for
// unauthorized arbitrary cluster ARNs — so it is not asserted here; the
// binding grants on the bound cluster's ARN.)
test.provider("typed error semantics for job run ops on a nonexistent vc", () =>
  Effect.gen(function* () {
    const virtualClusterId = "abcdefabcdefabcdefabcdef01";
    const jobRunId = "abcdefabcdefabcdefa";

    const describeError = yield* Effect.flip(
      emrc.describeJobRun({ id: jobRunId, virtualClusterId }),
    );
    expect(describeError._tag).toBe("ValidationException");

    const cancelError = yield* Effect.flip(
      emrc.cancelJobRun({ id: jobRunId, virtualClusterId }),
    );
    expect(cancelError._tag).toBe("ValidationException");

    const list = yield* emrc.listJobRuns({ virtualClusterId });
    expect(list.jobRuns ?? []).toHaveLength(0);
  }),
);

// Ungated list() probe: enumerates live virtual clusters in the ambient
// account/region — proves the pagination + attribute mapping wiring without
// needing an EKS cluster.
test.provider("list returns a well-formed array of virtual clusters", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(VirtualCluster);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    for (const vc of all) {
      expect(typeof vc.virtualClusterId).toBe("string");
      expect(typeof vc.virtualClusterName).toBe("string");
      expect(vc.virtualClusterArn).toContain(":/virtualclusters/");
    }
  }),
);

// Full lifecycle: a virtual cluster itself is free and provisions instantly,
// but it requires a live EKS cluster (~10 min control-plane create + ~5 min
// delete), so the whole path is gated behind AWS_TEST_SLOW=1. The EKS cluster
// uses API authentication mode so EMR on EKS registers its access entries
// automatically — no kubectl/aws-auth step.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "virtual cluster lifecycle on a live EKS cluster (AWS_TEST_SLOW=1)",
  (stack) =>
    Effect.gen(function* () {
      // Clean slate in case a previous run died mid-flight.
      yield* stack.destroy();

      // Default-VPC subnets in >= 2 AZs (never create NAT gateways).
      const subnetsResult = yield* ec2.describeSubnets({
        Filters: [{ Name: "default-for-az", Values: ["true"] }],
      });
      const byAz = new Map<string, string>();
      for (const s of subnetsResult.Subnets ?? []) {
        if (s.State === "available" && s.SubnetId && s.AvailabilityZone) {
          if (!byAz.has(s.AvailabilityZone)) {
            byAz.set(s.AvailabilityZone, s.SubnetId);
          }
        }
      }
      const subnetIds = Array.from(byAz.values()).slice(0, 3);
      expect(subnetIds.length).toBeGreaterThanOrEqual(2);

      const vc = yield* stack.deploy(
        Effect.gen(function* () {
          const clusterRole = yield* Role("EksRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "eks.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            managedPolicyArns: [
              "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
            ],
          });
          const cluster = yield* Cluster("Cluster", {
            clusterName: EKS_CLUSTER_NAME,
            roleArn: clusterRole.roleArn,
            resourcesVpcConfig: { subnetIds },
            accessConfig: { authenticationMode: "API_AND_CONFIG_MAP" },
          });
          return yield* VirtualCluster("VC", {
            virtualClusterName: VC_NAME,
            containerProvider: {
              id: cluster.clusterName,
              info: { eksInfo: { namespace: "default" } },
            },
          });
        }),
      );

      expect(vc.virtualClusterName).toBe(VC_NAME);
      expect(vc.eksClusterName).toBe(EKS_CLUSTER_NAME);
      expect(vc.state).toBe("RUNNING");

      // Out-of-band verification via distilled.
      const observed = yield* emrc.describeVirtualCluster({
        id: vc.virtualClusterId,
      });
      expect(observed.virtualCluster?.name).toBe(VC_NAME);
      expect(observed.virtualCluster?.containerProvider?.id).toBe(
        EKS_CLUSTER_NAME,
      );

      // Destroy immediately and verify the virtual cluster terminated.
      yield* stack.destroy();
      yield* assertVirtualClusterGone(vc.virtualClusterId);
    }),
  { timeout: 1_800_000 },
);

const assertVirtualClusterGone = (id: string) =>
  Effect.gen(function* () {
    const state = yield* emrc.describeVirtualCluster({ id }).pipe(
      Effect.map((response) => response.virtualCluster?.state ?? "gone"),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed("gone"),
      ),
    );
    if (state !== "gone" && state !== "TERMINATED" && state !== "TERMINATING") {
      return yield* Effect.fail(
        new Error(`virtual cluster ${id} still exists (${state})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(12),
      ]),
    }),
  );
