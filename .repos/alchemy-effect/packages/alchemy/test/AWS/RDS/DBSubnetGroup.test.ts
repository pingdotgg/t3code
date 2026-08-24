import * as AWS from "@/AWS";
import { DBSubnetGroup } from "@/AWS/RDS/DBSubnetGroup.ts";
import type { SubnetId } from "@/AWS/EC2/Subnet.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Default read-only path (AWS account/region-scoped collection): resolve the
// provider via the typed `Provider.findProvider(DBSubnetGroup)` so `list()`'s
// element type is the exact `DBSubnetGroup["Attributes"]` shape, then call
// `list()` without deploying. This always runs and exercises the full
// `describeDBSubnetGroups` pagination + Attributes-mapping code, asserting a
// well-typed `Attributes[]`.
//
// We do NOT deploy here because a DB subnet group needs subnets spanning >= 2
// AZs, and the shared testing account has NO default VPC, is at its 5-VPC limit,
// and (verified live) currently exposes only a single available subnet in a
// single AZ — so there is no reusable VPC to carve a multi-AZ group from. The
// deploy-backed assertion is gated below behind AWS_TEST_RDS_DBSUBNETGROUP=1 for
// accounts that have multi-AZ subnets available.
test.provider("list returns well-typed DBSubnetGroup attributes", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(DBSubnetGroup);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    for (const g of all) {
      expect(typeof g.dbSubnetGroupName).toBe("string");
      expect(Array.isArray(g.subnetIds)).toBe(true);
      expect(typeof g.tags).toBe("object");
    }
  }),
);

// Deploy-backed list test. Gated behind AWS_TEST_RDS_DBSUBNETGROUP=1 because a
// DB subnet group requires subnets in >= 2 distinct AZs, which the shared
// testing account cannot provide (no default VPC, at the VPC limit, only one
// available subnet in one AZ). On an account that has multi-AZ subnets, this
// reuses an existing VPC's subnets (subnets don't count against the VPC limit),
// deploys a subnet group, resolves the provider via the typed
// `Provider.findProvider(DBSubnetGroup)`, lists, and asserts presence — all
// bracketed by `stack.destroy()` at start and end.
test.provider.skipIf(!process.env.AWS_TEST_RDS_DBSUBNETGROUP)(
  "list enumerates the deployed DB subnet group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const subnetsResult = yield* EC2.describeSubnets({});
      const available = (subnetsResult.Subnets ?? []).filter(
        (s) =>
          s.State === "available" &&
          !!s.SubnetId &&
          !!s.VpcId &&
          !!s.AvailabilityZone,
      );

      // Group available subnets by VPC, keeping one subnet per AZ, then pick a
      // VPC with subnets in >= 2 distinct AZs.
      const byVpc = new Map<string, Map<string, string>>();
      for (const s of available) {
        let byAz = byVpc.get(s.VpcId!);
        if (!byAz) {
          byAz = new Map();
          byVpc.set(s.VpcId!, byAz);
        }
        if (!byAz.has(s.AvailabilityZone!)) {
          byAz.set(s.AvailabilityZone!, s.SubnetId!);
        }
      }

      let chosen: string[] | undefined;
      for (const byAz of byVpc.values()) {
        if (byAz.size >= 2) {
          chosen = Array.from(byAz.values()).slice(0, 2);
          break;
        }
      }

      if (!chosen) {
        // Exact reason for a clean skip:
        // "no existing VPC has available subnets in >= 2 distinct AZs".
        return yield* Effect.fail(
          new Error(
            "no existing VPC has available subnets in >= 2 distinct AZs",
          ),
        );
      }

      const subnetIds = chosen as SubnetId[];

      const group = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DBSubnetGroup("ListDBSubnetGroup", {
            dbSubnetGroupName: "alchemy-test-dbsng-list",
            description: "Alchemy list() test subnet group",
            subnetIds,
          });
        }),
      );

      const provider = yield* Provider.findProvider(DBSubnetGroup);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      expect(
        all.some((g) => g.dbSubnetGroupName === group.dbSubnetGroupName),
      ).toBe(true);

      yield* stack.destroy();
    }),
);
