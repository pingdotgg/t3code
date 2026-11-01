import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../DefaultVpc.ts";

class DefaultSubnetNotVisible extends Data.TaggedError(
  "DefaultSubnetNotVisible",
)<{}> {}

/**
 * Resolve the newest Amazon Linux 2023 AMI id out-of-band via distilled
 * `ec2.describeImages`, for launch templates created directly with the raw
 * SDK (outside `stack.deploy`, where the `amazonLinux2023()` Output would be
 * resolved by the engine). Launch templates do not validate the AMI at
 * creation time, so fall back to a syntactically valid id when the lookup
 * returns nothing.
 */
export const getTestAmiId: Effect.Effect<string, any, any> = ec2
  .describeImages({
    Owners: ["amazon"],
    Filters: [
      { Name: "name", Values: ["al2023-ami-2023.*"] },
      { Name: "architecture", Values: ["x86_64"] },
      { Name: "state", Values: ["available"] },
      { Name: "root-device-type", Values: ["ebs"] },
      { Name: "virtualization-type", Values: ["hvm"] },
    ],
  })
  .pipe(
    Effect.map(
      (response) =>
        (response.Images ?? [])
          .slice()
          .sort((a, b) =>
            String(b.CreationDate ?? "").localeCompare(
              String(a.CreationDate ?? ""),
            ),
          )[0]?.ImageId ?? "ami-00000000000000000",
    ),
  );

/**
 * Resolve one deterministic subnet from the standing default VPC. The account
 * nuke may remove that VPC, and CreateDefaultVpc can return before its default
 * subnets are queryable, so restore it and wait for subnet readiness boundedly.
 */
export const getAutoScalingTestSubnetId: Effect.Effect<
  `subnet-${string}`,
  any,
  any
> = Effect.gen(function* () {
  const { vpcId } = yield* getDefaultVpc;
  const response = yield* ec2.describeSubnets({
    Filters: [
      { Name: "vpc-id", Values: [vpcId] },
      { Name: "default-for-az", Values: ["true"] },
    ],
  } as any);
  const subnetId = (response.Subnets ?? [])
    .flatMap((subnet) => (subnet.SubnetId ? [subnet.SubnetId] : []))
    .sort()[0];
  return subnetId
    ? (subnetId as `subnet-${string}`)
    : yield* Effect.fail(new DefaultSubnetNotVisible());
}).pipe(
  Effect.retry({
    while: (error) => error._tag === "DefaultSubnetNotVisible",
    schedule: Schedule.max([Schedule.fixed("1 second"), Schedule.recurs(30)]),
  }),
);
