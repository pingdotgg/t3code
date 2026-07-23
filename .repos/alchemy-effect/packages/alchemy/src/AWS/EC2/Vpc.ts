import * as EC2 from "@distilled.cloud/aws/ec2";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { Region } from "@distilled.cloud/aws/Region";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { isResolved, somePropsAreDifferent } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, createTagsList, diffTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { RegionID } from "../Region.ts";

export type VpcId = `vpc-${string}`;
export const VpcId = <const S extends string>(value: S): S & VpcId =>
  value as S & VpcId;

export type VpcArn = `arn:aws:ec2:${RegionID}:${AccountID}:vpc/${VpcId}`;

export interface VpcProps {
  /**
   * The IPv4 network range for the VPC, in CIDR notation.
   * Required unless using IPAM.
   * @example "10.0.0.0/16"
   */
  cidrBlock?: string;

  /**
   * The ID of an IPv4 IPAM pool you want to use for allocating this VPC's CIDR.
   */
  ipv4IpamPoolId?: string;

  /**
   * The netmask length of the IPv4 CIDR you want to allocate to this VPC from an IPAM pool.
   */
  ipv4NetmaskLength?: number;

  /**
   * The ID of an IPv6 IPAM pool which will be used to allocate this VPC an IPv6 CIDR.
   */
  ipv6IpamPoolId?: string;

  /**
   * The netmask length of the IPv6 CIDR you want to allocate to this VPC from an IPAM pool.
   */
  ipv6NetmaskLength?: number;

  /**
   * Requests an Amazon-provided IPv6 CIDR block with a /56 prefix length for the VPC.
   */
  ipv6CidrBlock?: string;

  /**
   * The ID of an IPv6 address pool from which to allocate the IPv6 CIDR block.
   */
  ipv6Pool?: string;

  /**
   * The Availability Zone or Local Zone Group name for the IPv6 CIDR block.
   */
  ipv6CidrBlockNetworkBorderGroup?: string;

  /**
   * The tenancy options for instances launched into the VPC.
   * @default "default"
   */
  instanceTenancy?: EC2.Tenancy;

  /**
   * Whether DNS resolution is supported for the VPC.
   * @default true
   */
  enableDnsSupport?: boolean;

  /**
   * Whether instances launched in the VPC get DNS hostnames.
   * @default true
   */
  enableDnsHostnames?: boolean;

  /**
   * Requests an Amazon-provided IPv6 CIDR block with a /56 prefix length for the VPC.
   */
  amazonProvidedIpv6CidrBlock?: boolean;

  /**
   * Tags to assign to the VPC.
   * These will be merged with alchemy auto-tags (alchemy::stack, alchemy::stage, alchemy::id).
   */
  tags?: Record<string, string>;
}

export interface Vpc extends Resource<
  "AWS.EC2.VPC",
  VpcProps,
  {
    /**
     * The ID of the VPC.
     */
    vpcId: VpcId;

    /**
     * The Amazon Resource Name (ARN) of the VPC.
     */
    vpcArn: VpcArn;

    /**
     * The primary IPv4 CIDR block for the VPC.
     */
    cidrBlock: string;

    /**
     * The ID of the set of DHCP options associated with the VPC.
     */
    dhcpOptionsId: string;

    /**
     * The current state of the VPC.
     */
    state: EC2.VpcState;

    /**
     * Whether the VPC is the default VPC.
     */
    isDefault: boolean;

    /**
     * The ID of the AWS account that owns the VPC.
     */
    ownerId?: string;

    /**
     * Information about the IPv4 CIDR blocks associated with the VPC.
     */
    cidrBlockAssociationSet?: Array<{
      associationId: string;
      cidrBlock: string;
      cidrBlockState: {
        state: EC2.VpcCidrBlockStateCode;
        statusMessage?: string;
      };
    }>;

    /**
     * Information about the IPv6 CIDR blocks associated with the VPC.
     */
    ipv6CidrBlockAssociationSet?: Array<{
      associationId: string;
      ipv6CidrBlock: string;
      ipv6CidrBlockState: {
        state: EC2.VpcCidrBlockStateCode;
        statusMessage?: string;
      };
      networkBorderGroup?: string;
      ipv6Pool?: string;
    }>;

    tags?: Record<string, string>;
  },
  never,
  Providers
> {}
export const Vpc = Resource<Vpc>("AWS.EC2.VPC");

