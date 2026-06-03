import * as ec2 from "@distilled.cloud/aws/ec2";
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
import type { RegionID } from "../Region.ts";
import type { VpcId } from "./Vpc.ts";

export type SubnetId<ID extends string = string> = `subnet-${ID}`;
export const SubnetId = <ID extends string>(id: ID): ID & SubnetId<ID> =>
  `subnet-${id}` as ID & SubnetId<ID>;

export type SubnetArn =
  `arn:aws:ec2:${RegionID}:${AccountID}:subnet/${SubnetId}`;

export interface SubnetProps {
  /**
   * The VPC to create the subnet in.
   */
  vpcId: VpcId;

  /**
   * The IPv4 network range for the subnet, in CIDR notation.
   * Required unless using IPAM.
   * @example "10.0.1.0/24"
   */
  cidrBlock?: string;

  /**
   * The IPv6 network range for the subnet, in CIDR notation.
   */
  ipv6CidrBlock?: string;

  /**
   * The Availability Zone for the subnet.
   * @example "us-east-1a"
   */
  availabilityZone?: string;

  /**
   * The ID of the Availability Zone for the subnet.
   */
  availabilityZoneId?: string;

  /**
   * The ID of an IPv4 IPAM pool you want to use for allocating this subnet's CIDR.
   */
  ipv4IpamPoolId?: string;

  /**
   * The netmask length of the IPv4 CIDR you want to allocate to this subnet from an IPAM pool.
   */
  ipv4NetmaskLength?: number;

  /**
   * The ID of an IPv6 IPAM pool which will be used to allocate this subnet an IPv6 CIDR.
   */
  ipv6IpamPoolId?: string;

  /**
   * The netmask length of the IPv6 CIDR you want to allocate to this subnet from an IPAM pool.
   */
  ipv6NetmaskLength?: number;

  /**
   * Whether instances launched in the subnet get public IPv4 addresses.
   * @default false
   */
  mapPublicIpOnLaunch?: boolean;

  /**
   * Whether instances launched in the subnet get IPv6 addresses.
   * @default false
   */
  assignIpv6AddressOnCreation?: boolean;

  /**
   * Whether DNS queries made to the Amazon-provided DNS Resolver in this subnet should return
   * synthetic IPv6 addresses for IPv4-only destinations.
   * @default false
   */
  enableDns64?: boolean;

  /**
   * Whether to enable resource name DNS A record on launch.
   * @default false
   */
  enableResourceNameDnsARecordOnLaunch?: boolean;

  /**
   * Whether to enable resource name DNS AAAA record on launch.
   * @default false
   */
  enableResourceNameDnsAAAARecordOnLaunch?: boolean;

  /**
   * The hostname type for EC2 instances launched into this subnet.
   */
  hostnameType?: ec2.HostnameType;

  /**
   * Tags to assign to the subnet.
   * These will be merged with alchemy auto-tags (alchemy::stack, alchemy::stage, alchemy::id).
   */
  tags?: Record<string, string>;
}

export interface Subnet extends Resource<
  "AWS.EC2.Subnet",
  SubnetProps,
  {
    /**
     * The ID of the VPC the subnet is in.
     */
    vpcId: VpcId;

    /**
     * The ID of the subnet.
     */
    subnetId: SubnetId;

    /**
     * The Amazon Resource Name (ARN) of the subnet.
     */
    subnetArn: SubnetArn;

    /**
     * The IPv4 CIDR block for the subnet.
     */
    cidrBlock: string;

    /**
     * The Availability Zone of the subnet.
     */
    availabilityZone: string;

    /**
     * The ID of the Availability Zone of the subnet.
     */
    availabilityZoneId?: string;

    /**
     * The current state of the subnet.
     */
    state: ec2.SubnetState;

    /**
     * The number of available IPv4 addresses in the subnet.
     */
    availableIpAddressCount: number;

    /**
     * Whether instances launched in the subnet get public IPv4 addresses.
     */
    mapPublicIpOnLaunch: boolean;

    /**
     * Whether instances launched in the subnet get IPv6 addresses.
     */
    assignIpv6AddressOnCreation: boolean | undefined;

    /**
     * Whether the subnet is the default subnet for the Availability Zone.
     */
    defaultForAz: boolean;

    /**
     * The ID of the AWS account that owns the subnet.
     */
    ownerId?: string;

    /**
     * Information about the IPv6 CIDR blocks associated with the subnet.
     */
    ipv6CidrBlockAssociationSet?: Array<{
      associationId: string;
      ipv6CidrBlock: string;
      ipv6CidrBlockState: {
        state: ec2.SubnetCidrBlockStateCode;
        statusMessage?: string;
      };
    }>;

    /**
     * Whether DNS64 is enabled for the subnet.
     */
    enableDns64?: boolean;

    /**
     * Whether this is an IPv6-only subnet.
     */
    ipv6Native?: boolean;

    /**
     * The private DNS name options on launch.
     */
    privateDnsNameOptionsOnLaunch?: {
      hostnameType?: ec2.HostnameType;
      enableResourceNameDnsARecord?: boolean;
      enableResourceNameDnsAAAARecord?: boolean;
    };
  },
  never,
  Providers
