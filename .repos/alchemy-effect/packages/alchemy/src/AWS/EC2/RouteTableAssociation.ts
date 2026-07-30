import type * as EC2 from "@distilled.cloud/aws/ec2";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { RouteTableId } from "./RouteTable.ts";
import type { SubnetId } from "./Subnet.ts";

export type RouteTableAssociationId<ID extends string = string> =
  `rtbassoc-${ID}`;
export const RouteTableAssociationId = <ID extends string>(
  id: ID,
): ID & RouteTableAssociationId<ID> =>
  `rtbassoc-${id}` as ID & RouteTableAssociationId<ID>;

export interface RouteTableAssociationProps {
  /**
   * The ID of the route table.
   * Required.
   */
  routeTableId: RouteTableId;

  /**
   * The ID of the subnet to associate with the route table.
   * Either subnetId or gatewayId is required, but not both.
   */
  subnetId?: SubnetId;

  /**
   * The ID of the gateway (internet gateway or virtual private gateway) to associate with the route table.
   * Either subnetId or gatewayId is required, but not both.
   */
  gatewayId?: string;
}

export interface RouteTableAssociation extends Resource<
  "AWS.EC2.RouteTableAssociation",
  RouteTableAssociationProps,
  {
    /**
     * The ID of the association.
     */
    associationId: RouteTableAssociationId;

    /**
     * The ID of the route table.
     */
    routeTableId: RouteTableId;

    /**
     * The ID of the subnet (if the association is with a subnet).
     */
    subnetId?: SubnetId | undefined;

    /**
     * The ID of the gateway (if the association is with a gateway).
     */
    gatewayId?: string | undefined;

    /**
     * The state of the association.
     */
    associationState: {
      state: EC2.RouteTableAssociationStateCode;
      statusMessage?: string;
    };
  },
  never,
  Providers
> {}
/**
 * Associates a {@link RouteTable} with a subnet (or a gateway), making that
 * route table govern traffic for the associated resource. A subnet can be
 * associated with exactly one route table at a time; multiple subnets may share
 * the same route table.
 *
 * Provide exactly one of `subnetId` or `gatewayId`. Changing the subnet or
 * gateway replaces the association, whereas pointing an existing association at
 * a different route table is applied in place via
 * `ReplaceRouteTableAssociation`.
 *
 * @resource
 * @section Associating Subnets
 * Associating a subnet overrides the VPC's main route table for that subnet.
 * This is how you make a subnet "public" (associate it with a table that has an
 * internet-gateway route) or "private" (associate it with a NAT-gateway table).
 *
 * @example Associate a Subnet with a Route Table
 * ```typescript
 * const association = yield* AWS.EC2.RouteTableAssociation("PublicSubnetAssociation", {
 *   routeTableId: publicRouteTable.routeTableId,
 *   subnetId: publicSubnet.subnetId,
 * });
 * ```
 * Binds a single subnet to the route table so its instances follow that
 * table's routes. The returned `associationId` (prefixed `rtbassoc-`) can be
 * used to track or replace the association.
 *
 * @example Share One Route Table Across Multiple Subnets
 * ```typescript
 * const subnet1Association = yield* AWS.EC2.RouteTableAssociation("PublicSubnet1Association", {
 *   routeTableId: publicRouteTable.routeTableId,
 *   subnetId: publicSubnet1.subnetId,
 * });
 *
 * const subnet2Association = yield* AWS.EC2.RouteTableAssociation("PublicSubnet2Association", {
 *   routeTableId: publicRouteTable.routeTableId,
 *   subnetId: publicSubnet2.subnetId,
 * });
 * ```
 * Declaring multiple associations against the same `routeTableId` gives every
 * listed subnet identical routing — a concise way to apply one public (or
 * private) routing policy across all subnets in a tier.
 *
 * @section Associating Gateways (Edge Routing)
 * Instead of a subnet, an association can target an internet gateway or
 * virtual private gateway via `gatewayId`. This "gateway route table
 * association" enables edge routing, where inbound traffic is inspected or
 * redirected (e.g. to a firewall appliance) as it enters the VPC.
 *
 * @example Associate a Route Table with an Internet Gateway
 * ```typescript
 * const edgeAssociation = yield* AWS.EC2.RouteTableAssociation("EdgeAssociation", {
 *   routeTableId: ingressRouteTable.routeTableId,
 *   gatewayId: internetGateway.internetGatewayId,
 * });
 * ```
 * Attaches the route table at the gateway rather than at a subnet, so traffic
 * arriving from the internet is steered by this table — typically toward an
 * inspection appliance before reaching its destination subnet.
 */
