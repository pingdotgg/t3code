import type * as EC2 from "@distilled.cloud/aws/ec2";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, createTagsList, diffTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";
import type { VpcId } from "./Vpc.ts";

export type RouteTableId<ID extends string = string> = `rtb-${ID}`;
export const RouteTableId = <ID extends string>(
  id: ID,
): ID & RouteTableId<ID> => `rtb-${id}` as ID & RouteTableId<ID>;

export interface RouteTableProps {
  /**
   * The VPC to create the route table in.
   * Required.
   */
  vpcId: VpcId;

  /**
   * Tags to assign to the route table.
   * These will be merged with alchemy auto-tags (alchemy::stack, alchemy::stage, alchemy::id).
   */
  tags?: Record<string, string>;
}

export interface RouteTable extends Resource<
  "AWS.EC2.RouteTable",
  RouteTableProps,
  {
    /**
     * The ID of the VPC the route table is in.
     */
    vpcId: VpcId;

    /**
     * The ID of the route table.
     */
    routeTableId: RouteTableId;

    /**
     * The Amazon Resource Name (ARN) of the route table.
     */
    routeTableArn: `arn:aws:ec2:${RegionID}:${AccountID}:route-table/${string}`;

    /**
     * The ID of the AWS account that owns the route table.
     */
    ownerId?: string;

    /**
     * The associations between the route table and subnets or gateways.
     */
    associations?: Array<{
      /**
       * Whether this is the main route table for the VPC.
       */
      main: boolean;
      /**
       * The ID of the association.
       */
      routeTableAssociationId?: string;
      /**
       * The ID of the route table.
       */
      routeTableId?: string;
      /**
       * The ID of the subnet (if the association is with a subnet).
       */
      subnetId?: string;
      /**
       * The ID of the gateway (if the association is with a gateway).
       */
      gatewayId?: string;
      /**
       * The state of the association.
       */
      associationState?: {
        state: EC2.RouteTableAssociationStateCode;
        statusMessage?: string;
      };
    }>;

    /**
     * The routes in the route table.
     */
    routes?: Array<{
      /**
       * The IPv4 CIDR block used for the destination match.
       */
      destinationCidrBlock?: string;
      /**
       * The IPv6 CIDR block used for the destination match.
       */
      destinationIpv6CidrBlock?: string;
      /**
       * The prefix of the AWS service.
       */
      destinationPrefixListId?: string;
      /**
       * The ID of the egress-only internet gateway.
       */
      egressOnlyInternetGatewayId?: string;
      /**
       * The ID of the gateway (internet gateway or virtual private gateway).
       */
      gatewayId?: string;
      /**
       * The ID of the NAT instance.
       */
      instanceId?: string;
      /**
       * The ID of AWS account that owns the NAT instance.
       */
      instanceOwnerId?: string;
      /**
       * The ID of the NAT gateway.
       */
      natGatewayId?: string;
      /**
       * The ID of the transit gateway.
       */
      transitGatewayId?: string;
      /**
       * The ID of the local gateway.
       */
      localGatewayId?: string;
      /**
       * The ID of the carrier gateway.
       */
      carrierGatewayId?: string;
      /**
       * The ID of the network interface.
       */
      networkInterfaceId?: string;
      /**
       * Describes how the route was created.
       */
      origin: EC2.RouteOrigin;
      /**
       * The state of the route.
       */
      state: EC2.RouteState;
      /**
       * The ID of the VPC peering connection.
       */
      vpcPeeringConnectionId?: string;
      /**
       * The Amazon Resource Name (ARN) of the core network.
       */
      coreNetworkArn?: string;
    }>;

    /**
     * Any virtual private gateway (VGW) propagating routes.
     */
    propagatingVgws?: Array<{
      gatewayId: string;
    }>;
  },
  never,
  Providers
