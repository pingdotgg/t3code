import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createAlchemyTagFilters,
  createInternalTags,
  createTagsList,
  diffTags,
} from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";
import type { AllocationId } from "./EIP.ts";
import type { SubnetId } from "./Subnet.ts";

export type NatGatewayId<ID extends string = string> = `nat-${ID}`;
export const NatGatewayId = <ID extends string>(
  id: ID,
): ID & NatGatewayId<ID> => `nat-${id}` as ID & NatGatewayId<ID>;

export type NatGatewayArn =
  `arn:aws:ec2:${RegionID}:${AccountID}:natgateway/${NatGatewayId}`;

export interface NatGatewayProps {
  /**
   * The subnet in which to create the NAT gateway.
   * For public NAT gateways, this must be a public subnet.
   */
  subnetId: SubnetId;

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
     */
    subnetId: SubnetId;

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
 * private subnet's route table to it. Core properties (`subnetId`,
 * `connectivityType`, `allocationId`) are immutable, so changing them replaces
 * the gateway.
 *
 * @resource
 * @section Public NAT Gateways
 * Public gateways translate private addresses to a stable public IP, so they
 * must be placed in a public subnet (one with a route to an internet gateway)
 * and given an Elastic IP allocation.
 * @example Public NAT Gateway with an Elastic IP
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
 * @section Private NAT Gateways
 * Private gateways have no public IP and route traffic between VPCs or to
 * on-premises networks without exposing it to the internet.
 * @example Private NAT Gateway with a Fixed Private IP
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
 * @example Private NAT Gateway with Secondary Addresses
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
 * @section Routing Private Traffic
 * @example Default Route Through the NAT Gateway
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
 */
export const NatGateway = Resource<NatGateway>("AWS.EC2.NatGateway");

export const NatGatewayProvider = () =>
  Provider.effect(
    NatGateway,
    Effect.gen(function* () {
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

      const describeNatGateway = (natGatewayId: string) =>
        ec2.describeNatGateways({ NatGatewayIds: [natGatewayId] }).pipe(
          Effect.map((r) => r.NatGateways?.[0]),
          Effect.flatMap((gw) =>
            gw
              ? Effect.succeed(gw)
              : Effect.fail(new Error(`NAT Gateway ${natGatewayId} not found`)),
          ),
        );

      const toAttrs = Effect.fn(function* (gw: ec2.NatGateway) {
        const { accountId, region } = yield* AWSEnvironment.current;
        const primaryAddress =
          gw.NatGatewayAddresses?.find((a) => a.IsPrimary) ??
          gw.NatGatewayAddresses?.[0];
        return {
          natGatewayId: gw.NatGatewayId as NatGatewayId,
          natGatewayArn:
            `arn:aws:ec2:${region}:${accountId}:natgateway/${gw.NatGatewayId}` as NatGatewayArn,
          subnetId: gw.SubnetId as SubnetId,
          vpcId: gw.VpcId!,
          state: gw.State!,
          connectivityType: gw.ConnectivityType!,
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
            return yield* toAttrs(
              yield* describeNatGateway(output.natGatewayId),
            );
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
            const pages = yield* ec2.describeNatGateways
              .pages({})
              .pipe(Stream.runCollect);
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
            news.subnetId !== olds.subnetId ||
            news.connectivityType !== olds.connectivityType ||
            news.allocationId !== olds.allocationId
          ) {
            return { action: "replace" };
          }
          // Tags can be updated in-place
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
                Effect.catchTag("NatGatewayNotFound", () =>
                  Effect.succeed({ NatGateways: [] }),
                ),
              );
            gw = lookup.NatGateways?.[0];
          } else {
            gw = yield* findNatGatewayByTags(id);
          }

          // Treat a deleted/deleting NAT as if it doesn't exist so we recreate.
          if (
            gw &&
            (gw.State === "deleted" ||
              gw.State === "deleting" ||
              gw.State === "failed")
          ) {
            gw = undefined;
          }

          // Ensure — create the NAT gateway when missing.
          if (gw === undefined) {
            yield* session.note("Creating NAT Gateway...");
            const result = yield* ec2.createNatGateway({
              SubnetId: news.subnetId as string,
              AllocationId: news.allocationId as string | undefined,
              ConnectivityType: news.connectivityType ?? "public",
              PrivateIpAddress: news.privateIpAddress,
              SecondaryAllocationIds: news.secondaryAllocationIds as
                | string[]
                | undefined,
              SecondaryPrivateIpAddresses: news.secondaryPrivateIpAddresses,
              SecondaryPrivateIpAddressCount:
                news.secondaryPrivateIpAddressCount,
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
                    Object.fromEntries(
                      r.Tags?.map((t) => [t.Key!, t.Value!]) ?? [],
                    ) as Record<string, string>,
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
const waitForNatGatewayAvailable = (
  natGatewayId: string,
  session: ScopedPlanStatusSession,
) =>
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
          session.note(
            `Waiting for NAT Gateway to be available... (${attempt * 5}s)`,
          ),
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
const waitForNatGatewayDeleted = (
  natGatewayId: string,
  session: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    const result = yield* ec2
      .describeNatGateways({ NatGatewayIds: [natGatewayId] })
      .pipe(
        Effect.catchTag("NatGatewayNotFound", () =>
          Effect.succeed({ NatGateways: [] }),
        ),
      );

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
