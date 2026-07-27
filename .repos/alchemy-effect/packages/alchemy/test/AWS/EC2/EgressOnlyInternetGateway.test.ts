import * as AWS from "@/AWS";
import { EgressOnlyInternetGateway, Vpc } from "@/AWS/EC2";
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

test.provider(
  "list enumerates the deployed Egress-Only Internet Gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { vpc, eigw } = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("ListEigwVpc", {
            cidrBlock: "10.0.0.0/16",
          });
          const eigw = yield* EgressOnlyInternetGateway("ListEigw", {
            vpcId: vpc.vpcId,
          });
          return { vpc, eigw };
        }),
      );

      const provider = yield* Provider.findProvider(EgressOnlyInternetGateway);
      const all = yield* provider.list();

      expect(
        all.some(
          (x) =>
            x.egressOnlyInternetGatewayId === eigw.egressOnlyInternetGatewayId,
        ),
      ).toBe(true);

      yield* stack.destroy();

      // The VPC cannot delete while the egress-only IGW exists, so VPC-gone
      // proves the whole stack (EIGW included) was torn down.
      yield* assertVpcGone(vpc.vpcId);
    }).pipe(logLevel),
);