export const VpcProvider = () =>
  Provider.effect(
    Vpc,
    Effect.gen(function* () {
      const region = yield* Region;
      const { accountId } = yield* AWSEnvironment;

      const createTags = Effect.fn(function* (
        id: string,
        tags?: Record<string, string>,
      ) {
        return {
          Name: id,
          ...(yield* createInternalTags(id)),
          ...tags,
        };
      });

      return {
        stables: ["vpcId", "vpcArn", "ownerId", "isDefault"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (
            somePropsAreDifferent(olds, news, [
              "cidrBlock",
              "instanceTenancy",
              "ipv4IpamPoolId",
              "ipv6IpamPoolId",
              "ipv6CidrBlock",
            ])
          ) {
            return { action: "replace" };
          }
        }),

        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const desiredTags = yield* createTags(id, news.tags);

          // Observe — find the VPC if we already have its id, else describe
          // returns empty and we fall through to create. We don't trust
          // `output.vpcId` blindly: a VPC deleted out of band shows up as
          // missing and we recreate.
          let vpc: EC2.Vpc | undefined;

          if (output?.vpcId) {
            const lookup = yield* ec2
              .describeVpcs({ VpcIds: [output.vpcId] })
              .pipe(
                Effect.catchTag("InvalidVpcID.NotFound", () =>
                  Effect.succeed({ Vpcs: [] }),
                ),
              );
            vpc = lookup.Vpcs?.[0];
          }

          if (vpc === undefined) {
            const createResult = yield* ec2.createVpc({
              // TODO(sam): add all properties
              AmazonProvidedIpv6CidrBlock: news.amazonProvidedIpv6CidrBlock,
              InstanceTenancy: news.instanceTenancy,
              CidrBlock: news.cidrBlock,
              Ipv4IpamPoolId: news.ipv4IpamPoolId,
              Ipv4NetmaskLength: news.ipv4NetmaskLength,
              Ipv6Pool: news.ipv6Pool,
              Ipv6CidrBlock: news.ipv6CidrBlock,
              Ipv6IpamPoolId: news.ipv6IpamPoolId,
              Ipv6NetmaskLength: news.ipv6NetmaskLength,
              Ipv6CidrBlockNetworkBorderGroup:
                news.ipv6CidrBlockNetworkBorderGroup,
              TagSpecifications: [
                {
                  ResourceType: "vpc",
                  Tags: createTagsList(desiredTags),
                },
              ],
              DryRun: false,
            });
            const newVpcId = createResult.Vpc!.VpcId! as VpcId;
            yield* session.note(`VPC created: ${newVpcId}`);
            vpc = yield* waitForVpcAvailable(newVpcId, session);
          }

          const vpcId = vpc.VpcId! as VpcId;

          // Sync DNS attributes — observed cloud state vs desired. The default
          // values DNS support/hostnames default to differ across new vs
          // existing VPCs, so we always read first and only modify on a real
          // delta to avoid pointless API calls.
          const desiredDnsSupport = news.enableDnsSupport ?? true;
          const desiredDnsHostnames = news.enableDnsHostnames ?? false;

          const dnsSupportResult = yield* ec2.describeVpcAttribute({
            VpcId: vpcId,
            Attribute: "enableDnsSupport",
          });
          const currentDnsSupport =
            dnsSupportResult.EnableDnsSupport?.Value ?? true;
          if (currentDnsSupport !== desiredDnsSupport) {
            yield* ec2.modifyVpcAttribute({
              VpcId: vpcId,
              EnableDnsSupport: { Value: desiredDnsSupport },
            });
            yield* session.note(`Updated DNS support: ${desiredDnsSupport}`);
          }

          const dnsHostnamesResult = yield* ec2.describeVpcAttribute({
            VpcId: vpcId,
            Attribute: "enableDnsHostnames",
          });
          const currentDnsHostnames =
            dnsHostnamesResult.EnableDnsHostnames?.Value ?? false;
          if (currentDnsHostnames !== desiredDnsHostnames) {
            yield* ec2.modifyVpcAttribute({
              VpcId: vpcId,
              EnableDnsHostnames: { Value: desiredDnsHostnames },
            });
            yield* session.note(
              `Updated DNS hostnames: ${desiredDnsHostnames}`,
            );
          }

          // Sync tags — observed cloud tags vs desired.
          const currentTags = Object.fromEntries(
            (vpc.Tags ?? []).map((tag: EC2.Tag) => [tag.Key!, tag.Value!]),
          ) as Record<string, string>;
          const { removed, upsert } = diffTags(currentTags, desiredTags);
          if (removed.length > 0) {
            yield* ec2.deleteTags({
              Resources: [vpcId],
              Tags: removed.map((key) => ({ Key: key })),
              DryRun: false,
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({
              Resources: [vpcId],
              Tags: upsert,
              DryRun: false,
            });
          }

          // Re-read final state so the returned attributes reflect what's
          // actually in the cloud after all sync steps.
          const final = yield* ec2.describeVpcs({ VpcIds: [vpcId] });
          const finalVpc = final.Vpcs?.[0];
          if (!finalVpc) {
            return yield* Effect.fail(
              new Error(`VPC ${vpcId} disappeared during reconcile`),
            );
          }

          return {
            vpcId,
            vpcArn: `arn:aws:ec2:${region}:${accountId}:vpc/${vpcId}` as VpcArn,
            cidrBlock: finalVpc.CidrBlock!,
            dhcpOptionsId: finalVpc.DhcpOptionsId!,
            state: finalVpc.State!,
            isDefault: finalVpc.IsDefault ?? false,
            ownerId: finalVpc.OwnerId,
            cidrBlockAssociationSet: finalVpc.CidrBlockAssociationSet?.map(
              (assoc) => ({
                associationId: assoc.AssociationId!,
                cidrBlock: assoc.CidrBlock!,
                cidrBlockState: {
                  state: assoc.CidrBlockState!.State!,
                  statusMessage: assoc.CidrBlockState!.StatusMessage,
                },
              }),
            ),
            ipv6CidrBlockAssociationSet:
              finalVpc.Ipv6CidrBlockAssociationSet?.map((assoc) => ({
                associationId: assoc.AssociationId!,
                ipv6CidrBlock: assoc.Ipv6CidrBlock!,
                ipv6CidrBlockState: {
                  state: assoc.Ipv6CidrBlockState!.State!,
                  statusMessage: assoc.Ipv6CidrBlockState!.StatusMessage,
                },
                networkBorderGroup: assoc.NetworkBorderGroup,
                ipv6Pool: assoc.Ipv6Pool,
              })),
            tags: desiredTags,
          };
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const vpcId = output.vpcId;

          yield* session.note(`Deleting VPC: ${vpcId}`);

          // 1. Attempt to delete VPC
          yield* ec2
            .deleteVpc({
              VpcId: vpcId,
              DryRun: false,
            })
            .pipe(
              Effect.tapError(Effect.logDebug),
              Effect.catchTag("InvalidVpcID.NotFound", () => Effect.void),
              // Retry on dependency violations (resources still being deleted)
              Effect.retry({
                while: (e) => {
                  // DependencyViolation means there are still dependent resources
                  // This can happen if subnets/IGW are being deleted concurrently
                  return (
                    e._tag === "DependencyViolation" ||
                    (e._tag === "ValidationError" &&
                      e.message?.includes("DependencyViolation"))
                  );
                },
                // Use fixed 5s delay instead of exponential to avoid very long waits
                schedule: Schedule.fixed(5000).pipe(
                  Schedule.both(Schedule.recurs(60)), // Up to 5 minutes total
                  Schedule.tapOutput(([, attempt]) =>
                    session.note(
                      `Waiting for dependencies to clear... (attempt ${attempt + 1})`,
                    ),
                  ),
                ),
              }),
              // Log the actual error for debugging
              Effect.tapError((e) =>
                session.note(`VPC delete failed: ${e._tag} - ${e.message}`),
              ),
            );

          // 2. Wait for VPC to be fully deleted
          yield* waitForVpcDeleted(vpcId, session);

          yield* session.note(`VPC ${vpcId} deleted successfully`);
        }),
      };
    }),
  );