> {}
/**
 * A VPC route table holds a set of routes that determine where network
 * traffic from associated subnets (or gateways) is directed. Create one
 * route table per routing domain — typically a "public" table whose default
 * route points at an {@link InternetGateway}, and one or more "private" tables
 * whose default route points at a NAT gateway.
 *
 * A route table is little more than a container: it owns a `vpcId` and tags,
 * while the actual routing behaviour is supplied by separate {@link Route}
 * resources and applied to subnets by {@link RouteTableAssociation} resources.
 *
 * @resource
 * @section Creating a Route Table
 * The only required input is the `vpcId` the table belongs to. Changing
 * `vpcId` later replaces the route table, since a table cannot move between
 * VPCs.
 *
 * @example Basic Route Table
 * ```typescript
 * const routeTable = yield* AWS.EC2.RouteTable("PublicRouteTable", {
 *   vpcId: myVpc.vpcId,
 * });
 * ```
 * Creates an empty route table in the given VPC. It starts with only the
 * implicit `local` route (managed by AWS) until you add your own
 * {@link Route} resources.
 *
 * @example Route Table with Tags
 * ```typescript
 * const routeTable = yield* AWS.EC2.RouteTable("PrivateRouteTable", {
 *   vpcId: myVpc.vpcId,
 *   tags: { Name: "private-rt", Tier: "private" },
 * });
 * ```
 * The `tags` map is merged with the alchemy auto-tags (`alchemy::stack`,
 * `alchemy::stage`, `alchemy::id`) and can be updated in place without
 * replacing the table. Use the `Name` tag to label the table in the AWS
 * console.
 *
 * @section Building a Public Routing Domain
 * A route table only directs traffic once you attach routes to it and
 * associate it with subnets. The pattern below wires a public subnet to the
 * internet: an {@link InternetGateway}, a default {@link Route} pointing at it,
 * and a {@link RouteTableAssociation} binding the subnet to the table.
 *
 * @example Route Table, Internet Route, and Subnet Association
 * ```typescript
 * const internetGateway = yield* AWS.EC2.InternetGateway("InternetGateway", {
 *   vpcId: myVpc.vpcId,
 * });
 *
 * const publicRouteTable = yield* AWS.EC2.RouteTable("PublicRouteTable", {
 *   vpcId: myVpc.vpcId,
 * });
 *
 * const internetRoute = yield* AWS.EC2.Route("InternetRoute", {
 *   routeTableId: publicRouteTable.routeTableId,
 *   destinationCidrBlock: "0.0.0.0/0",
 *   gatewayId: internetGateway.internetGatewayId,
 * });
 *
 * const association = yield* AWS.EC2.RouteTableAssociation("PublicSubnetAssociation", {
 *   routeTableId: publicRouteTable.routeTableId,
 *   subnetId: publicSubnet.subnetId,
 * });
 * ```
 * Any subnet associated with this table now reaches the public internet via
 * the `0.0.0.0/0` route. Multiple subnets can share the same route table by
 * declaring additional associations — a common way to give every public
 * subnet in a VPC identical routing.
 */
export const RouteTable = Resource<RouteTable>("AWS.EC2.RouteTable");

