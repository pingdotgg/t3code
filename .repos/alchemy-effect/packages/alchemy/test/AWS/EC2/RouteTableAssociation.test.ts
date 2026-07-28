import * as AWS from "@/AWS";
import { RouteTable, RouteTableAssociation, Subnet, Vpc } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import * as Test from "./VpcTest.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { assertVpcGone } from "./Gone.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("list enumerates the deployed RouteTableAssociation", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { vpc, assoc } = yield* stack.deploy(
      Effect.gen(function* () {
        const vpc = yield* Vpc("ListRtbAssocVpc", {
          cidrBlock: "10.0.0.0/16",
        });
        const subnet = yield* Subnet("ListRtbAssocSubnet", {
          vpcId: vpc.vpcId,
          cidrBlock: "10.0.1.0/24",
        });
        const routeTable = yield* RouteTable("ListRtbAssocRt", {
          vpcId: vpc.vpcId,
        });
        const assoc = yield* RouteTableAssociation("ListRtbAssoc", {
          routeTableId: routeTable.routeTableId,
          subnetId: subnet.subnetId,
        });
        return { vpc, subnet, routeTable, assoc };
      }),
    );

    const provider = yield* Provider.findProvider(RouteTableAssociation);
    const all = yield* provider.list();

    expect(all.some((x) => x.associationId === assoc.associationId)).toBe(true);

    yield* stack.destroy();

    // The VPC cannot delete while the subnet/route-table/association exist —
    // VPC-gone proves full teardown.
    yield* assertVpcGone(vpc.vpcId);
  }).pipe(logLevel),
);