export const RouteTableAssociation = Resource<RouteTableAssociation>(
  "AWS.EC2.RouteTableAssociation",
);

export const RouteTableAssociationProvider = () =>
  Provider.effect(
    RouteTableAssociation,
    Effect.gen(function* () {
      return {
        stables: ["associationId", "subnetId", "gatewayId"],

        // Associations are embedded in describeRouteTables — each RouteTable
        // carries an Associations[] of {subnet/gateway, routeTable,
        // associationId}. Flatten every page's associations across the region.
        // The implicit "main" association (the VPC default route-table binding)
        // is skipped: it isn't a standalone resource we create or manage.
        list: () =>
          ec2.describeRouteTables.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.RouteTables ?? []).flatMap((rt) =>
                  (rt.Associations ?? [])
                    .filter(
                      (
                        a,
                      ): a is EC2.RouteTableAssociation & {
                        RouteTableAssociationId: string;
                        RouteTableId: string;
                      } =>
                        a.Main !== true &&
                        a.RouteTableAssociationId != null &&
                        a.RouteTableId != null,
                    )
                    .map((a) => ({
                      associationId:
                        a.RouteTableAssociationId as RouteTableAssociationId,
                      routeTableId: a.RouteTableId as RouteTableId,
                      subnetId: a.SubnetId as SubnetId | undefined,
                      gatewayId: a.GatewayId,
                      associationState: {
                        state: a.AssociationState?.State ?? "associated",
                        statusMessage: a.AssociationState?.StatusMessage,
                      },
                    })),
                ),
              ),
            ),
          ),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          // Subnet/Gateway change requires replacement (use ReplaceRouteTableAssociation internally)
          if (olds.subnetId !== news.subnetId) {
            return { action: "replace" };
          }
          if (olds.gatewayId !== news.gatewayId) {
            return { action: "replace" };
          }
          // Route table change can be done via ReplaceRouteTableAssociation
        }),

        reconcile: Effect.fn(function* ({ news, output, session }) {
          // Observe — try the cached associationId first; if the association
          // was disassociated out-of-band, fall through to AssociateRouteTable.
          let observed:
            | {
                associationId: string;
                routeTableId: string;
                subnetId?: string;
                gatewayId?: string;
                state?: EC2.RouteTableAssociationStateCode;
                statusMessage?: string;
              }
            | undefined;
          if (output?.associationId) {
            const lookup = yield* ec2
              .describeRouteTables({
                Filters: [
                  {
                    Name: "association.route-table-association-id",
                    Values: [output.associationId],
                  },
                ],
              })
              .pipe(
                Effect.catchTag("InvalidRouteTableID.NotFound", () =>
                  Effect.succeed({ RouteTables: [] }),
                ),
              );
            for (const rt of lookup.RouteTables ?? []) {
              const assoc = rt.Associations?.find(
                (a) => a.RouteTableAssociationId === output.associationId,
              );
              if (assoc) {
                observed = {
                  associationId: assoc.RouteTableAssociationId!,
                  routeTableId: assoc.RouteTableId!,
                  subnetId: assoc.SubnetId,
                  gatewayId: assoc.GatewayId,
                  state: assoc.AssociationState?.State,
                  statusMessage: assoc.AssociationState?.StatusMessage,
                };
                break;
              }
            }
          }

          // Ensure — no existing association ⇒ AssociateRouteTable.
          if (observed === undefined) {
            const result = yield* ec2
              .associateRouteTable({
                RouteTableId: news.routeTableId,
                SubnetId: news.subnetId,
                GatewayId: news.gatewayId,
                DryRun: false,
              })
              .pipe(
                Effect.retry({
                  while: (e) =>
                    e._tag === "InvalidRouteTableID.NotFound" ||
                    e._tag === "InvalidSubnetID.NotFound",
                  schedule: Schedule.exponential(100),
                }),
              );
            const associationId =
              result.AssociationId! as RouteTableAssociationId;
            yield* session.note(
              `Route table association created: ${associationId}`,
            );
            yield* waitForAssociationState(
              news.routeTableId,
              associationId,
              "associated",
              session,
            );
            return {
              associationId,
              routeTableId: news.routeTableId as RouteTableId,
              subnetId: news.subnetId as SubnetId | undefined,
              gatewayId: news.gatewayId as string | undefined,
              associationState: {
                state: result.AssociationState?.State ?? "associated",
                statusMessage: result.AssociationState?.StatusMessage,
              },
            };
          }

          // Sync — drift in routeTableId is patched in place by
          // ReplaceRouteTableAssociation. Subnet/gateway changes are
          // intercepted upstream by `diff` as a replacement.
          if (observed.routeTableId !== (news.routeTableId as string)) {
            const result = yield* ec2.replaceRouteTableAssociation({
              AssociationId: observed.associationId,
              RouteTableId: news.routeTableId,
              DryRun: false,
            });
            const newAssociationId =
              result.NewAssociationId! as RouteTableAssociationId;
            yield* session.note(
              `Route table association replaced: ${newAssociationId}`,
            );
            yield* waitForAssociationState(
              news.routeTableId,
              newAssociationId,
              "associated",
              session,
            );
            return {
              associationId: newAssociationId,
              routeTableId: news.routeTableId as RouteTableId,
              subnetId: news.subnetId as SubnetId | undefined,
              gatewayId: news.gatewayId as string | undefined,
              associationState: {
                state: result.AssociationState?.State ?? "associated",
                statusMessage: result.AssociationState?.StatusMessage,
              },
            };
          }

          // Already in the desired state — just report it.
          return {
            associationId: observed.associationId as RouteTableAssociationId,
            routeTableId: observed.routeTableId as RouteTableId,
            subnetId: observed.subnetId as SubnetId | undefined,
            gatewayId: observed.gatewayId,
            associationState: {
              state: observed.state ?? "associated",
              statusMessage: observed.statusMessage,
            },
          };
        }),

        delete: Effect.fn(function* ({ output, session }) {
          yield* session.note(
            `Deleting route table association: ${output.associationId}`,
          );

          // Disassociate the route table
          yield* ec2
            .disassociateRouteTable({
              AssociationId: output.associationId,
              DryRun: false,
            })
            .pipe(
              Effect.tapError(Effect.log),
              Effect.catchTag(
                "InvalidAssociationID.NotFound",
                () => Effect.void,
              ),
            );

          yield* session.note(
            `Route table association ${output.associationId} deleted successfully`,
          );
        }),
      };
    }),
  );

