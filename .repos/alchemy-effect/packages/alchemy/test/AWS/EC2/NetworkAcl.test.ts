import * as AWS from "@/AWS";
import { NetworkAcl, Vpc } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import * as Test from "./VpcTest.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { assertNetworkAclGone, assertVpcGone } from "./Gone.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("list enumerates the deployed Network ACL", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { vpc, acl } = yield* stack.deploy(
      Effect.gen(function* () {
        const vpc = yield* Vpc("ListNaclVpc", {
          cidrBlock: "10.0.0.0/16",
        });
        const acl = yield* NetworkAcl("ListNacl", {
          vpcId: vpc.vpcId,
        });
        return { vpc, acl };
      }),
    );

    const provider = yield* Provider.findProvider(NetworkAcl);
    const all = yield* provider.list();

    expect(all.some((x) => x.networkAclId === acl.networkAclId)).toBe(true);

    yield* stack.destroy();

    yield* assertNetworkAclGone(acl.networkAclId);
    yield* assertVpcGone(vpc.vpcId);
  }).pipe(logLevel),
);
