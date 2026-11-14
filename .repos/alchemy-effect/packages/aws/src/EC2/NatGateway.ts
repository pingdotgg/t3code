import * as ec2 from "@distilled.cloud/aws/ec2";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { ScopedPlanStatusSession } from "alchemy/Report";
import { Resource } from "alchemy/Resource";
import {
  createAlchemyTagFilters,
  createInternalTags,
  createTagsList,
  diffTags,
} from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { AccountID } from "../Environment.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";
import type { AllocationId } from "./EIP.ts";
import type { SubnetId } from "./Subnet.ts";
import type { VpcId } from "./Vpc.ts";

export class NatGatewayUnexpectedResponse extends Data.TaggedError("NatGatewayUnexpectedResponse")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type NatGatewayId<ID extends string = string> = `nat-${ID}`;
export const NatGatewayId = <ID extends string>(id: ID): ID & NatGatewayId<ID> =>
  `nat-${id}` as ID & NatGatewayId<ID>;

export type NatGatewayArn = `arn:aws:ec2:${RegionID}:${AccountID}:natgateway/${NatGatewayId}`;

export interface NatGatewayAvailabilityZoneAddress {
  /**
   * The Availability Zone (e.g. `us-east-1a`) the addresses serve.
   * Specify either this or `availabilityZoneId`.
   */
  availabilityZone?: string;

  /**
   * The Availability Zone ID (e.g. `use1-az1`) the addresses serve.
   * Specify either this or `availabilityZone`.
   */
  availabilityZoneId?: string;

  /**
   * The allocation IDs of the Elastic IP addresses the gateway uses in this
   * Availability Zone.
   */
  allocationIds: AllocationId[];
}

export interface NatGatewayProps {
  /**
   * Whether the NAT gateway lives in a single Availability Zone (`"zonal"`) or
   * spans every Availability Zone of a VPC (`"regional"`).
   *
   * A zonal gateway needs `subnetId`; a regional gateway needs `vpcId` and only
   * supports public connectivity. Changing the mode replaces the gateway.
   * @default "zonal"
   */
  availabilityMode?: ec2.AvailabilityMode;

  /**
   * The subnet in which to create the NAT gateway.
   * Required for zonal NAT gateways. For public NAT gateways, this must be a
   * public subnet.
   */
  subnetId?: SubnetId;

  /**
   * The VPC in which to create a regional NAT gateway.
   * Required when `availabilityMode` is `"regional"`. The VPC must have an
   * internet gateway attached.
   */
  vpcId?: VpcId;

  /**
   * Elastic IP addresses to use per Availability Zone for a regional NAT
   * gateway (manual mode).
   *
   * When omitted, a regional gateway runs in automatic mode: AWS allocates its
   * addresses and expands it to every Availability Zone with workloads. When
   * set, the gateway runs in manual mode and only serves the listed zones;
   * addresses are associated and disassociated in place as this list changes.
   * Switching between automatic and manual mode replaces the gateway.
   */
  availabilityZoneAddresses?: NatGatewayAvailabilityZoneAddress[];

  /**
   * How long (in seconds) to let in-flight connections drain before an Elastic
   * IP removed from `availabilityZoneAddresses` is forcibly released.
   * Between 1 and 4000. Changing it never replaces the gateway.
   * @default 350
   */
  maxDrainDurationSeconds?: number;

  /**
   * The allocation ID of the Elastic IP address for the gateway.
   * Required for public NAT gateways.
   */
  allocationId?: AllocationId;

  /**
   * Indicates whether the NAT gateway supports public or private connectivity.
   * @default "public"
   */
  connectivityType?: ec2.ConnectivityType;

  /**
   * The private IPv4 address to assign to the NAT gateway.
   * If you don't provide an address, a private IPv4 address will be automatically assigned.
   */
  privateIpAddress?: string;

  /**
   * Secondary allocation IDs for additional private IP addresses.
   * Only valid for private NAT gateways.
   */
  secondaryAllocationIds?: AllocationId[];

  /**
   * Secondary private IPv4 addresses.
   * Only valid for private NAT gateways.
   */
  secondaryPrivateIpAddresses?: string[];

