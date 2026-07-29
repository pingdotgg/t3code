import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { isResolved, somePropsAreDifferent } from "../../Diff.ts";
import { retryWhileLingeringEnis } from "./LingeringEnis.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasTags,
} from "../../Tags.ts";
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
/**
 * A subnet within a VPC — a range of IP addresses bound to a single
 * Availability Zone where you place instances and other resources. Create
 * public subnets (with `mapPublicIpOnLaunch`) for internet-facing resources
 * and private subnets for internal ones.
 *
 * Changing the `vpcId`, `cidrBlock`, availability zone, or an IPAM/IPv6 pool
 * replaces the subnet.
 *
 * @resource
 * @section Creating a Subnet
 * A subnet carves a smaller CIDR range out of its parent VPC's block. The
 * `cidrBlock` must be a subset of the VPC CIDR and must not overlap any sibling
 * subnet. You can also let AWS IPAM allocate the range via `ipv4IpamPoolId` +
 * `ipv4NetmaskLength`.
 *
 * @example Basic Subnet
 * ```typescript
 * const subnet = yield* AWS.EC2.Subnet("TestSubnet", {
 *   vpcId: vpc.vpcId,
 *   cidrBlock: "10.0.1.0/24",
 * });
 * ```
 *
 * The minimal subnet: a `/24` (256 addresses) inside the VPC. Without an
 * explicit `availabilityZone`, AWS picks one for you.
 *
 * @section Availability Zone Placement
 * Each subnet lives in exactly one AZ. Pin it with `availabilityZone` (the zone
 * name, e.g. `us-east-1a`) or `availabilityZoneId` (the stable zone ID, e.g.
 * `use1-az1`) to spread tiers across zones for high availability.
 *
 * @example Subnet pinned to an Availability Zone
 * ```typescript
 * const subnet = yield* AWS.EC2.Subnet("Az1Subnet", {
 *   vpcId: vpc.vpcId,
 *   cidrBlock: "10.0.1.0/24",
 *   availabilityZone: "us-east-1a",
 * });
 * ```
 *
 * Pinning the AZ lets you place a matching subnet in `us-east-1b` and run
 * resources redundantly across zones. Use `availabilityZoneId` instead when you
 * need the physical zone to line up across different AWS accounts.
 *
 * @section Public IP Assignment
 * @example Public subnet
 * ```typescript
 * const publicSubnet = yield* AWS.EC2.Subnet("PublicSubnet", {
 *   vpcId: vpc.vpcId,
 *   cidrBlock: "10.0.1.0/24",
 *   availabilityZone: "us-east-1a",
 *   mapPublicIpOnLaunch: true,
 *   tags: { Name: "public-1a", Tier: "public" },
 * });
 * ```
 *
 * `mapPublicIpOnLaunch: true` makes this a "public" subnet — instances launched
 * here automatically get a public IPv4 address. Combine it with an internet
 * gateway route so those instances can reach the internet.
 *
 * @section IPv6 Subnets
 * For dual-stack VPCs, give the subnet an IPv6 `cidrBlock`, auto-assign IPv6
 * addresses on launch with `assignIpv6AddressOnCreation`, and optionally enable
 * `enableDns64` so the Amazon DNS resolver synthesizes IPv6 addresses for
 * IPv4-only destinations (NAT64).
 *
 * @example IPv6-enabled subnet
 * ```typescript
 * const subnet = yield* AWS.EC2.Subnet("Ipv6Subnet", {
 *   vpcId: vpc.vpcId,
 *   cidrBlock: "10.0.1.0/24",
 *   ipv6CidrBlock: "2600:1f18:abcd:1234::/64",
 *   assignIpv6AddressOnCreation: true,
 *   enableDns64: true,
 * });
 * ```
 *
 * Instances launched here receive an IPv6 address automatically, and `enableDns64`
 * lets them reach IPv4-only services through a NAT gateway. The IPv6 `/64` must
 * come from the parent VPC's IPv6 block.
 *
 * @section DNS Hostname Options
 * Control what hostnames instances receive on launch. `hostnameType` chooses
 * between IP-based names (`ip-name`) and resource-based names (`resource-name`),
 * and the `enableResourceNameDnsARecordOnLaunch` /
 * `enableResourceNameDnsAAAARecordOnLaunch` flags register A / AAAA records for
 * resource-name hosts.
 *
 * @example Resource-name DNS hostnames
 * ```typescript
 * const subnet = yield* AWS.EC2.Subnet("ResourceNameSubnet", {
 *   vpcId: vpc.vpcId,
 *   cidrBlock: "10.0.1.0/24",
 *   hostnameType: "resource-name",
 *   enableResourceNameDnsARecordOnLaunch: true,
 *   enableResourceNameDnsAAAARecordOnLaunch: true,
 * });
 * ```
 *
 * Resource-name hostnames are derived from the instance ID rather than its IP,
 * so they stay stable across stop/start. Enabling the A/AAAA records makes those
 * names resolvable over IPv4 and IPv6.
 *
 * @section Public & Private Tiers
 * @example A public and a private subnet in one VPC
 * ```typescript
 * const vpc = yield* AWS.EC2.Vpc("MyVpc", {
 *   cidrBlock: "10.0.0.0/16",
 *   enableDnsSupport: true,
 *   enableDnsHostnames: true,
 * });
 *
 * const publicSubnet = yield* AWS.EC2.Subnet("PublicSubnet", {
 *   vpcId: vpc.vpcId,
 *   cidrBlock: "10.0.1.0/24",
 *   availabilityZone: "us-east-1a",
 *   mapPublicIpOnLaunch: true,
 * });
 *
 * const privateSubnet = yield* AWS.EC2.Subnet("PrivateSubnet", {
 *   vpcId: vpc.vpcId,
 *   cidrBlock: "10.0.10.0/24",
 *   availabilityZone: "us-east-1a",
 * });
 * ```
 *
 * The canonical two-tier pattern: a public subnet (auto public IPs, routed to an
 * internet gateway) for load balancers and a private subnet (no public IPs) for
 * application and database instances. Both share the same AZ here, but in
 * production you'd replicate the pair across AZs.
 */
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
          const desiredTags = { ...alchemyTags, ...news.tags };

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
            const newSubnetId = yield* ec2
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
                Effect.map((createResult) => {
                  const newSubnetId = createResult.Subnet!
                    .SubnetId! as SubnetId;
                  return newSubnetId;
                }),
                Effect.tap((newSubnetId) =>
                  session.note(`Subnet created: ${newSubnetId}`),
                ),
                Effect.catchTag("InvalidSubnet.Conflict", (error) =>
                  Effect.gen(function* () {
                    // The CIDR is occupied. A prior interrupted run may have
                    // created this subnet but failed to persist state —
                    // observe by VPC + CIDR and take it over only when it
                    // carries our ownership tags; a foreign subnet re-fails
                    // with the typed conflict.
                    if (news.cidrBlock === undefined) {
                      return yield* Effect.fail(error);
                    }
                    const existing = yield* ec2.describeSubnets
                      .items({
                        Filters: [
                          { Name: "vpc-id", Values: [news.vpcId] },
                          { Name: "cidr-block", Values: [news.cidrBlock] },
                        ],
                      })
                      .pipe(
                        Stream.filter((s) =>
                          hasTags(
                            alchemyTags,
                            Object.fromEntries(
                              (s.Tags ?? []).map((t) => [t.Key ?? "", t.Value]),
                            ),
                          ),
                        ),
                        Stream.runHead,
                        Effect.map(Option.getOrUndefined),
                      );
                    if (existing?.SubnetId === undefined) {
                      return yield* Effect.fail(error);
                    }
                    const existingId = existing.SubnetId as SubnetId;
                    yield* session.note(
                      `Recovered subnet ${existingId} at ${news.cidrBlock} owned by this stack (left by an interrupted run)`,
                    );
                    return existingId;
                  }),
                ),
              );
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
          return toSubnetAttributes(final);
        }),

        // Enumerate every subnet in the ambient account/region, paginating
        // exhaustively. Each item is mapped to the full Attributes shape
        // produced by `reconcile`/`read`.
        list: () =>
          ec2.describeSubnets.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.Subnets ?? [])
                  // Per-AZ default subnets are default-VPC furniture AWS
                  // provisions; never census/nuke them. Custom subnets created
                  // inside the default VPC have DefaultForAz=false and are
                  // still listed.
                  .filter((subnet) => !subnet.DefaultForAz)
                  .map(toSubnetAttributes),
              ),
            ),
          ),

        delete: Effect.fn(function* ({ output, session }) {
          const subnetId = output.subnetId;

          yield* session.note(`Deleting subnet: ${subnetId}`);

          // 1. Attempt to delete subnet. DependencyViolation means resources
          // still occupy it — ENIs from a just-deleted ALB, CloudFront VPC
          // origin, or a VPC-attached Lambda can take minutes to release
          // after the owning resource is gone. Lambda Hyperplane ENIs are
          // reaped explicitly between attempts (they otherwise linger up to
          // ~20 minutes and used to force a second `destroy` run).
          yield* retryWhileLingeringEnis(
            ec2
              .deleteSubnet({
                SubnetId: subnetId,
                DryRun: false,
              })
              .pipe(
                Effect.tapError(Effect.logDebug),
                Effect.catchTag("InvalidSubnetID.NotFound", () => Effect.void),
              ),
            {
              scope: { name: "subnet-id", value: subnetId },
              isDependencyViolation: (e) => e._tag === "DependencyViolation",
              session,
            },
          );

          // 2. Wait for subnet to be fully deleted
          yield* waitForSubnetDeleted(subnetId, session);

          yield* session.note(`Subnet ${subnetId} deleted successfully`);
        }),
      };
    }),
  );

