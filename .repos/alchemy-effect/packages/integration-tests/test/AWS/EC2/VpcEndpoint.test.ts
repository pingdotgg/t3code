import * as AWS from "@alchemy.run/aws";
import { RouteTable, Vpc, VpcEndpoint } from "@alchemy.run/aws/EC2";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { assertVpcGone } from "./Gone.ts";
import * as Test from "./VpcTest.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

test.provider(
  "list enumerates the deployed VpcEndpoint",
  (stack) =>
    Effect.gen(function* () {
      const { region } = yield* AWSEnvironment.current;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("ListVpceVpc", { cidrBlock: "10.0.0.0/16" });
          const routeTable = yield* RouteTable("ListVpceRouteTable", { vpcId: vpc.vpcId });
          const endpoint = yield* VpcEndpoint("ListVpceEndpoint", {
            vpcId: vpc.vpcId,
            serviceName: `com.amazonaws.${region}.s3`,
            vpcEndpointType: "Gateway",
            routeTableIds: [routeTable.routeTableId],
          });
          return { vpc, endpoint };
        }),
      );

      const provider = yield* Provider.findProvider(VpcEndpoint);
      const all = yield* provider.list();

      expect(all.some((x) => x.vpcEndpointId === deployed.endpoint.vpcEndpointId)).toBe(true);

      yield* stack.destroy();

      // The VPC cannot delete while the endpoint or route table exist —
      // VPC-gone proves full teardown.
      yield* assertVpcGone(deployed.vpc.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"] },
);
