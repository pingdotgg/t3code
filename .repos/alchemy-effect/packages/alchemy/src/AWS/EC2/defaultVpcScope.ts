import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Effect from "effect/Effect";

/**
 * The identifiers of the account's default VPC and its intrinsic furniture,
 * resolved once per `list()` call so census/nuke never enumerate what AWS
 * itself provisions (and what `test/AWS/DefaultVpc.ts` deliberately
 * recreates as standing infrastructure).
 *
 * All fields are `undefined` when the account has no default VPC — callers
 * must then exclude nothing that depends on these ids.
 *
 * Internal scaffolding — NOT exported from the EC2 service `index.ts`.
 */
export interface DefaultVpcScope {
  /** The default VPC's id, if the account has one. */
  readonly vpcId: string | undefined;
  /** The DhcpOptions set the default VPC references (the account default). */
  readonly dhcpOptionsId: string | undefined;
}

/**
 * Resolve the default VPC (if any) for the ambient account/region.
 */
export const getDefaultVpcScope = ec2
  .describeVpcs({ Filters: [{ Name: "isDefault", Values: ["true"] }] })
  .pipe(
    Effect.map((r): DefaultVpcScope => {
      const vpc = (r.Vpcs ?? []).find((v) => v.IsDefault);
      return { vpcId: vpc?.VpcId, dhcpOptionsId: vpc?.DhcpOptionsId };
    }),
  );

/**
 * The GroupId of the default VPC's "default" security group, or `undefined`
 * when the account has no default VPC. Rules on this group are AWS-provisioned
 * furniture; rules on user-created groups inside the default VPC are not.
 */
export const getDefaultVpcDefaultSecurityGroupId = (
  vpcId: string | undefined,
) =>
  vpcId === undefined
    ? Effect.succeed(undefined)
    : ec2
        .describeSecurityGroups({
          Filters: [
            { Name: "vpc-id", Values: [vpcId] },
            { Name: "group-name", Values: ["default"] },
          ],
        })
        .pipe(Effect.map((r) => r.SecurityGroups?.[0]?.GroupId));