export const RouteTableProvider = () =>
  Provider.effect(
    RouteTable,
    Effect.gen(function* () {
      return {
        stables: ["routeTableId", "ownerId", "routeTableArn", "vpcId"],

        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            return yield* ec2.describeRouteTables.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.RouteTables ?? [])
                    .filter(
                      (rt): rt is ec2.RouteTable & { RouteTableId: string } =>
                        rt.RouteTableId != null &&
                        // Every VPC has an implicit main route table. AWS does
                        // not allow deleting it directly; deleting the VPC
                        // removes it automatically.
                        !rt.Associations?.some((assoc) => assoc.Main === true),
                    )
                    .map((rt) => {
                      const routeTableId = rt.RouteTableId as RouteTableId;
                      return {
                        routeTableId,
                        routeTableArn:
                          `arn:aws:ec2:${region}:${accountId}:route-table/${routeTableId}` as `arn:aws:ec2:${RegionID}:${AccountID}:route-table/${string}`,
                        vpcId: rt.VpcId as VpcId,
                        ownerId: rt.OwnerId,
                        associations: rt.Associations?.map((assoc) => ({
                          main: assoc.Main ?? false,
                          routeTableAssociationId:
                            assoc.RouteTableAssociationId,
                          routeTableId: assoc.RouteTableId,
                          subnetId: assoc.SubnetId,
                          gatewayId: assoc.GatewayId,
                          associationState: assoc.AssociationState
                            ? {
                                state: assoc.AssociationState.State!,
                                statusMessage:
                                  assoc.AssociationState.StatusMessage,
                              }
                            : undefined,
                        })),
                        routes: rt.Routes?.map((route) => ({
                          destinationCidrBlock: route.DestinationCidrBlock,
                          destinationIpv6CidrBlock:
                            route.DestinationIpv6CidrBlock,
                          destinationPrefixListId:
                            route.DestinationPrefixListId,
                          egressOnlyInternetGatewayId:
                            route.EgressOnlyInternetGatewayId,
                          gatewayId: route.GatewayId,
                          instanceId: route.InstanceId,
                          instanceOwnerId: route.InstanceOwnerId,
                          natGatewayId: route.NatGatewayId,
                          transitGatewayId: route.TransitGatewayId,
                          localGatewayId: route.LocalGatewayId,
                          carrierGatewayId: route.CarrierGatewayId,
                          networkInterfaceId: route.NetworkInterfaceId,
                          origin: route.Origin!,
                          state: route.State!,
                          vpcPeeringConnectionId: route.VpcPeeringConnectionId,
                          coreNetworkArn: route.CoreNetworkArn,
                        })),
                        propagatingVgws: rt.PropagatingVgws?.map((vgw) => ({
                          gatewayId: vgw.GatewayId!,
                        })),
                      };
                    }),
                ),
              ),
            );
          }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          // VpcId change requires replacement
          if (olds.vpcId !== news.vpcId) {
            return { action: "replace" };
          }
          // Tags can be updated in-place
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const alchemyTags = yield* createInternalTags(id);
          const desiredTags = { ...alchemyTags, ...news.tags };

          // Observe — find the route table via cached id, else fall through
          // to create.
          let routeTable: ec2.RouteTable | undefined;
          if (output?.routeTableId) {
            const lookup = yield* ec2
              .describeRouteTables({ RouteTableIds: [output.routeTableId] })
              .pipe(
                Effect.catchTag("InvalidRouteTableID.NotFound", () =>
                  Effect.succeed({ RouteTables: [] }),
                ),
              );
            routeTable = lookup.RouteTables?.[0];
          }

          // Ensure — create the route table when missing.
          if (routeTable === undefined) {
            const createResult = yield* ec2
              .createRouteTable({
                VpcId: news.vpcId,
                TagSpecifications: [
                  {
                    ResourceType: "route-table",
                    Tags: createTagsList(desiredTags),
                  },
                ],
                DryRun: false,
              })
              .pipe(
                Effect.retry({
                  while: (e) => e._tag === "InvalidVpcID.NotFound",
                  schedule: Schedule.max([
                    Schedule.fixed(500),
                    Schedule.recurs(10),
                  ]),
                }),
              );
            const newId = createResult.RouteTable!
              .RouteTableId! as RouteTableId;
            yield* session.note(`Route table created: ${newId}`);
            routeTable = yield* describeRouteTable(newId, session);
          }

          const routeTableId = routeTable.RouteTableId! as RouteTableId;

          // Sync tags — observed cloud tags vs desired.
          const currentTags = Object.fromEntries(
            (routeTable.Tags ?? []).map((t) => [t.Key!, t.Value!]),
          ) as Record<string, string>;
          const { removed, upsert } = diffTags(currentTags, desiredTags);
          if (removed.length > 0) {
            yield* ec2.deleteTags({
              Resources: [routeTableId],
              Tags: removed.map((key) => ({ Key: key })),
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({
              Resources: [routeTableId],
              Tags: upsert,
            });
          }

          // Re-read final state.
          const final = yield* describeRouteTable(routeTableId, session);
          return {
            routeTableId,
            routeTableArn:
              `arn:aws:ec2:${region}:${accountId}:route-table/${routeTableId}` as `arn:aws:ec2:${RegionID}:${AccountID}:route-table/${string}`,
            vpcId: news.vpcId as VpcId,
            ownerId: final.OwnerId,
            associations: final.Associations?.map((assoc) => ({
              main: assoc.Main ?? false,
              routeTableAssociationId: assoc.RouteTableAssociationId,
              routeTableId: assoc.RouteTableId,
              subnetId: assoc.SubnetId,
              gatewayId: assoc.GatewayId,
              associationState: assoc.AssociationState
                ? {
                    state: assoc.AssociationState.State!,
                    statusMessage: assoc.AssociationState.StatusMessage,
                  }
                : undefined,
            })),
            routes: final.Routes?.map((route) => ({
              destinationCidrBlock: route.DestinationCidrBlock,
              destinationIpv6CidrBlock: route.DestinationIpv6CidrBlock,
              destinationPrefixListId: route.DestinationPrefixListId,
              egressOnlyInternetGatewayId: route.EgressOnlyInternetGatewayId,
              gatewayId: route.GatewayId,
              instanceId: route.InstanceId,
              instanceOwnerId: route.InstanceOwnerId,
              natGatewayId: route.NatGatewayId,
              transitGatewayId: route.TransitGatewayId,
              localGatewayId: route.LocalGatewayId,
              carrierGatewayId: route.CarrierGatewayId,
              networkInterfaceId: route.NetworkInterfaceId,
              origin: route.Origin!,
              state: route.State!,
              vpcPeeringConnectionId: route.VpcPeeringConnectionId,
              coreNetworkArn: route.CoreNetworkArn,
            })),
            propagatingVgws: final.PropagatingVgws?.map((vgw) => ({
              gatewayId: vgw.GatewayId!,
            })),
          };
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const routeTableId = output.routeTableId;

          yield* session.note(`Deleting route table: ${routeTableId}`);

          // 1. Attempt to delete route table
          yield* ec2
            .deleteRouteTable({
              RouteTableId: routeTableId,
              DryRun: false,
            })
            .pipe(
              Effect.tapError(Effect.logDebug),
              Effect.catchTag(
                "InvalidRouteTableID.NotFound",
                () => Effect.void,
              ),
              // Retry on dependency violations (associations still being deleted)
              Effect.retry({
                // DependencyViolation means there are still dependent resources
                while: (e) => {
                  return e._tag === "DependencyViolation";
                },
                schedule: Schedule.max([
                  Schedule.fixed(3000),
                  Schedule.recurs(10),
                ]).pipe(
                  Schedule.tap(({ attempt }) =>
                    session.note(
                      `Waiting for dependencies to clear... (attempt ${attempt})`,
                    ),
                  ),
                ),
              }),
            );

          // 2. Wait for route table to be fully deleted
          yield* waitForRouteTableDeleted(routeTableId, session);

          yield* session.note(
            `Route table ${routeTableId} deleted successfully`,
          );
        }),
      };
    }),
  );