> {}
export const Subnet = Resource<Subnet>("AWS.EC2.Subnet");

export const SubnetProvider = () =>
  Provider.effect(
    Subnet,
    Effect.gen(function* () {
      return {
        stables: ["subnetId", "subnetArn", "ownerId", "vpcId"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (
            somePropsAreDifferent(olds, news, [
              "vpcId",
              "cidrBlock",
              "availabilityZone",
              "availabilityZoneId",
              "ipv6CidrBlock",
              "ipv4IpamPoolId",
              "ipv6IpamPoolId",
            ])
          ) {
            return { action: "replace" };
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const alchemyTags = yield* createInternalTags(id);
          const desiredTags = { ...alchemyTags, ...(news.tags ?? {}) };

          // Observe — find the subnet via cached id, else fall through to
          // create.
          let subnet: ec2.Subnet | undefined;
          if (output?.subnetId) {
            const lookup = yield* ec2
              .describeSubnets({ SubnetIds: [output.subnetId] })
              .pipe(
                Effect.catchTag("InvalidSubnetID.NotFound", () =>
                  Effect.succeed({ Subnets: [] }),
                ),
              );
            subnet = lookup.Subnets?.[0];
          }

          // Ensure — create the subnet when missing.
          if (subnet === undefined) {
            const createResult = yield* ec2
              .createSubnet({
                VpcId: news.vpcId,
                CidrBlock: news.cidrBlock,
                Ipv6CidrBlock: news.ipv6CidrBlock,
                AvailabilityZone: news.availabilityZone,
                AvailabilityZoneId: news.availabilityZoneId,
                Ipv4IpamPoolId: news.ipv4IpamPoolId,
                Ipv4NetmaskLength: news.ipv4NetmaskLength,
                Ipv6IpamPoolId: news.ipv6IpamPoolId,
                Ipv6NetmaskLength: news.ipv6NetmaskLength,
                Ipv6Native: false,
                TagSpecifications: [
                  {
                    ResourceType: "subnet",
                    Tags: createTagsList(desiredTags),
                  },
                ],
                DryRun: false,
              })
              .pipe(
                Effect.retry({
                  while: (e) => e._tag === "InvalidVpcID.NotFound",
                  schedule: Schedule.exponential(100),
                }),
              );
            const newSubnetId = createResult.Subnet!.SubnetId! as SubnetId;
            yield* session.note(`Subnet created: ${newSubnetId}`);
            subnet = yield* waitForSubnetAvailable(newSubnetId, session);
          }

          const subnetId = subnet.SubnetId! as SubnetId;

          // Sync subnet attributes — diff observed cloud state against desired
          // and only call modifySubnetAttribute on real drift.
          const desiredMapPublicIp = news.mapPublicIpOnLaunch ?? false;
          if ((subnet.MapPublicIpOnLaunch ?? false) !== desiredMapPublicIp) {
            yield* ec2.modifySubnetAttribute({
              SubnetId: subnetId,
              MapPublicIpOnLaunch: { Value: desiredMapPublicIp },
            });
            yield* session.note(
              `Updated map public IP on launch: ${desiredMapPublicIp}`,
            );
          }

          const desiredAssignIpv6 = news.assignIpv6AddressOnCreation ?? false;
          if (
            (subnet.AssignIpv6AddressOnCreation ?? false) !== desiredAssignIpv6
          ) {
            yield* ec2.modifySubnetAttribute({
              SubnetId: subnetId,
              AssignIpv6AddressOnCreation: { Value: desiredAssignIpv6 },
            });
            yield* session.note(
              `Updated assign IPv6 address on creation: ${desiredAssignIpv6}`,
            );
          }

          const desiredEnableDns64 = news.enableDns64 ?? false;
          if ((subnet.EnableDns64 ?? false) !== desiredEnableDns64) {
            yield* ec2.modifySubnetAttribute({
              SubnetId: subnetId,
              EnableDns64: { Value: desiredEnableDns64 },
            });
            yield* session.note(`Updated DNS64 setting: ${desiredEnableDns64}`);
          }

          const observedHostnameType =
            subnet.PrivateDnsNameOptionsOnLaunch?.HostnameType;
          const observedDnsA =
            subnet.PrivateDnsNameOptionsOnLaunch?.EnableResourceNameDnsARecord;
          const observedDnsAAAA =
            subnet.PrivateDnsNameOptionsOnLaunch
              ?.EnableResourceNameDnsAAAARecord;
          if (
            observedHostnameType !== news.hostnameType ||
            observedDnsA !== news.enableResourceNameDnsARecordOnLaunch ||
            observedDnsAAAA !== news.enableResourceNameDnsAAAARecordOnLaunch
          ) {
            if (
              news.enableResourceNameDnsARecordOnLaunch !== undefined ||
              news.enableResourceNameDnsAAAARecordOnLaunch !== undefined ||
              news.hostnameType !== undefined
            ) {
              yield* ec2.modifySubnetAttribute({
                SubnetId: subnetId,
                PrivateDnsHostnameTypeOnLaunch: news.hostnameType,
                EnableResourceNameDnsARecordOnLaunch:
                  news.enableResourceNameDnsARecordOnLaunch !== undefined
                    ? { Value: news.enableResourceNameDnsARecordOnLaunch }
                    : undefined,
                EnableResourceNameDnsAAAARecordOnLaunch:
                  news.enableResourceNameDnsAAAARecordOnLaunch !== undefined
                    ? { Value: news.enableResourceNameDnsAAAARecordOnLaunch }
                    : undefined,
              });
              yield* session.note("Updated private DNS hostname settings");
            }
          }

          // Sync tags — observed cloud tags vs desired.
          const currentTags = Object.fromEntries(
            (subnet.Tags ?? []).map((t) => [t.Key!, t.Value!]),
          ) as Record<string, string>;
          const { removed, upsert } = diffTags(currentTags, desiredTags);
          if (removed.length > 0) {
            yield* ec2.deleteTags({
              Resources: [subnetId],
              Tags: removed.map((key) => ({ Key: key })),
              DryRun: false,
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({
              Resources: [subnetId],
              Tags: upsert,
              DryRun: false,
            });
          }

          // Re-read final state.
          const finalLookup = yield* ec2.describeSubnets({
            SubnetIds: [subnetId],
          });
          const final = finalLookup.Subnets?.[0];
          if (!final) {
            return yield* Effect.fail(
              new Error(`Subnet ${subnetId} disappeared during reconcile`),
            );
          }
          return {
            subnetId,
            subnetArn: final.SubnetArn! as SubnetArn,
            cidrBlock: final.CidrBlock!,
            vpcId: news.vpcId,
            availabilityZone: final.AvailabilityZone!,
            availabilityZoneId: final.AvailabilityZoneId,
            state: final.State!,
            availableIpAddressCount: final.AvailableIpAddressCount ?? 0,
            mapPublicIpOnLaunch: final.MapPublicIpOnLaunch ?? false,
            assignIpv6AddressOnCreation:
              final.AssignIpv6AddressOnCreation ?? false,
            defaultForAz: final.DefaultForAz ?? false,
            ownerId: final.OwnerId,
            ipv6CidrBlockAssociationSet: final.Ipv6CidrBlockAssociationSet?.map(
              (assoc) => ({
                associationId: assoc.AssociationId!,
                ipv6CidrBlock: assoc.Ipv6CidrBlock!,
                ipv6CidrBlockState: {
                  state: assoc.Ipv6CidrBlockState!.State!,
                  statusMessage: assoc.Ipv6CidrBlockState!.StatusMessage,
                },
              }),
            ),
            enableDns64: final.EnableDns64,
            ipv6Native: final.Ipv6Native,
            privateDnsNameOptionsOnLaunch: final.PrivateDnsNameOptionsOnLaunch
              ? {
                  hostnameType:
                    final.PrivateDnsNameOptionsOnLaunch.HostnameType,
                  enableResourceNameDnsARecord:
                    final.PrivateDnsNameOptionsOnLaunch
                      .EnableResourceNameDnsARecord,
                  enableResourceNameDnsAAAARecord:
                    final.PrivateDnsNameOptionsOnLaunch
                      .EnableResourceNameDnsAAAARecord,
                }
              : undefined,
          };
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const subnetId = output.subnetId;

          yield* session.note(`Deleting subnet: ${subnetId}`);

          // 1. Attempt to delete subnet
          yield* ec2
            .deleteSubnet({
              SubnetId: subnetId,
              DryRun: false,
            })
            .pipe(
              Effect.tapError(Effect.logDebug),
              Effect.catchTag("InvalidSubnetID.NotFound", () => Effect.void),
              // Retry on dependency violations (resources still being deleted)
              Effect.retry({
                while: (e) => {
                  // DependencyViolation means there are still dependent resources
                  // This can happen if ENIs/instances are being deleted concurrently
                  return e._tag === "DependencyViolation";
                },
                schedule: Schedule.exponential(1000, 1.5).pipe(
                  Schedule.both(Schedule.recurs(10)), // Try up to 10 times
                  Schedule.tapOutput(([, attempt]) =>
                    session.note(
                      `Waiting for dependencies to clear... (attempt ${attempt + 1})`,
                    ),
                  ),
                ),
              }),
            );

          // 2. Wait for subnet to be fully deleted
          yield* waitForSubnetDeleted(subnetId, session);

          yield* session.note(`Subnet ${subnetId} deleted successfully`);
        }),
      };
    }),
  );

// Retryable error: Subnet is still pending
class SubnetPending extends Data.TaggedError("SubnetPending")<{
  subnetId: string;
  state: string;
}> {}

// Retryable error: Subnet still exists during deletion
class SubnetStillExists extends Data.TaggedError("SubnetStillExists")<{
  subnetId: string;
}> {}

/**
 * Wait for subnet to be in available state
 */
const waitForSubnetAvailable = (
  subnetId: string,
  session?: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    const result = yield* ec2.describeSubnets({ SubnetIds: [subnetId] });
    const subnet = result.Subnets?.[0];

    if (!subnet) {
      return yield* Effect.fail(new Error(`Subnet ${subnetId} not found`));
    }

    if (subnet.State === "available") {
      return subnet;
    }

    // Still pending - this is the only retryable case
    return yield* new SubnetPending({ subnetId, state: subnet.State! });
  }).pipe(
    Effect.retry({
      while: (e) => e instanceof SubnetPending,
      schedule: Schedule.fixed(2000).pipe(
        Schedule.both(Schedule.recurs(30)), // Max 60 seconds
        Schedule.tapOutput(([, attempt]) =>
          session
            ? session.note(
                `Waiting for subnet to be available... (${(attempt + 1) * 2}s)`,
              )
            : Effect.void,
        ),
      ),
    }),
  );

/**
 * Wait for subnet to be deleted
 */
const waitForSubnetDeleted = (
  subnetId: string,
  session: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    const result = yield* ec2
      .describeSubnets({ SubnetIds: [subnetId] })
      .pipe(
        Effect.catchTag("InvalidSubnetID.NotFound", () =>
          Effect.succeed({ Subnets: [] }),
        ),
      );

    if (!result.Subnets || result.Subnets.length === 0) {
      return; // Successfully deleted
    }

    // Still exists - this is the only retryable case
    return yield* new SubnetStillExists({ subnetId });
  }).pipe(
    Effect.retry({
      while: (e) => e instanceof SubnetStillExists,
      schedule: Schedule.fixed(2000).pipe(
        Schedule.both(Schedule.recurs(15)), // Max 30 seconds
        Schedule.tapOutput(([, attempt]) =>
          session.note(
            `Waiting for subnet deletion... (${(attempt + 1) * 2}s)`,
          ),
        ),
      ),
    }),
  );
