import * as AWS from "@/AWS";
import { Nodegroup } from "@/AWS/EKS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as eks from "@distilled.cloud/aws/eks";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: `describeNodegroup` against a cluster that does not
// exist must surface the `ResourceNotFoundException` tag that the provider's
// read/reconcile/delete paths catch. This proves the distilled error union is
// correct without needing a ~10-minute EKS cluster.
test.provider(
  "describeNodegroup on a nonexistent cluster fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        eks.describeNodegroup({
          clusterName: "alchemy-nonexistent-cluster-probe",
          nodegroupName: "alchemy-nonexistent-nodegroup-probe",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// Ungated `list()` probe: enumerates every cluster, lists each cluster's node
// groups, then hydrates each via `describeNodegroup`. Requires no deployed
// resource — returns `[]` in a clean account/region, otherwise a well-formed
// array of full Nodegroup Attributes. Proves the enumeration wiring compiles
// and runs live.
test.provider("list returns a well-formed array of node groups", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const provider = yield* Provider.findProvider(Nodegroup);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    for (const nodegroup of all) {
      expect(typeof nodegroup.nodegroupArn).toBe("string");
      expect(typeof nodegroup.nodegroupName).toBe("string");
      expect(typeof nodegroup.clusterName).toBe("string");
      expect(typeof nodegroup.nodeRole).toBe("string");
      expect(Array.isArray(nodegroup.subnets)).toBe(true);
      expect(Array.isArray(nodegroup.instanceTypes)).toBe(true);
    }
  }),
);

// Full deploy lifecycle. An EKS cluster + managed node group takes 5+ minutes to
// provision, far beyond the routine test budget. Gate behind a pre-existing
// cluster supplied via AWS_TEST_EKS_CLUSTER (+ the node IAM role ARN and two
// private subnet IDs); an entitled account with a standing cluster runs this
// unchanged. Deploys a node group, waits for ACTIVE, updates its scaling
// config, then tears down and asserts it is gone.
test.provider.skipIf(!process.env.AWS_TEST_EKS_CLUSTER)(
  "creates, scales, and deletes a managed node group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const clusterName = process.env.AWS_TEST_EKS_CLUSTER!;
      const nodeRole = process.env.AWS_TEST_EKS_NODE_ROLE_ARN!;
      const subnets = (process.env.AWS_TEST_EKS_PRIVATE_SUBNETS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Nodegroup("TestNodegroup", {
            clusterName,
            nodeRole,
            subnets,
            instanceTypes: ["t3.medium"],
            scalingConfig: { minSize: 1, maxSize: 2, desiredSize: 1 },
          });
        }),
      );
      expect(created.status).toBe("ACTIVE");
      expect(created.scalingConfig?.desiredSize).toBe(1);

      const scaled = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Nodegroup("TestNodegroup", {
            clusterName,
            nodeRole,
            subnets,
            instanceTypes: ["t3.medium"],
            scalingConfig: { minSize: 1, maxSize: 3, desiredSize: 2 },
          });
        }),
      );
      expect(scaled.status).toBe("ACTIVE");
      expect(scaled.scalingConfig?.desiredSize).toBe(2);

      yield* stack.destroy();

      const gone = yield* eks
        .describeNodegroup({
          clusterName,
          nodegroupName: created.nodegroupName,
        })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
      expect(gone).toBe(true);
    }),
  { timeout: 900_000 },
);
