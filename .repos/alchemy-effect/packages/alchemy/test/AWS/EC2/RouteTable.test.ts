import * as AWS from "@/AWS";
import { RouteTable, Vpc } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import * as Test from "./VpcTest.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { assertRouteTableGone, assertVpcGone } from "./Gone.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider(
  "list enumerates the deployed RouteTable",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { vpc, routeTable } = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("ListRouteTableVpc", {
            cidrBlock: "10.0.0.0/16",
          });
          const routeTable = yield* RouteTable("ListRouteTable", {
            vpcId: vpc.vpcId,
          });
          return { vpc, routeTable };
        }),
      );

      const provider = yield* Provider.findProvider(RouteTable);
      const all = yield* provider.list();

      expect(all.some((x) => x.routeTableId === routeTable.routeTableId)).toBe(
        true,
      );

      yield* stack.destroy();

      yield* assertRouteTableGone(routeTable.routeTableId);
      yield* assertVpcGone(vpc.vpcId);
    }).pipe(logLevel),
  // VPC + RouteTable create, an account-wide DescribeRouteTables, then two
  // destroys (with VPC dependency-ordered teardown) can exceed the default
  // 120s under full-suite EC2 throttling load. All waits are bounded; give
  // the end-to-end run headroom. (Observed blowing 180s during a full-suite
  // run where concurrent EC2 suites saturated the account's request budget
  // and VPC quota; a timeout mid-destroy also leaks the VPC.)
  { timeout: 300_000 },
);
