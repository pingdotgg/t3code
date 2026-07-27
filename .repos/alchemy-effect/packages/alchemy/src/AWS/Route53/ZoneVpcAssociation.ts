import * as route53 from "@distilled.cloud/aws/route-53";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface ZoneVpcAssociationProps {
  /**
   * ID of the private hosted zone to associate the VPC with. Changing this
   * forces replacement.
   */
  hostedZoneId: string;
  /**
   * ID of the VPC to associate. The VPC must have DNS support and DNS
   * hostnames enabled. Changing this forces replacement.
   */
  vpcId: string;
  /**
   * Region the VPC lives in. Changing this forces replacement.
   */
  vpcRegion: string;
  /**
   * Optional comment recorded on the association request.
   */
  comment?: string;
}

export interface ZoneVpcAssociation extends Resource<
  "AWS.Route53.ZoneVpcAssociation",
  ZoneVpcAssociationProps,
  {
    /**
     * ID of the private hosted zone.
     */
    hostedZoneId: string;
    /**
     * ID of the associated VPC.
     */
    vpcId: string;
    /**
     * Region of the associated VPC.
     */
    vpcRegion: string;
  },
  never,
  Providers
> {}

/**
 * An association between an additional VPC and a private hosted zone.
 *
 * A private hosted zone is created with one initial VPC (see
 * `HostedZone.vpc`); `ZoneVpcAssociation` attaches further VPCs so their DNS
 * resolvers can answer from the zone. For a VPC in a different account, the
 * zone owner must first create a `VpcAssociationAuthorization` for it.
 *
 * The initial VPC of a private zone cannot be modeled with this resource —
 * Route 53 refuses to disassociate the last VPC from a private zone.
 * @resource
 * @section Associating VPCs
 * @example Attach a Second VPC
 * ```typescript
 * const zone = yield* HostedZone("InternalZone", {
 *   name: "internal.example.com",
 *   privateZone: true,
 *   vpc: { vpcId: primary.vpcId, vpcRegion: "us-west-2" },
 * });
 *
 * const association = yield* ZoneVpcAssociation("SecondaryVpc", {
 *   hostedZoneId: zone.id,
 *   vpcId: secondary.vpcId,
 *   vpcRegion: "us-west-2",
 * });
 * ```
 */
export const ZoneVpcAssociation = Resource<ZoneVpcAssociation>(
  "AWS.Route53.ZoneVpcAssociation",
);

/**
 * Route 53 zone-change submissions can collide with other in-flight changes
 * on the same zone (`PriorRequestNotComplete`) — retry on a bounded schedule
 * (~40s).
 *
 * Explicitly typed: inlining `Effect.retry` with options in provider
 * lifecycle code can widen the provider layer to `unknown` in declaration
 * emit.
 *
 * @internal
 */
const retryPriorRequest = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "PriorRequestNotComplete",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(20)]),
  });

export const ZoneVpcAssociationProvider = () =>
  Provider.effect(
    ZoneVpcAssociation,
    Effect.gen(function* () {
      // Observe via the zone detail — `getHostedZone` returns every
      // associated VPC for a private zone.
      const observe = Effect.fn(function* (
        hostedZoneId: string,
        vpcId: string,
      ) {
        const detail = yield* route53
          .getHostedZone({ Id: hostedZoneId })
          .pipe(
            Effect.catchTag("NoSuchHostedZone", () =>
              Effect.succeed(undefined),
            ),
          );
        return (detail?.VPCs ?? []).find((vpc) => vpc.VPCId === vpcId);
      });

      return {
        stables: ["hostedZoneId", "vpcId", "vpcRegion"],
        // Sub-resource: associations are keyed by their parent hosted zone;
        // there is no account-wide enumeration API.
        list: () => Effect.succeed([]),
        // Existence-only resource — every identifying property change
        // replaces the association.
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            olds.hostedZoneId !== news.hostedZoneId ||
            olds.vpcId !== news.vpcId ||
            olds.vpcRegion !== news.vpcRegion
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const hostedZoneId = output?.hostedZoneId ?? olds?.hostedZoneId;
          const vpcId = output?.vpcId ?? olds?.vpcId;
          if (hostedZoneId === undefined || vpcId === undefined) {
            return undefined;
          }
          const observed = yield* observe(hostedZoneId, vpcId);
          if (!observed) {
            return undefined;
          }
          return {
            hostedZoneId,
            vpcId,
            vpcRegion:
              observed.VPCRegion ?? output?.vpcRegion ?? olds?.vpcRegion ?? "",
          };
        }),
        // Existence-only: observe → if missing, associate. There is no sync
        // step (an association has no mutable aspects).
        reconcile: Effect.fn(function* ({ news, session }) {
          const observed = yield* observe(news.hostedZoneId, news.vpcId);
          if (!observed) {
            yield* retryPriorRequest(
              route53.associateVPCWithHostedZone({
                HostedZoneId: news.hostedZoneId,
                VPC: {
                  VPCId: news.vpcId,
                  VPCRegion: news.vpcRegion as route53.VPCRegion,
                },
                Comment: news.comment,
              }),
            );
          }
          yield* session.note(`${news.hostedZoneId}/${news.vpcId}`);
          return {
            hostedZoneId: news.hostedZoneId,
            vpcId: news.vpcId,
            vpcRegion: news.vpcRegion,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* route53
            .disassociateVPCFromHostedZone({
              HostedZoneId: output.hostedZoneId,
              VPC: {
                VPCId: output.vpcId,
                VPCRegion: output.vpcRegion as route53.VPCRegion,
              },
            })
            .pipe(
              Effect.asVoid,
              Effect.catchTag("VPCAssociationNotFound", () => Effect.void),
              Effect.catchTag("NoSuchHostedZone", () => Effect.void),
            );
        }),
      };
    }),
  );
