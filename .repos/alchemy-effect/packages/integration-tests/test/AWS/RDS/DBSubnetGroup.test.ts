import * as AWS from "@alchemy.run/aws";
import type { SubnetId } from "@alchemy.run/aws/EC2/Subnet";
import { DBSubnetGroup } from "@alchemy.run/aws/RDS/DBSubnetGroup";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as RDS from "@distilled.cloud/aws/rds";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { driftOf, repairDrift, waitForDrift } from "../drift.ts";

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
test.provider(
  "list returns well-typed DBSubnetGroup attributes",
  () =>
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
  { tags: ["provider:aws", "provider:aws:rds", "live"] },
);

// Deploy-backed list test. A DB subnet group requires subnets in >= 2
// distinct AZs; the account's DEFAULT VPC provides one default subnet per AZ
// (subnets don't count against the VPC limit, and the default VPC is never
// torn down by a concurrent suite). Deploys a subnet group over two of them,
// resolves the provider via the typed `Provider.findProvider(DBSubnetGroup)`,
// lists, and asserts presence — bracketed by `stack.destroy()`.
test.provider(
  "list enumerates the deployed DB subnet group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const subnetsResult = yield* EC2.describeSubnets({
        Filters: [{ Name: "default-for-az", Values: ["true"] }],
      });
      const available = (subnetsResult.Subnets ?? []).filter(
        (s) => s.State === "available" && !!s.SubnetId && !!s.VpcId && !!s.AvailabilityZone,
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
        // "the default VPC has no available subnets in >= 2 distinct AZs".
        return yield* Effect.fail(
          new Error("the default VPC has no available subnets in >= 2 distinct AZs"),
        );
      }

      const subnetIds = chosen as SubnetId[];

      const group = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DBSubnetGroup("ListDBSubnetGroup", {
            description: "Alchemy list() test subnet group",
            subnetIds,
            tags: { team: "declared" },
          });
        }),
      );

      // #2688: `read` must observe the live tags, not carry the persisted
      // ones.
      expect((yield* driftOf(stack, "ListDBSubnetGroup"))?.action).toBe("unchanged");
      yield* RDS.addTagsToResource({
        ResourceName: group.dbSubnetGroupArn!,
        Tags: [{ Key: "team", Value: "out-of-band" }],
      });
      expect((yield* waitForDrift(stack, "ListDBSubnetGroup", "drifted"))?.attr?.tags?.team).toBe(
        "out-of-band",
      );
      yield* repairDrift(stack);
      expect((yield* driftOf(stack, "ListDBSubnetGroup"))?.action).toBe("unchanged");
      const tags = yield* RDS.listTagsForResource({ ResourceName: group.dbSubnetGroupArn! });
      expect(tags.TagList?.find((t) => t.Key === "team")?.Value).toBe("declared");

      const provider = yield* Provider.findProvider(DBSubnetGroup);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      expect(all.some((g) => g.dbSubnetGroupName === group.dbSubnetGroupName)).toBe(true);

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:ec2", "provider:aws:rds", "live"] },
);