  /**
   * The number of secondary private IPv4 addresses to assign.
   * Only valid for private NAT gateways.
   */
  secondaryPrivateIpAddressCount?: number;

  /**
   * Tags to assign to the NAT gateway.
   */
  tags?: Record<string, string>;
}

export interface NatGateway extends Resource<
  "AWS.EC2.NatGateway",
  NatGatewayProps,
  {
    /**
     * The ID of the NAT gateway.
     */
    natGatewayId: NatGatewayId;

    /**
     * The Amazon Resource Name (ARN) of the NAT gateway.
     */
    natGatewayArn: `arn:aws:ec2:${RegionID}:${AccountID}:natgateway/${string}`;

    /**
     * The ID of the subnet in which the NAT gateway is located.
     * Undefined for regional NAT gateways.
     */
    subnetId: SubnetId | undefined;

    /**
     * Whether the NAT gateway is zonal or regional.
     */
    availabilityMode: ec2.AvailabilityMode;

    /**
     * Whether a regional NAT gateway automatically expands to Availability
     * Zones with workloads (`"enabled"` in automatic mode, `"disabled"` in
     * manual mode).
     */
    autoProvisionZones?: ec2.AutoProvisionZonesState;

    /**
     * Whether a regional NAT gateway automatically scales its IP addresses.
     */
    autoScalingIps?: ec2.AutoScalingIpsState;

    /**
     * The ID of the route table AWS creates for a regional NAT gateway.
     */
    routeTableId?: string;

    /**
     * The ID of the VPC in which the NAT gateway is located.
     */
    vpcId: string;

    /**
     * The current state of the NAT gateway.
     */
    state: ec2.NatGatewayState;

    /**
     * The connectivity type of the NAT gateway.
     */
    connectivityType: ec2.ConnectivityType;

    /**
     * The Elastic IP address associated with the NAT gateway (for public NAT gateways).
     */
    publicIp?: string;

    /**
     * The private IP address associated with the NAT gateway.
     */
    privateIp?: string;

    /**
     * Information about the IP addresses and network interface associated with the NAT gateway.
     */
    natGatewayAddresses?: Array<{
      allocationId?: string;
      networkInterfaceId?: string;
      privateIp?: string;
      publicIp?: string;
      associationId?: string;
      isPrimary?: boolean;
      failureMessage?: string;
      status?: ec2.NatGatewayAddressStatus;
      availabilityZone?: string;
      availabilityZoneId?: string;
    }>;

    /**
     * If the NAT gateway could not be created, specifies the error code for the failure.
     */
    failureCode?: string;

    /**
     * If the NAT gateway could not be created, specifies the error message for the failure.
     */
    failureMessage?: string;

    /**
     * The date and time the NAT gateway was created.
     */
    createTime?: string;

    /**
     * The date and time the NAT gateway was deleted, if applicable.
     */
    deleteTime?: string;
  },
  never,
  Providers
