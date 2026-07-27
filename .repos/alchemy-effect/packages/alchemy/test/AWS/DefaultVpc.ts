import { VpcId } from "@/AWS/EC2";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

class DefaultVpcNotVisible extends Data.TaggedError(
  "DefaultVpcNotVisible",
)<{}> {}

class DefaultVpcNetworkNotVisible extends Data.TaggedError(
  "DefaultVpcNetworkNotVisible",
)<{}> {}

class UnsupportedDefaultVpcCidr extends Data.TaggedError(
  "UnsupportedDefaultVpcCidr",
)<{
  readonly cidrBlock: string;
}> {}

export const getDefaultVpc = Effect.gen(function* () {
  const vpcs = yield* EC2.describeVpcs({});
  const vpc = (vpcs.Vpcs ?? []).find((v) => v.IsDefault);
  if (!vpc?.VpcId || !vpc.CidrBlock) {
    // The default VPC can be deleted out of band (e.g. by the account nuke
    // script). Recreate it, then fail with the retryable marker so the retry
    // loop below re-describes until it becomes visible. Concurrent test files
    // racing on the same recreate surface DefaultVpcAlreadyExists — that just
    // means someone else won the race, so fall through to the retry.
    yield* EC2.createDefaultVpc({}).pipe(
      Effect.catchTag("DefaultVpcAlreadyExists", () => Effect.void),
    );
    return yield* Effect.fail(new DefaultVpcNotVisible());
  }

  const [baseAddress, prefixString] = vpc.CidrBlock.split("/");
  if (prefixString !== "16") {
    return yield* Effect.fail(
      new UnsupportedDefaultVpcCidr({ cidrBlock: vpc.CidrBlock }),
    );
  }

  const [a, b] = baseAddress.split(".");
  return {
    vpcId: VpcId(vpc.VpcId),
    cidrBlock: vpc.CidrBlock,
    subnetCidrBlock: (thirdOctet: number) => `${a}.${b}.${thirdOctet}.0/24`,
  };
}).pipe(
  Effect.retry({
    while: (e) => e._tag === "DefaultVpcNotVisible",
    schedule: Schedule.max([Schedule.spaced("3 seconds"), Schedule.recurs(10)]),
  }),
);

/** Wait for the default VPC's generated subnets and security group as well. */
export const getDefaultVpcNetwork = Effect.gen(function* () {
  const vpc = yield* getDefaultVpc;
  const [subnets, groups] = yield* Effect.all(
    [
      EC2.describeSubnets({
        Filters: [{ Name: "vpc-id", Values: [vpc.vpcId] }],
      } as any),
      EC2.describeSecurityGroups({
        Filters: [
          { Name: "vpc-id", Values: [vpc.vpcId] },
          { Name: "group-name", Values: ["default"] },
        ],
      } as any),
    ],
    { concurrency: 2 },
  );
  const subnetIds = (subnets.Subnets ?? [])
    .flatMap((subnet) => (subnet.SubnetId ? [subnet.SubnetId] : []))
    .sort();
  const defaultSecurityGroupId = groups.SecurityGroups?.[0]?.GroupId;
  if (subnetIds.length === 0 || !defaultSecurityGroupId) {
    return yield* Effect.fail(new DefaultVpcNetworkNotVisible());
  }
  return { ...vpc, subnetIds, defaultSecurityGroupId };
}).pipe(
  Effect.retry({
    while: (error) => error._tag === "DefaultVpcNetworkNotVisible",
    schedule: Schedule.max([Schedule.fixed("1 second"), Schedule.recurs(30)]),
  }),
);
