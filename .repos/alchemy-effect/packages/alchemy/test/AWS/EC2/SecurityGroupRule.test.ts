import * as AWS from "@/AWS";
import { SecurityGroup, SecurityGroupRule, Vpc } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import * as Test from "./VpcTest.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { assertSecurityGroupGone, assertVpcGone } from "./Gone.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("list enumerates the deployed Security Group Rule", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { vpc, sg, rule } = yield* stack.deploy(
      Effect.gen(function* () {
        const vpc = yield* Vpc("ListSgrVpc", {
          cidrBlock: "10.0.0.0/16",
        });
        const sg = yield* SecurityGroup("ListSgrSg", {
          vpcId: vpc.vpcId,
        });
        const rule = yield* SecurityGroupRule("ListSgr", {
          groupId: sg.groupId,
          type: "ingress",
          ipProtocol: "tcp",
          fromPort: 443,
          toPort: 443,
          cidrIpv4: "10.0.0.0/16",
        });
        return { vpc, sg, rule };
      }),
    );

    const provider = yield* Provider.findProvider(SecurityGroupRule);
    const all = yield* provider.list();

    expect(
      all.some((x) => x.securityGroupRuleId === rule.securityGroupRuleId),
    ).toBe(true);

    yield* stack.destroy();

    // The rule dies with its security group; group + VPC gone proves full
    // teardown.
    yield* assertSecurityGroupGone(sg.groupId);
    yield* assertVpcGone(vpc.vpcId);
  }).pipe(logLevel),
);