> {}
/**
 * A NAT gateway that lets instances in a private subnet reach the internet
 * (and other AWS services) while preventing unsolicited inbound connections.
 *
 * The gateway lives in the subnet given by `subnetId`, and its
 * `connectivityType` decides how it connects: a `"public"` gateway must sit in a
 * *public* subnet and requires an Elastic IP via `allocationId`, while a
 * `"private"` gateway has no public address and is used for VPC-to-VPC routing.
 * A NAT gateway only carries traffic once a `Route` sends `0.0.0.0/0` from the
 * private subnet's route table to it. Core properties (`availabilityMode`,
 * `subnetId`, `vpcId`, `connectivityType`, `allocationId`) are immutable, so
 * changing them replaces the gateway.
 *
 * ### Public NAT Gateways
 * Public gateways translate private addresses to a stable public IP, so they
 * must be placed in a public subnet (one with a route to an internet gateway)
 * and given an Elastic IP allocation.
 * **Example:** Public NAT Gateway with an Elastic IP
 * ```typescript
 * const eip = yield* AWS.EC2.EIP("NatEip", {});
 *
 * const natGateway = yield* AWS.EC2.NatGateway("NatGateway", {
 *   subnetId: publicSubnet.subnetId,
 *   allocationId: eip.allocationId,
 *   connectivityType: "public",
 *   tags: { Name: "production-nat" },
 * });
 * ```
 * Allocating the EIP first and passing its `allocationId` gives the gateway a
 * fixed public IP. `connectivityType` defaults to `"public"`, so it can be
 * omitted; this is the standard way to give private instances outbound internet
 * access.
 *
 * ### Private NAT Gateways
 * Private gateways have no public IP and route traffic between VPCs or to
 * on-premises networks without exposing it to the internet.
 * **Example:** Private NAT Gateway with a Fixed Private IP
 * ```typescript
 * const natGateway = yield* AWS.EC2.NatGateway("PrivateNat", {
 *   subnetId: privateSubnet.subnetId,
 *   connectivityType: "private",
 *   privateIpAddress: "10.0.10.10",
 * });
 * ```
 * Omitting `allocationId` and setting `connectivityType: "private"` creates a
 * gateway with no public address; `privateIpAddress` pins it to a specific
 * address in the subnet instead of letting AWS choose one automatically.
 *
 * **Example:** Private NAT Gateway with Secondary Addresses
 * ```typescript
 * const natGateway = yield* AWS.EC2.NatGateway("ScaledNat", {
 *   subnetId: privateSubnet.subnetId,
 *   connectivityType: "private",
 *   secondaryPrivateIpAddressCount: 3,
 * });
 * ```
 * Secondary private addresses — via `secondaryPrivateIpAddressCount`,
 * `secondaryPrivateIpAddresses`, or `secondaryAllocationIds` — raise the number
 * of simultaneous connections a private gateway can sustain to busy
 * destinations, which is only valid for private gateways.
 *
 * ### Regional NAT Gateways
 * A regional NAT gateway spans every Availability Zone of a VPC under one ID,
 * so it needs a `vpcId` instead of a public subnet. The VPC must have an
 * internet gateway attached.
 * **Example:** Regional NAT Gateway in Automatic Mode
 * ```typescript
 * const natGateway = yield* AWS.EC2.NatGateway("RegionalNat", {
 *   availabilityMode: "regional",
 *   vpcId: vpc.vpcId,
 * });
 * ```
 * In automatic mode AWS allocates the public addresses and expands the gateway
 * to each Availability Zone where your workloads run.
 *
 * **Example:** Regional NAT Gateway with Your Own Elastic IPs
 * ```typescript
 * const natGateway = yield* AWS.EC2.NatGateway("RegionalNat", {
 *   availabilityMode: "regional",
 *   vpcId: vpc.vpcId,
 *   availabilityZoneAddresses: [
 *     { availabilityZone: "us-east-1a", allocationIds: [eipA.allocationId] },
 *     { availabilityZone: "us-east-1b", allocationIds: [eipB.allocationId] },
 *   ],
 * });
 * ```
 * Listing `availabilityZoneAddresses` switches the gateway to manual mode: it
 * serves only the listed zones with the given Elastic IPs, and adding or
 * removing entries associates or disassociates addresses without replacing the
 * gateway.
 *
 * ### Routing Private Traffic
 * **Example:** Default Route Through the NAT Gateway
 * ```typescript
 * const natRoute = yield* AWS.EC2.Route("NatRoute", {
 *   routeTableId: privateRouteTable.routeTableId,
 *   destinationCidrBlock: "0.0.0.0/0",
 *   natGatewayId: natGateway.natGatewayId,
 * });
 * ```
 * Without a route the gateway is inert; this entry sends all outbound traffic
 * from the private subnet's route table through the gateway so private instances
 * can reach the internet.
 *
 * @resource
 */
export const NatGateway = Resource<NatGateway>("AWS.EC2.NatGateway");