/**
 * Describe a route table by ID
 */
const describeRouteTable = (
  routeTableId: string,
  _session?: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    const result = yield* ec2
      .describeRouteTables({ RouteTableIds: [routeTableId] })
      .pipe(
        Effect.catchTag("InvalidRouteTableID.NotFound", () =>
          Effect.succeed({ RouteTables: [] }),
        ),
      );

    const routeTable = result.RouteTables?.[0];
    if (!routeTable) {
      // createRouteTable can return before the new ID is visible to
      // describeRouteTables. Keep the ID in this reconcile and retry the
      // observation instead of failing after create and losing the only
      // handle the engine has for cleanup.
      return yield* new RouteTableNotVisible({ routeTableId });
    }
    return routeTable;
  }).pipe(
    Effect.retry({
      while: (error) => error instanceof RouteTableNotVisible,
      schedule: Schedule.max([Schedule.fixed(500), Schedule.recurs(10)]),
    }),
  );

class RouteTableNotVisible extends Data.TaggedError("RouteTableNotVisible")<{
  routeTableId: string;
}> {}

/**
 * Wait for route table to be deleted
 */
const waitForRouteTableDeleted = (
  routeTableId: string,
  session: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    yield* Effect.retry(
      Effect.gen(function* () {
        const result = yield* ec2
          .describeRouteTables({ RouteTableIds: [routeTableId] })
          .pipe(
            Effect.tapError(Effect.logDebug),
            Effect.catchTag("InvalidRouteTableID.NotFound", () =>
              Effect.succeed({ RouteTables: [] }),
            ),
          );

        if (!result.RouteTables || result.RouteTables.length === 0) {
          return; // Successfully deleted
        }

        // Still exists, fail to trigger retry
        return yield* Effect.fail(new Error("Route table still exists"));
      }),
      {
        schedule: Schedule.max([
          Schedule.fixed(2000),
          Schedule.recurs(10),
        ]).pipe(
          Schedule.tap(({ attempt }) =>
            session.note(
              `Waiting for route table deletion... (${attempt * 2}s)`,
            ),
          ),
        ),
      },
    );
  });
