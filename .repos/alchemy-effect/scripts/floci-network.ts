/**
 * Resolve the Floci emulator's default VPC network (default-for-AZ subnets and
 * the default security group) for suites that read subnet and security-group
 * IDs from the environment.
 */
import * as Floci from "@alchemy.run/aws/Local/Floci";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import { Region } from "@distilled.cloud/aws/Region";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export interface FlociDefaultNetwork {
  readonly subnetIds: ReadonlyArray<string>;
  readonly securityGroupIds: ReadonlyArray<string>;
}

export const resolveFlociDefaultNetwork = Effect.fn(function* (external: boolean) {
  const region = yield* Config.String("AWS_REGION").pipe(Config.withDefault("us-east-1"));
  return yield* Effect.gen(function* () {
    yield* Floci.ensureFloci({ port: Floci.DEFAULT_FLOCI_PORT, external });
    const vpcs = yield* EC2.describeVpcs({
      Filters: [{ Name: "is-default", Values: ["true"] }],
    });
    const vpcId = vpcs.Vpcs?.[0]?.VpcId;
    if (vpcId === undefined) {
      return yield* Effect.fail(new Error("the emulator has no default VPC"));
    }
    const subnets = yield* EC2.describeSubnets({
      Filters: [
        { Name: "vpc-id", Values: [vpcId] },
        { Name: "default-for-az", Values: ["true"] },
      ],
    });
    const groups = yield* EC2.describeSecurityGroups({
      Filters: [
        { Name: "vpc-id", Values: [vpcId] },
        { Name: "group-name", Values: ["default"] },
      ],
    });
    const subnetIds = (subnets.Subnets ?? []).flatMap((subnet) =>
      subnet.SubnetId === undefined ? [] : [subnet.SubnetId],
    );
    const securityGroupIds = (groups.SecurityGroups ?? []).flatMap((group) =>
      group.GroupId === undefined ? [] : [group.GroupId],
    );
    if (subnetIds.length === 0 || securityGroupIds.length === 0) {
      return yield* Effect.fail(new Error(`default VPC ${vpcId} has no default subnets or group`));
    }
    return { subnetIds, securityGroupIds } satisfies FlociDefaultNetwork;
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        // The emulator's own account; the caller's shell may hold no AWS
        // credentials, or real ones that must never reach this lookup.
        Layer.succeed(
          Credentials.Credentials,
          Effect.succeed({
            accessKeyId: Redacted.make("test"),
            secretAccessKey: Redacted.make("test"),
            sessionToken: undefined,
            region: region as never,
          }),
        ),
        Layer.succeed(Region, Effect.succeed(region as never)),
        Endpoint.of(`http://localhost:${Floci.DEFAULT_FLOCI_PORT}`),
        FetchHttpClient.layer,
      ),
    ),
  );
});