export const NatGatewayProvider = () =>
  Provider.effect(
    NatGateway,
    Effect.gen(function* () {
      const createTags = Effect.fn(function* (id: string, tags?: Record<string, string>) {
        return {
          Name: id,
          ...(yield* createInternalTags(id)),
          ...tags,
        };
      });

      const describeNatGateway = (natGatewayId: string) =>
        ec2.describeNatGateways({ NatGatewayIds: [natGatewayId] }).pipe(
          Effect.map((r) => r.NatGateways?.[0]),
          Effect.flatMap((gw) =>
            gw
              ? Effect.succeed(gw)
              : Effect.fail(
                  new NatGatewayUnexpectedResponse({
                    message: `NAT Gateway ${natGatewayId} not found`,
                  }),
                ),
          ),
        );

      const toAttrs = Effect.fn(function* (gw: ec2.NatGateway) {
        const { accountId, region } = yield* AWSEnvironment.current;
        const primaryAddress =
          gw.NatGatewayAddresses?.find((a) => a.IsPrimary) ?? gw.NatGatewayAddresses?.[0];
        return {
          natGatewayId: gw.NatGatewayId as NatGatewayId,
          natGatewayArn:
            `arn:aws:ec2:${region}:${accountId}:natgateway/${gw.NatGatewayId}` as NatGatewayArn,
          subnetId: gw.SubnetId as SubnetId | undefined,
          vpcId: gw.VpcId!,
          state: gw.State!,
          connectivityType: gw.ConnectivityType!,
          availabilityMode: gw.AvailabilityMode ?? "zonal",
          autoProvisionZones: gw.AutoProvisionZones,
          autoScalingIps: gw.AutoScalingIps,
          routeTableId: gw.RouteTableId,
          publicIp: primaryAddress?.PublicIp,
          privateIp: primaryAddress?.PrivateIp,
          natGatewayAddresses: gw.NatGatewayAddresses?.map((a) => ({
            allocationId: a.AllocationId,
            networkInterfaceId: a.NetworkInterfaceId,
            privateIp: a.PrivateIp,
            publicIp: a.PublicIp,
            associationId: a.AssociationId,
            isPrimary: a.IsPrimary,
            failureMessage: a.FailureMessage,
            status: a.Status,
            availabilityZone: a.AvailabilityZone,
            availabilityZoneId: a.AvailabilityZoneId,
          })),
          failureCode: gw.FailureCode,
          failureMessage: gw.FailureMessage,
          createTime:
            gw.CreateTime instanceof Date
              ? gw.CreateTime.toISOString()
              : (gw.CreateTime as string | undefined),
          deleteTime:
            gw.DeleteTime instanceof Date
              ? gw.DeleteTime.toISOString()
              : (gw.DeleteTime as string | undefined),
        } satisfies NatGateway["Attributes"];
      });

      // Find NAT Gateway by alchemy tags when we don't have the ID
      const findNatGatewayByTags = Effect.fn(function* (id: string) {
        const filters = yield* createAlchemyTagFilters(id);
        // Find a NAT Gateway that's not deleted and has matching tags
        return yield* ec2.describeNatGateways
          .items({ Filter: filters })
          .pipe(Stream.runHead, Effect.map(Option.getOrUndefined));
      });

      return {
        stables: ["natGatewayId", "natGatewayArn", "vpcId"],

        read: Effect.fn(function* ({ id, output }) {
          if (output) {
            // We have the NAT Gateway ID, use it directly
            return yield* toAttrs(yield* describeNatGateway(output.natGatewayId));
          }

          // No output - try to find by tags (recovery from incomplete create)
          const gw = yield* findNatGatewayByTags(id);
          if (gw) {
            return yield* toAttrs(gw);
          }

          // Not found
          return undefined;
        }),

        list: () =>
          Effect.gen(function* () {
            // describeNatGateways enumerates every NAT gateway in the
            // account/region; paginate exhaustively and drop deleted ones.
            const pages = yield* ec2.describeNatGateways.pages({}).pipe(Stream.runCollect);
            const gateways = Array.from(pages).flatMap((page) =>
              (page.NatGateways ?? []).filter(
                (gw): gw is ec2.NatGateway & { NatGatewayId: string } =>
                  gw.NatGatewayId != null && gw.State !== "deleted",
              ),
            );
            return yield* Effect.forEach(gateways, (gw) => toAttrs(gw));
          }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          // NAT Gateway is mostly immutable - any change to core properties requires replacement
          if (
            (news.availabilityMode ?? "zonal") !== (olds.availabilityMode ?? "zonal") ||
            news.subnetId !== olds.subnetId ||
            news.vpcId !== olds.vpcId ||
            news.connectivityType !== olds.connectivityType ||
            news.allocationId !== olds.allocationId ||
            // automatic <-> manual mode cannot be switched in place
            (news.availabilityZoneAddresses === undefined) !==
              (olds.availabilityZoneAddresses === undefined)
          ) {
            return { action: "replace" };
          }
          // Tags and manual-mode zone addresses can be updated in-place
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const desiredTags = yield* createTags(id, news.tags);

          // Observe — try the cached id first; if missing, search by alchemy
          // tags so an interrupted create can recover before re-running the
          // API. We treat a non-deleted match as ours because diff/replace
          // already covers immutable property changes upstream.
          let gw: ec2.NatGateway | undefined;
          if (output?.natGatewayId) {
            const lookup = yield* ec2
              .describeNatGateways({ NatGatewayIds: [output.natGatewayId] })
              .pipe(
                Effect.catchTag("NatGatewayNotFound", () => Effect.succeed({ NatGateways: [] })),
              );
            gw = lookup.NatGateways?.[0];
          } else {
            gw = yield* findNatGatewayByTags(id);
          }

          // Treat a deleted/deleting NAT as if it doesn't exist so we recreate.
          if (gw && (gw.State === "deleted" || gw.State === "deleting" || gw.State === "failed")) {
            gw = undefined;
          }

          // Ensure — create the NAT gateway when missing.
          if (gw === undefined) {
            yield* session.note("Creating NAT Gateway...");
            const result = yield* ec2.createNatGateway({
              AvailabilityMode: news.availabilityMode,
              SubnetId: news.subnetId,
              VpcId: news.vpcId,
              AvailabilityZoneAddresses: news.availabilityZoneAddresses?.map((a) => ({
                AvailabilityZone: a.availabilityZone,
                AvailabilityZoneId: a.availabilityZoneId,
                AllocationIds: a.allocationIds,
              })),
              AllocationId: news.allocationId as string | undefined,
              ConnectivityType:
                news.connectivityType ??
                (news.availabilityMode === "regional" ? undefined : "public"),
              PrivateIpAddress: news.privateIpAddress,
              SecondaryAllocationIds: news.secondaryAllocationIds as string[] | undefined,
              SecondaryPrivateIpAddresses: news.secondaryPrivateIpAddresses,
              SecondaryPrivateIpAddressCount: news.secondaryPrivateIpAddressCount,
              TagSpecifications: [
                {
                  ResourceType: "natgateway",
                  Tags: createTagsList(desiredTags),
                },
              ],
              DryRun: false,
            });
            const natGatewayId = result.NatGateway!.NatGatewayId!;
            yield* session.note(`NAT Gateway created: ${natGatewayId}`);
            gw = yield* waitForNatGatewayAvailable(natGatewayId, session);
          }

          const natGatewayId = gw.NatGatewayId!;

          // Sync manual-mode zone addresses — observed associations vs desired.
          if (news.availabilityZoneAddresses) {
            // An in-flight association has no AssociationId yet, so it can be
            // neither diffed nor disassociated — let it settle first.
            const settled = yield* waitForNatGatewayAddresses(
              natGatewayId,
              (a) => a.Status === "associating",
              session,
            );
            const observed = (settled.NatGatewayAddresses ?? []).filter(
              (a) =>
                a.AllocationId !== undefined &&
                a.Status !== "disassociating" &&
                a.Status !== "failed",
            );
            const desired = news.availabilityZoneAddresses.flatMap((zone) =>
              zone.allocationIds.map((allocationId) => ({ zone, allocationId })),
            );
            const sameZone = (a: ec2.NatGatewayAddress, zone: NatGatewayAvailabilityZoneAddress) =>
              zone.availabilityZoneId !== undefined
                ? a.AvailabilityZoneId === zone.availabilityZoneId
                : a.AvailabilityZone === zone.availabilityZone;
            const stale = observed.filter(
              (a) =>
                a.AssociationId !== undefined &&
                !desired.some((d) => d.allocationId === a.AllocationId && sameZone(a, d.zone)),
            );
            if (stale.length > 0) {
              yield* session.note(`Disassociating ${stale.length} NAT Gateway address(es)...`);
              yield* ec2.disassociateNatGatewayAddress({
                NatGatewayId: natGatewayId,
                AssociationIds: stale.map((a) => a.AssociationId!),
                MaxDrainDurationSeconds: news.maxDrainDurationSeconds,
              });
              // An EIP moving between zones must be released before it can
              // be associated again.
              const moving = stale
                .map((a) => a.AllocationId!)
                .filter((allocationId) => desired.some((d) => d.allocationId === allocationId));
              if (moving.length > 0) {
                yield* waitForNatGatewayAddresses(
                  natGatewayId,
                  (a) => a.AllocationId !== undefined && moving.includes(a.AllocationId),
                  session,
                );
              }
            }
            for (const zone of news.availabilityZoneAddresses) {
              const missing = zone.allocationIds.filter(
                (allocationId) =>
                  !observed.some((a) => a.AllocationId === allocationId && sameZone(a, zone)),
              );
              if (missing.length > 0) {
                yield* session.note(
                  `Associating ${missing.length} address(es) in ${zone.availabilityZoneId ?? zone.availabilityZone}...`,
                );
                yield* ec2.associateNatGatewayAddress({
                  NatGatewayId: natGatewayId,
                  AvailabilityZone: zone.availabilityZone,
                  AvailabilityZoneId: zone.availabilityZoneId,
                  AllocationIds: missing,
                });
              }
            }
            const associated = yield* waitForNatGatewayAddresses(
              natGatewayId,
              (a) => a.Status === "associating",
              session,
            );
            const failed = (associated.NatGatewayAddresses ?? []).find(
              (a) =>
                a.Status === "failed" &&
                desired.some((d) => d.allocationId === a.AllocationId && sameZone(a, d.zone)),
            );
            if (failed) {
              return yield* new NatGatewayAddressFailed({
                natGatewayId,
                allocationId: failed.AllocationId!,
                failureMessage: failed.FailureMessage,
              });
            }
          }

          // Sync tags — observed cloud tags vs desired.
          const currentTags =
            (yield* ec2
              .describeTags({
                Filters: [
                  { Name: "resource-id", Values: [natGatewayId] },
                  { Name: "resource-type", Values: ["natgateway"] },
                ],
              })
              .pipe(
                Effect.map(
                  (r) =>
                    Object.fromEntries(r.Tags?.map((t) => [t.Key!, t.Value!]) ?? []) as Record<
                      string,
                      string
                    >,
                ),
              )) ?? {};
          const { removed, upsert } = diffTags(currentTags, desiredTags);
          if (removed.length > 0) {
            yield* ec2.deleteTags({
              Resources: [natGatewayId],
              Tags: removed.map((key) => ({ Key: key })),
              DryRun: false,
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({
              Resources: [natGatewayId],
              Tags: upsert,
              DryRun: false,
            });
          }

          // Re-read final state.
          const final = yield* describeNatGateway(natGatewayId);
          return yield* toAttrs(final);
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const natGatewayId = output.natGatewayId;

          yield* session.note(`Deleting NAT Gateway: ${natGatewayId}`);

          yield* ec2
            .deleteNatGateway({
              NatGatewayId: natGatewayId,
              DryRun: false,
            })
            .pipe(Effect.catchTag("NatGatewayNotFound", () => Effect.void));

          // Wait for NAT Gateway to be deleted
          yield* waitForNatGatewayDeleted(natGatewayId, session);

          yield* session.note(`NAT Gateway ${natGatewayId} deleted`);
        }),
      };
    }),
  );

// Retryable error: NAT Gateway is still pending
class NatGatewayPending extends Data.TaggedError("NatGatewayPending")<{
  natGatewayId: string;
  state: string;
}> {}

// Terminal error: NAT Gateway creation failed
class NatGatewayFailed extends Data.TaggedError("NatGatewayFailed")<{
  natGatewayId: string;
  failureCode?: string;
  failureMessage?: string;
}> {}

// Terminal error: NAT Gateway not found
class NatGatewayNotFound extends Data.TaggedError("NatGatewayNotFound")<{
  natGatewayId: string;
}> {}

/**
 * Wait for NAT Gateway to be in available state
 */
const waitForNatGatewayAvailable = (natGatewayId: string, session: ScopedPlanStatusSession) =>
  Effect.gen(function* () {
    const result = yield* ec2.describeNatGateways({
      NatGatewayIds: [natGatewayId],
    });
    const gw = result.NatGateways?.[0];

    if (!gw) {
      return yield* new NatGatewayNotFound({ natGatewayId });
    }

    if (gw.State === "available") {
      return gw;
    }

    if (gw.State === "failed") {
      return yield* new NatGatewayFailed({
        natGatewayId,
        failureCode: gw.FailureCode,
        failureMessage: gw.FailureMessage,
      });
    }

    // Still pending - this is the only retryable case
    return yield* new NatGatewayPending({ natGatewayId, state: gw.State! });
  }).pipe(
    Effect.tapError(Effect.logDebug),
    Effect.retry({
      while: (e) => e._tag === "NatGatewayPending",
      schedule: Schedule.max([Schedule.fixed(5000), Schedule.recurs(60)]).pipe(
        Schedule.tap(({ attempt }) =>
          session.note(`Waiting for NAT Gateway to be available... (${attempt * 5}s)`),
        ),
      ),
    }),
  );

// Retryable error: NAT Gateway is still deleting
class NatGatewayDeleting extends Data.TaggedError("NatGatewayDeleting")<{
  natGatewayId: string;
  state: string;
}> {}

/**
 * Wait for NAT Gateway to be deleted
 */
const waitForNatGatewayDeleted = (natGatewayId: string, session: ScopedPlanStatusSession) =>
  Effect.gen(function* () {
    const result = yield* ec2
      .describeNatGateways({ NatGatewayIds: [natGatewayId] })
      .pipe(Effect.catchTag("NatGatewayNotFound", () => Effect.succeed({ NatGateways: [] })));

    const gw = result.NatGateways?.[0];

    if (!gw || gw.State === "deleted") {
      return; // Successfully deleted
    }

    yield* Effect.logDebug(gw);

    // Still deleting - this is the only retryable case
    return yield* new NatGatewayDeleting({ natGatewayId, state: gw.State! });
  }).pipe(
    Effect.tapError(Effect.logDebug),
    Effect.retry({
      while: (e) => e._tag === "NatGatewayDeleting",
      schedule: Schedule.max([Schedule.fixed(5000), Schedule.recurs(60)]).pipe(
        Schedule.tap(({ attempt }) =>
          session.note(`Waiting for NAT Gateway deletion... (${attempt * 5}s)`),
        ),
      ),
    }),
  );

// Terminal error: an Elastic IP could not be associated with the NAT Gateway
class NatGatewayAddressFailed extends Data.TaggedError("NatGatewayAddressFailed")<{
  natGatewayId: string;
  allocationId: string;
  failureMessage?: string;
}> {}

// Retryable error: NAT Gateway addresses are still transitioning
class NatGatewayAddressesPending extends Data.TaggedError("NatGatewayAddressesPending")<{
  natGatewayId: string;
  allocationIds: string[];
}> {}

/**
 * Wait until no NAT Gateway address matches `pending`, returning the settled gateway
 */
const waitForNatGatewayAddresses = Effect.fn(
  function* (
    natGatewayId: string,
    pending: (address: ec2.NatGatewayAddress) => boolean,
    _session: ScopedPlanStatusSession,
  ) {
    const result = yield* ec2.describeNatGateways({ NatGatewayIds: [natGatewayId] });
    const gw = result.NatGateways?.[0];
    if (!gw) {
      return yield* new NatGatewayNotFound({ natGatewayId });
    }
    const transitioning = (gw.NatGatewayAddresses ?? []).filter(pending);
    if (transitioning.length > 0) {
      return yield* new NatGatewayAddressesPending({
        natGatewayId,
        allocationIds: transitioning.map((a) => a.AllocationId ?? "unknown"),
      });
    }
    return gw;
  },
  (effect, _natGatewayId, _pending, session) =>
    effect.pipe(
      Effect.retry({
        while: (e) => e._tag === "NatGatewayAddressesPending",
        schedule: Schedule.max([Schedule.fixed(5000), Schedule.recurs(90)]).pipe(
          Schedule.tap(({ attempt }) =>
            session.note(`Waiting for NAT Gateway addresses to settle... (${attempt * 5}s)`),
          ),
        ),
      }),
    ),
);
