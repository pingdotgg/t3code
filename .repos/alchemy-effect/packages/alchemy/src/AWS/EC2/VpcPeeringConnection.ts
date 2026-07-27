import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, createTagsList, diffTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { VpcId } from "./Vpc.ts";

export type VpcPeeringConnectionId<ID extends string = string> = `pcx-${ID}`;
export const VpcPeeringConnectionId = <ID extends string>(
  id: ID,
): ID & VpcPeeringConnectionId<ID> =>
  `pcx-${id}` as ID & VpcPeeringConnectionId<ID>;

export type VpcPeeringConnectionStatus =
  | "initiating-request"
  | "pending-acceptance"
  | "active"
  | "deleted"
  | "rejected"
  | "failed"
  | "expired"
  | "provisioning"
  | "deleting";

// Terminal states from which a peering connection cannot recover — observing
// one of these means the cached connection is dead and must be recreated.
const DEAD_STATES = new Set<string>([
  "deleted",
  "deleting",
  "rejected",
  "failed",
  "expired",
]);

export interface VpcPeeringConnectionProps {
  /**
   * The ID of the requester VPC (the VPC you own that initiates the peering).
   * Immutable — changing it replaces the connection.
   */
  vpcId: VpcId;

  /**
   * The ID of the accepter VPC with which to create the connection. May belong
   * to another account (`peerOwnerId`) or Region (`peerRegion`). Immutable.
   */
  peerVpcId: VpcId;

  /**
   * The Region of the accepter VPC for an inter-Region peering. Defaults to the
   * requester's Region (same-Region peering). Immutable.
   */
  peerRegion?: string;

  /**
   * The AWS account ID of the accepter VPC owner. Defaults to the requester's
   * account (same-account peering). Immutable.
   */
  peerOwnerId?: string;

  /**
   * Whether to automatically accept the peering request. Only possible for
   * same-account, same-Region peering (the accepter side must be reachable
   * with the same credentials). Defaults to `true` when the peer is in the same
   * account and Region, `false` otherwise (a cross-account/Region request stays
   * in `pending-acceptance` until the peer accepts it out of band).
   */
  autoAccept?: boolean;

  /**
   * Tags to assign to the peering connection.
   */
  tags?: Record<string, string>;
}

export interface VpcPeeringConnection extends Resource<
  "AWS.EC2.VpcPeeringConnection",
  VpcPeeringConnectionProps,
  {
    /**
     * The ID of the VPC peering connection (prefixed `pcx-`).
     */
    vpcPeeringConnectionId: VpcPeeringConnectionId;

    /**
     * The current status code of the peering connection.
     */
    status: VpcPeeringConnectionStatus;

    /**
     * The ID of the requester VPC.
     */
    requesterVpcId: VpcId;

    /**
     * The ID of the accepter VPC.
     */
    accepterVpcId: VpcId;

    /**
     * The AWS account ID of the accepter VPC owner.
     */
    accepterOwnerId: string;
  },
  never,
  Providers
> {}

