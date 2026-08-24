import type * as EC2 from "@distilled.cloud/aws/ec2";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { isResolved, somePropsAreDifferent } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { getDefaultVpcScope } from "./defaultVpcScope.ts";
import type { RouteTableId } from "./RouteTable.ts";

export interface RouteProps {
  /**
   * The ID of the route table where the route will be added.
   * Required.
   */
  routeTableId: RouteTableId;

  /**
   * The IPv4 CIDR block used for the destination match.
   * Either destinationCidrBlock, destinationIpv6CidrBlock, or destinationPrefixListId is required.
   * @example "0.0.0.0/0"
   */
  destinationCidrBlock?: string;

  /**
   * The IPv6 CIDR block used for the destination match.
   * Either destinationCidrBlock, destinationIpv6CidrBlock, or destinationPrefixListId is required.
   * @example "::/0"
   */
  destinationIpv6CidrBlock?: string;

  /**
   * The ID of a prefix list used for the destination match.
   * Either destinationCidrBlock, destinationIpv6CidrBlock, or destinationPrefixListId is required.
   */
  destinationPrefixListId?: string;

  // ---- Target properties (exactly one required) ----

  /**
   * The ID of an internet gateway or virtual private gateway.
   */
  gatewayId?: string;

  /**
   * The ID of a NAT gateway.
   */
  natGatewayId?: string;

  /**
   * The ID of a NAT instance in your VPC.
   * This operation fails unless exactly one network interface is attached.
   */
  instanceId?: string;

  /**
   * The ID of a network interface.
   */
  networkInterfaceId?: string;

  /**
   * The ID of a VPC peering connection.
   */
  vpcPeeringConnectionId?: string;

  /**
   * The ID of a transit gateway.
   */
  transitGatewayId?: string;

  /**
   * The ID of a local gateway.
   */
  localGatewayId?: string;

  /**
   * The ID of a carrier gateway.
   * Use for Wavelength Zones only.
   */
  carrierGatewayId?: string;

  /**
   * The ID of an egress-only internet gateway.
   * IPv6 traffic only.
   */
  egressOnlyInternetGatewayId?: string;

  /**
   * The Amazon Resource Name (ARN) of the core network.
   */
  coreNetworkArn?: string;

  /**
   * The ID of a VPC endpoint for Gateway Load Balancer.
   */
  vpcEndpointId?: string;
}

export interface Route extends Resource<
  "AWS.EC2.Route",
  RouteProps,
  {
    /**
     * The ID of the route table that contains this route.
     */
    routeTableId: RouteTableId;
    /**
     * The IPv4 CIDR block used for the destination match.
     */
    destinationCidrBlock?: string | undefined;
    /**
     * The IPv6 CIDR block used for the destination match.
     */
    destinationIpv6CidrBlock?: string | undefined;
    /**
     * The ID of the prefix list used for the destination match.
     */
    destinationPrefixListId?: string | undefined;
    /**
     * Describes how the route was created (e.g. `CreateRoute`).
     */
    origin: EC2.RouteOrigin;
    /**
     * The state of the route (e.g. `active` or `blackhole`).
     */
    state: EC2.RouteState;
    /**
     * The ID of the internet gateway or virtual private gateway the route targets.
     */
    gatewayId?: string;
    /**
     * The ID of the NAT gateway the route targets.
     */
    natGatewayId?: string;
    /**
     * The ID of the NAT instance the route targets.
     */
    instanceId?: string;
    /**
     * The ID of the network interface the route targets.
     */
    networkInterfaceId?: string;
    /**
     * The ID of the VPC peering connection the route targets.
     */
    vpcPeeringConnectionId?: string;
    /**
     * The ID of the transit gateway the route targets.
     */
    transitGatewayId?: string;
    /**
     * The ID of the local gateway the route targets.
     */
    localGatewayId?: string;
    /**
     * The ID of the carrier gateway the route targets.
     */
    carrierGatewayId?: string;
    /**
     * The ID of the egress-only internet gateway the route targets (IPv6 only).
     */
    egressOnlyInternetGatewayId?: string;
    /**
     * The Amazon Resource Name (ARN) of the core network the route targets.
     */
    coreNetworkArn?: string;
  },
  never,
  Providers