// Retryable error: VPC is still pending
class VpcPending extends Data.TaggedError("VpcPending")<{
  vpcId: string;
  state: string;
}> {}

// Retryable error: VPC still exists during deletion
class VpcStillExists extends Data.TaggedError("VpcStillExists")<{
  vpcId: string;
}> {}

/**
 * Wait for VPC to be in available state
 */
const waitForVpcAvailable = (
  vpcId: string,
  session?: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    const result = yield* ec2.describeVpcs({ VpcIds: [vpcId] });
    const vpc = result.Vpcs?.[0];

    if (!vpc) {
      return yield* Effect.fail(new Error(`VPC ${vpcId} not found`));
    }

    if (vpc.State === "available") {
      return vpc;
    }

    // Still pending - this is the only retryable case
    return yield* new VpcPending({ vpcId, state: vpc.State! });
  }).pipe(
    Effect.retry({
      while: (e) => e instanceof VpcPending,
      schedule: Schedule.fixed(2000).pipe(
        Schedule.both(Schedule.recurs(30)), // Max 60 seconds
        Schedule.tapOutput(([, attempt]) =>
          session
            ? session.note(
                `Waiting for VPC to be available... (${(attempt + 1) * 2}s)`,
              )
            : Effect.void,
        ),
      ),
    }),
  );

/**
 * Wait for VPC to be deleted
 */
const waitForVpcDeleted = (vpcId: string, session: ScopedPlanStatusSession) =>
  Effect.gen(function* () {
    const result = yield* ec2
      .describeVpcs({ VpcIds: [vpcId] })
      .pipe(
        Effect.catchTag("InvalidVpcID.NotFound", () =>
          Effect.succeed({ Vpcs: [] }),
        ),
      );

    if (!result.Vpcs || result.Vpcs.length === 0) {
      return; // Successfully deleted
    }

    // Still exists - this is the only retryable case
    return yield* new VpcStillExists({ vpcId });
  }).pipe(
    Effect.retry({
      while: (e) => e instanceof VpcStillExists,
      schedule: Schedule.fixed(2000).pipe(
        Schedule.both(Schedule.recurs(15)), // Max 30 seconds
        Schedule.tapOutput(([, attempt]) =>
          session.note(`Waiting for VPC deletion... (${(attempt + 1) * 2}s)`),
        ),
      ),
    }),
  );