/**
 * A VPC peering connection links two VPCs so resources in each can communicate
 * using private IP addresses, as if they were on the same network. The two VPCs
 * can be in the same account or different accounts, and the same Region or
 * different Regions. Their CIDR blocks must not overlap.
 *
 * A peering connection is a two-sided handshake: a *requester* VPC creates the
 * request and an *accepter* VPC accepts it. For same-account, same-Region
 * peering alchemy accepts the request for you automatically (`autoAccept`
 * defaults to `true`); for cross-account or cross-Region peering the connection
 * is left in `pending-acceptance` for the peer to accept out of band. Once
 * `active`, add {@link Route}s on both sides pointing the peer CIDR at the
 * connection to actually carry traffic.
 *
 * @resource
 * @section Creating a Peering Connection
 * @example Same-Account Peering (auto-accepted)
 * ```typescript
 * const vpcA = yield* AWS.EC2.Vpc("VpcA", { cidrBlock: "10.0.0.0/16" });
 * const vpcB = yield* AWS.EC2.Vpc("VpcB", { cidrBlock: "10.1.0.0/16" });
 *
 * const peering = yield* AWS.EC2.VpcPeeringConnection("Peering", {
 *   vpcId: vpcA.vpcId,
 *   peerVpcId: vpcB.vpcId,
 * });
 * ```
 * Because both VPCs are in the same account and Region, the request is accepted
 * automatically and the connection reaches the `active` state.
 *
 * @example Cross-Account Peering (accepted out of band)
 * ```typescript
 * const peering = yield* AWS.EC2.VpcPeeringConnection("Peering", {
 *   vpcId: myVpc.vpcId,
 *   peerVpcId: "vpc-0abc123",
 *   peerOwnerId: "123456789012",
 * });
 * ```
 * With a different `peerOwnerId` the connection stays in `pending-acceptance`
 * until the peer account accepts it.
 *
 * @section Routing Traffic Across the Peering
 * @example Route the Peer CIDR at the Connection
 * ```typescript
 * const peering = yield* AWS.EC2.VpcPeeringConnection("Peering", {
 *   vpcId: vpcA.vpcId,
 *   peerVpcId: vpcB.vpcId,
 * });
 *
 * const routeAtoB = yield* AWS.EC2.Route("RouteAtoB", {
 *   routeTableId: vpcARouteTable.routeTableId,
 *   destinationCidrBlock: "10.1.0.0/16",
 *   vpcPeeringConnectionId: peering.vpcPeeringConnectionId,
 * });
 * ```
 * Each side needs a route pointing the other VPC's CIDR at the peering
 * connection; only then can instances reach each other over private IPs.
 */
export const VpcPeeringConnection = Resource<VpcPeeringConnection>(
  "AWS.EC2.VpcPeeringConnection",
);

class PeeringNotSettled {
  readonly _tag = "PeeringNotSettled";
}

