import * as EC2 from "@distilled.cloud/aws/ec2";
import * as r53r from "@distilled.cloud/aws/route53resolver";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../DefaultVpc.ts";

/**
 * Resolve the default VPC, two default-for-AZ subnets, and the default
 * security group — the network a resolver endpoint's interfaces land in.
 */
export const defaultNetwork = Effect.gen(function* () {
  const vpc = yield* getDefaultVpc;
  const subnets = yield* EC2.describeSubnets({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "default-for-az", Values: ["true"] },
    ],
  });
  const subnetIds = (subnets.Subnets ?? [])
    .map((s) => s.SubnetId)
    .filter((id): id is string => id !== undefined)
    .sort()
    .slice(0, 2);
  if (subnetIds.length < 2) {
    return yield* Effect.die(
      new Error("default VPC has fewer than 2 default-for-AZ subnets"),
    );
  }
  const groups = yield* EC2.describeSecurityGroups({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "group-name", Values: ["default"] },
    ],
  });
  const securityGroupId = groups.SecurityGroups?.[0]?.GroupId;
  if (securityGroupId === undefined) {
    return yield* Effect.die(
      new Error("default VPC has no default security group"),
    );
  }
  return { vpcId: vpc.vpcId as string, subnetIds, securityGroupId };
}).pipe(Effect.orDie);

/**
 * Endpoint deletion is asynchronous — accept `DELETING` (deletion
 * initiated) or fully gone, retrying briefly.
 */
export const assertEndpointDeleting = (endpointId: string) =>
  r53r.getResolverEndpoint({ ResolverEndpointId: endpointId }).pipe(
    Effect.flatMap((r) =>
      r.ResolverEndpoint?.Status === "DELETING"
        ? Effect.void
        : Effect.fail(
            new Error(
              `resolver endpoint '${endpointId}' still ${r.ResolverEndpoint?.Status}`,
            ),
          ),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e instanceof Error,
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

/**
 * Rule deletion is asynchronous — accept `DELETING` or fully gone,
 * retrying briefly.
 */
export const assertRuleGone = (ruleId: string) =>
  r53r.getResolverRule({ ResolverRuleId: ruleId }).pipe(
    Effect.flatMap((r) =>
      r.ResolverRule?.Status === "DELETING"
        ? Effect.void
        : Effect.fail(
            new Error(
              `resolver rule '${ruleId}' still ${r.ResolverRule?.Status}`,
            ),
          ),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e instanceof Error,
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );
