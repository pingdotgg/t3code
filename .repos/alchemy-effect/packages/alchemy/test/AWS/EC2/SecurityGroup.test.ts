import * as AWS from "@/AWS";
import { SecurityGroup, Vpc } from "@/AWS/EC2";
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

test.provider("list enumerates the deployed Security Group", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { vpc, sg } = yield* stack.deploy(
      Effect.gen(function* () {
        const vpc = yield* Vpc("ListSgVpc", {
          cidrBlock: "10.0.0.0/16",
        });
        const sg = yield* SecurityGroup("ListSg", {
          vpcId: vpc.vpcId,
        });
        return { vpc, sg };
      }),
    );

    const provider = yield* Provider.findProvider(SecurityGroup);
    const all = yield* provider.list();

    expect(all.some((x) => x.groupId === sg.groupId)).toBe(true);

    yield* stack.destroy();

    yield* assertSecurityGroupGone(sg.groupId);
    yield* assertVpcGone(vpc.vpcId);
  }).pipe(logLevel),
);