export const VpcPeeringConnectionProvider = () =>
  Provider.effect(
    VpcPeeringConnection,
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

      const describePeering = (pcxId: string) =>
        ec2
          .describeVpcPeeringConnections({ VpcPeeringConnectionIds: [pcxId] })
          .pipe(
            Effect.map((r) => r.VpcPeeringConnections?.[0]),
            Effect.catchTag("InvalidVpcPeeringConnectionID.NotFound", () =>
              Effect.succeed(undefined),
            ),
            Effect.catchTag("InvalidVpcPeeringConnectionId.NotFound", () =>
              Effect.succeed(undefined),
            ),
          );

      // Poll until the connection reaches a settled state (out of the transient
      // "initiating-request"/"provisioning" states) or becomes `target`.
      const waitFor = (pcxId: string, target: VpcPeeringConnectionStatus) =>
        describePeering(pcxId).pipe(
          Effect.flatMap((pcx) => {
            const code = pcx?.Status?.Code;
            if (code === target || (code && DEAD_STATES.has(code))) {
              return Effect.succeed(pcx);
            }
            return Effect.fail(new PeeringNotSettled());
          }),
          Effect.retry({
            while: (e) => e instanceof PeeringNotSettled,
            schedule: Schedule.max([Schedule.fixed(2000), Schedule.recurs(30)]),
          }),
        );

      const toAttrs = (pcx: ec2.VpcPeeringConnection) => ({
        vpcPeeringConnectionId:
          pcx.VpcPeeringConnectionId as VpcPeeringConnectionId,
        status: (pcx.Status?.Code ??
          "initiating-request") as VpcPeeringConnectionStatus,
        requesterVpcId: pcx.RequesterVpcInfo?.VpcId as VpcId,
        accepterVpcId: pcx.AccepterVpcInfo?.VpcId as VpcId,
        accepterOwnerId: pcx.AccepterVpcInfo?.OwnerId ?? "",
      });

      return {
        stables: ["vpcPeeringConnectionId"],

        list: () =>
          Effect.gen(function* () {
            const items = yield* ec2.describeVpcPeeringConnections
              .pages({})
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk).flatMap((page) =>
                    (page.VpcPeeringConnections ?? [])
                      .filter(
                        (
                          pcx,
                        ): pcx is ec2.VpcPeeringConnection & {
                          VpcPeeringConnectionId: string;
                        } =>
                          pcx.VpcPeeringConnectionId != null &&
                          !DEAD_STATES.has(pcx.Status?.Code ?? ""),
                      )
                      .map(toAttrs),
                  ),
                ),
              );
            return items satisfies VpcPeeringConnection["Attributes"][];
          }),

        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const pcx = yield* describePeering(output.vpcPeeringConnectionId);
          if (!pcx || DEAD_STATES.has(pcx.Status?.Code ?? "")) return undefined;
          return toAttrs(pcx);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (
            news.vpcId !== olds.vpcId ||
            news.peerVpcId !== olds.peerVpcId ||
            news.peerRegion !== olds.peerRegion ||
            news.peerOwnerId !== olds.peerOwnerId
          ) {
            return { action: "replace" };
          }
          // Only tags are mutable in place.
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const desiredTags = yield* createTags(id, news.tags);

          const sameAccount =
            news.peerOwnerId === undefined || news.peerOwnerId === accountId;
          const sameRegion =
            news.peerRegion === undefined || news.peerRegion === region;
          const autoAccept = news.autoAccept ?? (sameAccount && sameRegion);

          // Observe — the cached connection may have been deleted or moved to a
          // terminal state, in which case we recreate.
          let pcx: ec2.VpcPeeringConnection | undefined;
          if (output?.vpcPeeringConnectionId) {
            pcx = yield* describePeering(output.vpcPeeringConnectionId);
            if (pcx && DEAD_STATES.has(pcx.Status?.Code ?? "")) {
              pcx = undefined;
            }
          }

          // Ensure — create the connection if missing.
          if (pcx === undefined) {
            yield* session.note("Creating VPC peering connection...");
            const result = yield* ec2.createVpcPeeringConnection({
              VpcId: news.vpcId as string,
              PeerVpcId: news.peerVpcId as string,
              PeerRegion: news.peerRegion,
              PeerOwnerId: news.peerOwnerId,
              TagSpecifications: [
                {
                  ResourceType: "vpc-peering-connection",
                  Tags: createTagsList(desiredTags),
                },
              ],
            });
            pcx = result.VpcPeeringConnection!;
            yield* session.note(
              `VPC peering connection created: ${pcx.VpcPeeringConnectionId}`,
            );
          }

          const pcxId = pcx.VpcPeeringConnectionId!;

          // Accept — for same-account/same-Region peering, wait for the request
          // to settle into pending-acceptance, then accept it.
          if (autoAccept) {
            const settled = yield* waitFor(pcxId, "pending-acceptance");
            if (settled?.Status?.Code === "pending-acceptance") {
              yield* session.note("Accepting VPC peering connection...");
              yield* ec2
                .acceptVpcPeeringConnection({ VpcPeeringConnectionId: pcxId })
                .pipe(
                  // A concurrent reconcile may have accepted it already.
                  Effect.catchTag(
                    "InvalidVpcPeeringConnectionID.NotFound",
                    () => Effect.succeed(undefined),
                  ),
                  Effect.catchTag(
                    "InvalidVpcPeeringConnectionId.NotFound",
                    () => Effect.succeed(undefined),
                  ),
                );
              yield* waitFor(pcxId, "active");
            }
          }

          // Sync tags — observed cloud tags vs desired.
          const currentTags =
            (yield* ec2
              .describeTags({
                Filters: [
                  { Name: "resource-id", Values: [pcxId] },
                  {
                    Name: "resource-type",
                    Values: ["vpc-peering-connection"],
                  },
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
              Resources: [pcxId],
              Tags: removed.map((key) => ({ Key: key })),
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({ Resources: [pcxId], Tags: upsert });
          }

          const final = yield* describePeering(pcxId);
          return toAttrs(final ?? pcx);
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const pcxId = output.vpcPeeringConnectionId;

          // A connection already in a terminal state cannot (and need not) be
          // deleted — AWS rejects deleting failed/rejected connections.
          const observed = yield* describePeering(pcxId);
          if (!observed || DEAD_STATES.has(observed.Status?.Code ?? "")) {
            return;
          }

          yield* session.note(`Deleting VPC peering connection: ${pcxId}`);
          yield* ec2
            .deleteVpcPeeringConnection({ VpcPeeringConnectionId: pcxId })
            .pipe(
              Effect.catchTag(
                "InvalidVpcPeeringConnectionID.NotFound",
                () => Effect.void,
              ),
              Effect.catchTag(
                "InvalidVpcPeeringConnectionId.NotFound",
                () => Effect.void,
              ),
            );
        }),
      };
    }),
  );