/**
 * Wait for association to reach a specific state
 */
const waitForAssociationState = (
  routeTableId: string,
  associationId: string,
  targetState:
    | "associating"
    | "associated"
    | "disassociating"
    | "disassociated",
  session?: ScopedPlanStatusSession,
) =>
  Effect.retry(
    Effect.gen(function* () {
      const result = yield* ec2
        .describeRouteTables({ RouteTableIds: [routeTableId] })
        .pipe(
          Effect.catchTag("InvalidRouteTableID.NotFound", () =>
            Effect.succeed({
              RouteTables: [],
            } as ec2.DescribeRouteTablesResult),
          ),
        );

      const routeTable = result.RouteTables?.[0];
      if (!routeTable) {
        return yield* Effect.fail(new Error("Route table not found"));
      }

      const association = routeTable.Associations?.find(
        (a) => a.RouteTableAssociationId === associationId,
      );

      if (!association) {
        // Association might not exist yet, retry
        return yield* Effect.fail(new Error("Association not found"));
      }

      if (association.AssociationState?.State === targetState) {
        return;
      }

      if (association.AssociationState?.State === "failed") {
        return yield* Effect.fail(
          new Error(
            `Association failed: ${association.AssociationState.StatusMessage}`,
          ),
        );
      }

      // Still in progress, fail to trigger retry
      return yield* Effect.fail(
        new Error(`Association state: ${association.AssociationState?.State}`),
      );
    }),
    {
      schedule: Schedule.max([Schedule.fixed(1000), Schedule.recurs(30)]).pipe(
        Schedule.tap(({ attempt }) =>
          session
            ? session.note(
                `Waiting for association to be ${targetState}... (${attempt}s)`,
              )
            : Effect.void,
        ),
      ),
    },
  );
