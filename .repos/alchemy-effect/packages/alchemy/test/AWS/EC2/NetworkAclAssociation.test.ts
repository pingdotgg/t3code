import * as AWS from "@/AWS";
import { NetworkAcl, NetworkAclAssociation, Subnet } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../DefaultVpc.ts";
import { assertNetworkAclGone, assertSubnetGone } from "./Gone.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class NetworkAclAssociationNotListed extends Data.TaggedError(
  "NetworkAclAssociationNotListed",
)<{}> {}

test.provider("list enumerates the deployed NetworkAclAssociation", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const defaultVpc = yield* getDefaultVpc;
    const { subnet, acl, assoc } = yield* stack.deploy(
      Effect.gen(function* () {
        const subnet = yield* Subnet("ListNaclAssocSubnet", {
          vpcId: defaultVpc.vpcId,
          cidrBlock: defaultVpc.subnetCidrBlock(221),
        });
        const acl = yield* NetworkAcl("ListNaclAssocAcl", {
          vpcId: defaultVpc.vpcId,
        });
        const assoc = yield* NetworkAclAssociation("ListNaclAssoc", {
          networkAclId: acl.networkAclId,
          subnetId: subnet.subnetId,
        });
        return { subnet, acl, assoc };
      }),
    );

    const provider = yield* Provider.findProvider(NetworkAclAssociation);
    const all = yield* provider.list().pipe(
      Effect.flatMap((all) =>
        all.some((x) => x.associationId === assoc.associationId)
          ? Effect.succeed(all)
          : Effect.fail(new NetworkAclAssociationNotListed()),
      ),
      Effect.retry({
        while: (e) => e._tag === "NetworkAclAssociationNotListed",
        schedule: Schedule.max([
          Schedule.spaced("3 seconds"),
          Schedule.recurs(10),
        ]),
      }),
    );

    expect(all.some((x) => x.associationId === assoc.associationId)).toBe(true);

    yield* stack.destroy();

    // The default VPC is shared/standing — assert the resources this test
    // created inside it (subnet + ACL, whose deletion also proves the
    // association was released) are gone.
    yield* assertNetworkAclGone(acl.networkAclId);
    yield* assertSubnetGone(subnet.subnetId);
  }).pipe(logLevel),
);
