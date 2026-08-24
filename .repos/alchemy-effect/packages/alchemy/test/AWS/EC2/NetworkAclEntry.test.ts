import * as AWS from "@/AWS";
import { NetworkAcl, NetworkAclEntry, Vpc } from "@/AWS/EC2";
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

test.provider("list enumerates the deployed Network ACL Entry", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { vpc, entry } = yield* stack.deploy(
      Effect.gen(function* () {
        const vpc = yield* Vpc("ListNaclEntryVpc", {
          cidrBlock: "10.0.0.0/16",
        });
        const acl = yield* NetworkAcl("ListNaclEntryAcl", {
          vpcId: vpc.vpcId,
        });
        const entry = yield* NetworkAclEntry("ListNaclEntry", {
          networkAclId: acl.networkAclId,
          ruleNumber: 100,
          protocol: "6",
          ruleAction: "allow",
          egress: false,
          cidrBlock: "0.0.0.0/0",
          portRange: { from: 443, to: 443 },
        });
        return { vpc, acl, entry };
      }),
    );

    const provider = yield* Provider.findProvider(NetworkAclEntry);
    const all = yield* provider.list();

    expect(
      all.some(
        (x) =>
          x.networkAclId === entry.networkAclId &&
          x.ruleNumber === entry.ruleNumber &&
          x.egress === entry.egress,
      ),
    ).toBe(true);

    yield* stack.destroy();

    // The VPC cannot delete while the ACL (and its entries) exists — VPC-gone
    // proves full teardown.
    yield* assertVpcGone(vpc.vpcId);
  }).pipe(logLevel),
);