> {}
/**
 * A single route entry inside a {@link RouteTable}. A route maps a destination
 * to exactly one target, telling the VPC where to send packets whose address
 * falls within the destination range.
 *
 * Every route has two halves:
 * - **Destination** — exactly one of `destinationCidrBlock` (IPv4),
 *   `destinationIpv6CidrBlock` (IPv6), or `destinationPrefixListId` (a managed
 *   prefix list, e.g. for an AWS service).
 * - **Target** — exactly one of `gatewayId` (internet/virtual private
 *   gateway), `natGatewayId`, `instanceId` (NAT instance), `networkInterfaceId`,
 *   `vpcPeeringConnectionId`, `transitGatewayId`, `localGatewayId` (Outposts),
 *   `carrierGatewayId` (Wavelength), `egressOnlyInternetGatewayId` (IPv6),
 *   `coreNetworkArn` (Cloud WAN), or `vpcEndpointId` (Gateway Load Balancer).
 *
 * Changing the `routeTableId` or the destination replaces the route, whereas
 * changing only the target is applied in place via `ReplaceRoute`.
 *
 * @resource
 * @section IPv4 Routing
 * Use an IPv4 `destinationCidrBlock` — most commonly `0.0.0.0/0` for the
 * default route, or a narrower CIDR to route specific traffic.
 *
 * @example Default Route to an Internet Gateway
 * ```typescript
 * const internetRoute = yield* AWS.EC2.Route("InternetRoute", {
 *   routeTableId: publicRouteTable.routeTableId,
 *   destinationCidrBlock: "0.0.0.0/0",
 *   gatewayId: internetGateway.internetGatewayId,
 * });
 * ```
 * Sends all outbound IPv4 traffic to the internet gateway, which is what makes
 * a subnet "public". Attach this route table to any subnet that needs inbound
 * and outbound internet connectivity.
 *
 * @example Default Route to a NAT Gateway
 * ```typescript
 * const natRoute = yield* AWS.EC2.Route("NatRoute", {
 *   routeTableId: privateRouteTable.routeTableId,
 *   destinationCidrBlock: "0.0.0.0/0",
 *   natGatewayId: natGateway.natGatewayId,
 * });
 * ```
 * Lets private subnets reach the internet for outbound traffic (package
 * updates, API calls) while blocking unsolicited inbound connections. The NAT
 * gateway itself lives in a public subnet.
 *
 * @example Route to a VPC Peering Connection
 * ```typescript
 * const peeringRoute = yield* AWS.EC2.Route("PeeringRoute", {
 *   routeTableId: routeTable.routeTableId,
 *   destinationCidrBlock: "10.1.0.0/16",
 *   vpcPeeringConnectionId: "pcx-0abc1234",
 * });
 * ```
 * Routes traffic destined for the peer VPC's CIDR across a VPC peering
 * connection. Use a narrow destination matching the remote VPC rather than
 * `0.0.0.0/0` so only cross-VPC traffic is affected.
 *
 * @example Route to a Transit Gateway
 * ```typescript
 * const transitRoute = yield* AWS.EC2.Route("TransitRoute", {
 *   routeTableId: routeTable.routeTableId,
 *   destinationCidrBlock: "172.16.0.0/12",
 *   transitGatewayId: "tgw-0abc1234",
 * });
 * ```
 * Hands traffic to a transit gateway, the hub used to connect many VPCs and
 * on-premises networks. The destination CIDR should cover the address space
 * reachable through the transit gateway.
 *
 * @example Route to a Network Interface or NAT Instance
 * ```typescript
 * const applianceRoute = yield* AWS.EC2.Route("ApplianceRoute", {
 *   routeTableId: routeTable.routeTableId,
 *   destinationCidrBlock: "0.0.0.0/0",
 *   networkInterfaceId: "eni-0abc1234",
 * });
 * ```
 * Forwards traffic to a specific elastic network interface — for example a
 * firewall or NAT instance appliance. Use `instanceId` instead when targeting
 * a NAT instance that has exactly one network interface attached.
 *
 * @section IPv6 Routing
 * IPv6 routes use `destinationIpv6CidrBlock` (e.g. `::/0` for the IPv6 default
 * route). For outbound-only IPv6 access from private subnets, target an
 * {@link EgressOnlyInternetGateway}.
 *
 * @example IPv6 Egress Route to an Egress-Only Internet Gateway
 * ```typescript
 * const ipv6EgressRoute = yield* AWS.EC2.Route("Ipv6EgressRoute", {
 *   routeTableId: privateRouteTable.routeTableId,
 *   destinationIpv6CidrBlock: "::/0",
 *   egressOnlyInternetGatewayId: egressOnlyIgw.egressOnlyInternetGatewayId,
 * });
 * ```
 * Gives IPv6-addressed instances outbound internet access while blocking
 * inbound connections — the IPv6 equivalent of routing IPv4 through a NAT
 * gateway.
 *
 * @example IPv6 Internet Route to an Internet Gateway
 * ```typescript
 * const ipv6InternetRoute = yield* AWS.EC2.Route("Ipv6InternetRoute", {
 *   routeTableId: publicRouteTable.routeTableId,
 *   destinationIpv6CidrBlock: "::/0",
 *   gatewayId: internetGateway.internetGatewayId,
 * });
 * ```
 * Provides full bidirectional IPv6 connectivity for a public subnet, since an
 * internet gateway (unlike an egress-only gateway) allows inbound IPv6 traffic.
 *
 * @section Routing to AWS Services via Prefix Lists
 * Instead of a raw CIDR, a route can match a managed prefix list — useful for
 * AWS service ranges (e.g. an S3 gateway endpoint) where the underlying CIDRs
 * change over time.
 *
 * @example Prefix List Route to a Gateway VPC Endpoint
 * ```typescript
 * const prefixListRoute = yield* AWS.EC2.Route("S3PrefixRoute", {
 *   routeTableId: privateRouteTable.routeTableId,
 *   destinationPrefixListId: "pl-0abc1234",
 *   vpcEndpointId: "vpce-0abc1234",
 * });
 * ```
 * Routes traffic for every CIDR in the prefix list to a Gateway Load Balancer
 * VPC endpoint. AWS keeps the prefix list current, so you don't have to update
 * the route when the service's address ranges change.
 */
