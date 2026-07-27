import * as route53 from "@distilled.cloud/aws/route-53";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface VpcAssociationAuthorizationProps {
  /**
   * ID of the private hosted zone to authorize the association with. Must be
   * a zone owned by the current account. Changing this forces replacement.
   */
  hostedZoneId: string;
  /**
   * ID of the VPC that is authorized to be associated with the hosted zone
   * (typically a VPC owned by a different AWS account). Changing this forces
   * replacement.
   */
  vpcId: string;
  /**
   * Region the VPC lives in. Changing this forces replacement.
   */
  vpcRegion: string;
}

export interface VpcAssociationAuthorization extends Resource<
  "AWS.Route53.VpcAssociationAuthorization",
  VpcAssociationAuthorizationProps,
  {
    /**
     * ID of the private hosted zone.
     */
    hostedZoneId: string;
    /**
     * ID of the authorized VPC.
     */
    vpcId: string;
    /**
     * Region of the authorized VPC.
     */
    vpcRegion: string;
  },
  never,
  Providers
> {}

/**
 * Authorization for a VPC (usually in another AWS account) to be associated
 * with a private hosted zone.
 *
 * Cross-account private-zone association is a two-step handshake: the
 * zone-owning account creates a `VpcAssociationAuthorization` for the foreign
 * VPC, then the VPC-owning account submits the association (see
 * `ZoneVpcAssociation`). Same-account associations don't need an
 * authorization.
 * @resource
 * @section Authorizing Cross-Account Association
 * @example Authorize a VPC
 * ```typescript
 * const authorization = yield* VpcAssociationAuthorization("PeerVpcAuth", {
 *   hostedZoneId: zone.id,
 *   vpcId: "vpc-0123456789abcdef0", // VPC in the other account
 *   vpcRegion: "us-west-2",
 * });
 * ```
 */
export const VpcAssociationAuthorization =
  Resource<VpcAssociationAuthorization>(
    "AWS.Route53.VpcAssociationAuthorization",
  );

export const VpcAssociationAuthorizationProvider = () =>
  Provider.effect(
    VpcAssociationAuthorization,
    Effect.gen(function* () {
      // Enumerate the zone's pending authorizations and find ours. The list
      // is per-zone and small; bound pagination defensively.
      const observe = Effect.fn(function* (
        hostedZoneId: string,
        vpcId: string,
      ) {
        let nextToken: string | undefined;
        for (let page = 0; page < 10; page++) {
          const response = yield* route53
            .listVPCAssociationAuthorizations({
              HostedZoneId: hostedZoneId,
              NextToken: nextToken,
            })
            .pipe(
              Effect.catchTag("NoSuchHostedZone", () =>
                Effect.succeed({
                  HostedZoneId: hostedZoneId,
                  VPCs: [],
                  NextToken: undefined,
                }),
              ),
            );
          const match = (response.VPCs ?? []).find(
            (vpc) => vpc.VPCId === vpcId,
          );
          if (match) {
            return match;
          }
          if (!response.NextToken) {
            return undefined;
          }
          nextToken = response.NextToken;
        }
        return undefined;
      });

      return {
        stables: ["hostedZoneId", "vpcId", "vpcRegion"],
        // Sub-resource: authorizations are keyed by their parent hosted zone
        // and cannot be enumerated account-wide.
        list: () => Effect.succeed([]),
        // Existence-only resource — every property is part of its identity.
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
            vpcRegion: observed.VPCRegion ?? output?.vpcRegion ?? "",
          };
        }),
        // Existence-only: observe → if missing, create. There is no sync step
        // (an authorization has no mutable aspects).
        reconcile: Effect.fn(function* ({ news, session }) {
          const observed = yield* observe(news.hostedZoneId, news.vpcId);
          if (!observed) {
            // `createVPCAssociationAuthorization` is an idempotent upsert for
            // the same (zone, VPC) pair, so races simply succeed.
            yield* route53.createVPCAssociationAuthorization({
              HostedZoneId: news.hostedZoneId,
              VPC: {
                VPCId: news.vpcId,
                VPCRegion: news.vpcRegion as route53.VPCRegion,
              },
            });
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
            .deleteVPCAssociationAuthorization({
              HostedZoneId: output.hostedZoneId,
              VPC: {
                VPCId: output.vpcId,
                VPCRegion: output.vpcRegion as route53.VPCRegion,
              },
            })
            .pipe(
              Effect.catchTag(
                "VPCAssociationAuthorizationNotFound",
                () => Effect.void,
              ),
              Effect.catchTag("NoSuchHostedZone", () => Effect.void),
            );
        }),
      };
    }),
  );
