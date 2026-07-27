import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../DefaultVpc.ts";

class DefaultSubnetNotVisible extends Data.TaggedError(
  "DefaultSubnetNotVisible",
)<{}> {}

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