/**
 * Map a distilled `ec2.Subnet` to the full Subnet `Attributes` shape that
 * `reconcile`/`read` produce.
 */
const toSubnetAttributes = (subnet: ec2.Subnet): Subnet["Attributes"] => ({
  subnetId: subnet.SubnetId! as SubnetId,
  subnetArn: subnet.SubnetArn! as SubnetArn,
  cidrBlock: subnet.CidrBlock!,
  vpcId: subnet.VpcId! as VpcId,
  availabilityZone: subnet.AvailabilityZone!,
  availabilityZoneId: subnet.AvailabilityZoneId,
  state: subnet.State!,
  availableIpAddressCount: subnet.AvailableIpAddressCount ?? 0,
  mapPublicIpOnLaunch: subnet.MapPublicIpOnLaunch ?? false,
  assignIpv6AddressOnCreation: subnet.AssignIpv6AddressOnCreation ?? false,
  defaultForAz: subnet.DefaultForAz ?? false,
  ownerId: subnet.OwnerId,
  ipv6CidrBlockAssociationSet: subnet.Ipv6CidrBlockAssociationSet?.map(
    (assoc) => ({
      associationId: assoc.AssociationId!,
      ipv6CidrBlock: assoc.Ipv6CidrBlock!,
      ipv6CidrBlockState: {
        state: assoc.Ipv6CidrBlockState!.State!,
        statusMessage: assoc.Ipv6CidrBlockState!.StatusMessage,
      },
    }),
  ),
  enableDns64: subnet.EnableDns64,
  ipv6Native: subnet.Ipv6Native,
  privateDnsNameOptionsOnLaunch: subnet.PrivateDnsNameOptionsOnLaunch
    ? {
        hostnameType: subnet.PrivateDnsNameOptionsOnLaunch.HostnameType,
        enableResourceNameDnsARecord:
          subnet.PrivateDnsNameOptionsOnLaunch.EnableResourceNameDnsARecord,
        enableResourceNameDnsAAAARecord:
          subnet.PrivateDnsNameOptionsOnLaunch.EnableResourceNameDnsAAAARecord,
      }
    : undefined,
});

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
      schedule: Schedule.max([Schedule.fixed(2000), Schedule.recurs(30)]).pipe(
        Schedule.tap(({ attempt }) =>
          session
            ? session.note(
                `Waiting for subnet to be available... (${attempt * 2}s)`,
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
      schedule: Schedule.max([Schedule.fixed(2000), Schedule.recurs(15)]).pipe(
        Schedule.tap(({ attempt }) =>
          session.note(`Waiting for subnet deletion... (${attempt * 2}s)`),
        ),
      ),
    }),
  );