export const Route = Resource<Route>("AWS.EC2.Route");

export const RouteProvider = () =>
  Provider.effect(
    Route,
    Effect.gen(function* () {
      return {
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          // Route table change requires replacement
          if (olds.routeTableId !== news.routeTableId) {
            return { action: "replace" };
          }

          // Destination change requires replacement
          if (
            somePropsAreDifferent(olds, news, [
              "destinationCidrBlock",
              "destinationIpv6CidrBlock",
              "destinationPrefixListId",
            ])
          ) {
            return { action: "replace" };
          }

          // Target change can be done via ReplaceRoute (update)
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          const dest =
            news.destinationCidrBlock ||
            news.destinationIpv6CidrBlock ||
            news.destinationPrefixListId ||
            "unknown";

          const targetParams = {
            RouteTableId: news.routeTableId,
            DestinationCidrBlock: news.destinationCidrBlock,
            DestinationIpv6CidrBlock: news.destinationIpv6CidrBlock,
            DestinationPrefixListId: news.destinationPrefixListId,
            GatewayId: news.gatewayId,
            NatGatewayId: news.natGatewayId,
            InstanceId: news.instanceId,
            NetworkInterfaceId: news.networkInterfaceId,
            VpcPeeringConnectionId: news.vpcPeeringConnectionId,
            TransitGatewayId: news.transitGatewayId,
            LocalGatewayId: news.localGatewayId,
            CarrierGatewayId: news.carrierGatewayId,
            EgressOnlyInternetGatewayId: news.egressOnlyInternetGatewayId,
            CoreNetworkArn: news.coreNetworkArn,
            DryRun: false,
          } as const;

          // Observe — Routes are identified by (routeTableId, destination).
          // Look the route up in the route table to decide between create
          // (missing) and replaceRoute (target drift).
          const observed = yield* describeRoute(news.routeTableId, news);

          // Ensure / Sync — CreateRoute when missing, ReplaceRoute swaps the
          // target on an existing route in-place.
          if (observed === undefined) {
            yield* ec2
              .createRoute({
                ...targetParams,
                VpcEndpointId: news.vpcEndpointId,
              })
              .pipe(
                Effect.retry({
                  while: (e) => e._tag === "InvalidRouteTableID.NotFound",
                  schedule: Schedule.exponential(100),
                }),
              );
            yield* session.note(`Route created: ${dest}`);
          } else {
            yield* ec2.replaceRoute(targetParams).pipe(
              Effect.tapError(Effect.log),
              Effect.retry({
                while: (e) => e._tag === "InvalidRouteTableID.NotFound",
                schedule: Schedule.exponential(100),
              }),
            );
            yield* session.note(`Route target updated: ${dest}`);
          }

          // Re-read final state.
          const route = yield* describeRoute(news.routeTableId, news);
          return {
            routeTableId: news.routeTableId,
            destinationCidrBlock: news.destinationCidrBlock,
            destinationIpv6CidrBlock: news.destinationIpv6CidrBlock,
            destinationPrefixListId: news.destinationPrefixListId,
            origin: route?.Origin ?? "CreateRoute",
            state: route?.State ?? "active",
            gatewayId: route?.GatewayId,
            natGatewayId: route?.NatGatewayId,
            instanceId: route?.InstanceId,
            networkInterfaceId: route?.NetworkInterfaceId,
            vpcPeeringConnectionId: route?.VpcPeeringConnectionId,
            transitGatewayId: route?.TransitGatewayId,
            localGatewayId: route?.LocalGatewayId,
            carrierGatewayId: route?.CarrierGatewayId,
            egressOnlyInternetGatewayId: route?.EgressOnlyInternetGatewayId,
            coreNetworkArn: route?.CoreNetworkArn,
          };
        }),

        // Routes are entries embedded inside RouteTables. Enumerate by
        // flattening describeRouteTables -> RouteTables[].Routes[], pairing each
        // route with its parent routeTableId. Skip the implicit local route
        // (GatewayId === "local", Origin "CreateRouteTable") that AWS creates
        // automatically and that this provider does not manage.
        list: () =>
          Effect.gen(function* () {
            // Routes in the default VPC's main route table (the 0.0.0.0/0 IGW
            // route AWS provisions) are default-VPC furniture; never
            // census/nuke them. Routes in user-created route tables inside the
            // default VPC are still listed.
            const defaultVpc = yield* getDefaultVpcScope;
            return yield* ec2.describeRouteTables.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.RouteTables ?? []).flatMap((rt) => {
                    const routeTableId = rt.RouteTableId;
                    if (routeTableId === undefined) return [];
                    if (
                      defaultVpc.vpcId !== undefined &&
                      rt.VpcId === defaultVpc.vpcId &&
                      rt.Associations?.some((a) => a.Main)
                    ) {
                      return [];
                    }
                    return (rt.Routes ?? [])
                      .filter(
                        (r) =>
                          r.GatewayId !== "local" &&
                          // VPC Lattice injects service-managed routes while
                          // a VPC association is active. They cannot be
                          // deleted through EC2 and drain with the association.
                          r.GatewayId !== "VpcLattice",
                      )
                      .map((r) => ({
                        routeTableId: routeTableId as RouteTableId,
                        destinationCidrBlock: r.DestinationCidrBlock,
                        destinationIpv6CidrBlock: r.DestinationIpv6CidrBlock,
                        destinationPrefixListId: r.DestinationPrefixListId,
                        origin: r.Origin ?? "CreateRoute",
                        state: r.State ?? "active",
                        gatewayId: r.GatewayId,
                        natGatewayId: r.NatGatewayId,
                        instanceId: r.InstanceId,
                        networkInterfaceId: r.NetworkInterfaceId,
                        vpcPeeringConnectionId: r.VpcPeeringConnectionId,
                        transitGatewayId: r.TransitGatewayId,
                        localGatewayId: r.LocalGatewayId,
                        carrierGatewayId: r.CarrierGatewayId,
                        egressOnlyInternetGatewayId:
                          r.EgressOnlyInternetGatewayId,
                        coreNetworkArn: r.CoreNetworkArn,
                      }));
                  }),
                ),
              ),
            );
          }),

        delete: Effect.fn(function* ({ output, session }) {
          const dest =
            output.destinationCidrBlock ||
            output.destinationIpv6CidrBlock ||
            output.destinationPrefixListId ||
            "unknown";

          yield* session.note(`Deleting route: ${dest}`);

          // Delete the route
          yield* ec2
            .deleteRoute({
              RouteTableId: output.routeTableId,
              DestinationCidrBlock: output.destinationCidrBlock,
              DestinationIpv6CidrBlock: output.destinationIpv6CidrBlock,
              DestinationPrefixListId: output.destinationPrefixListId,
              DryRun: false,
            })
            .pipe(
              Effect.tapError(Effect.logDebug),
              Effect.catchTag("InvalidRoute.NotFound", () => Effect.void),
              Effect.catchTag(
                "InvalidRouteTableID.NotFound",
                () => Effect.void,
              ),
            );

          yield* session.note(`Route ${dest} deleted successfully`);
        }),
      };
    }),
  );

/**
 * Find a specific route in a route table
 */
const describeRoute = (routeTableId: string, props: RouteProps) =>
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
      return undefined;
    }

    // Find the matching route
    const route = routeTable.Routes?.find((r) => {
      if (props.destinationCidrBlock) {
        return r.DestinationCidrBlock === props.destinationCidrBlock;
      }
      if (props.destinationIpv6CidrBlock) {
        return r.DestinationIpv6CidrBlock === props.destinationIpv6CidrBlock;
      }
      if (props.destinationPrefixListId) {
        return r.DestinationPrefixListId === props.destinationPrefixListId;
      }
      return false;
    });

    return route;
  });
