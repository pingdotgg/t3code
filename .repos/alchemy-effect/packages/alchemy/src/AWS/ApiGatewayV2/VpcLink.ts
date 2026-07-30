import * as agw2 from "@distilled.cloud/aws/apigatewayv2";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  collectAllPages,
  retryOnTooManyRequests,
  syncTags,
  tagRecord,
  vpcLinkArn,
} from "./common.ts";

export interface VpcLinkProps {
  /**
   * Name of the VPC link. If omitted, Alchemy generates a deterministic
   * physical name.
   */
  name?: string;
  /**
   * Subnet IDs the VPC link attaches to. Immutable — changing them
   * triggers a replacement.
   */
  subnetIds: string[];
  /**
   * Security group IDs for the VPC link. Immutable — changing them
   * triggers a replacement.
   */
  securityGroupIds?: string[];
  /**
   * User-defined tags (Alchemy internal tags are merged automatically).
   */
  tags?: Record<string, string>;
}

export interface VpcLink extends Resource<
  "AWS.ApiGatewayV2.VpcLink",
  VpcLinkProps,
  {
    /** The VPC link identifier. */
    vpcLinkId: string;
    /** The VPC link name. */
    name: string;
    /** The subnet IDs. */
    subnetIds: string[];
    /** The security group IDs. */
    securityGroupIds: string[];
    /**
     * The provisioning status (`PENDING`, `AVAILABLE`, `DELETING`,
     * `FAILED`). Provisioning typically takes 1–2 minutes; integrations
     * that reference the link only work once it is `AVAILABLE`.
     */
    status: string | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An API Gateway v2 VPC link — lets an HTTP API reach private resources
 * (ALB/NLB listeners, Cloud Map services) inside a VPC.
 *
 * Unlike the v1 VPC link (NLB-only, ~10 min provisioning), the v2 link is
 * subnet/security-group based and provisions in ~1–2 minutes.
 * @resource
 * @section Private integrations
 * @example VPC link + private integration
 * ```typescript
 * const link = yield* ApiGatewayV2.VpcLink("Link", {
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId],
 *   securityGroupIds: [securityGroup.securityGroupId],
 * });
 *
 * yield* ApiGatewayV2.Integration("Private", {
 *   api,
 *   integrationType: "HTTP_PROXY",
 *   integrationUri: listener.listenerArn,
 *   integrationMethod: "ANY",
 *   connectionType: "VPC_LINK",
 *   connectionId: link.vpcLinkId,
 *   payloadFormatVersion: "1.0",
 * });
 * ```
 */
export const VpcLink = Resource<VpcLink>("AWS.ApiGatewayV2.VpcLink");

const snapshotFromVpcLink = (
  link: agw2.GetVpcLinkResponse,
): VpcLink["Attributes"] => ({
  vpcLinkId: link.VpcLinkId!,
  name: link.Name ?? "",
  subnetIds: [...(link.SubnetIds ?? [])],
  securityGroupIds: [...(link.SecurityGroupIds ?? [])],
  status: link.VpcLinkStatus,
  tags: tagRecord(link.Tags),
});

export const VpcLinkProvider = () =>
  Provider.effect(
    VpcLink,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<VpcLinkProps, "name">,
      ) {
        return (
          props.name ?? (yield* createPhysicalName({ id, maxLength: 128 }))
        );
      });

      const getVpcLinkSafe = (vpcLinkId: string) =>
        agw2
          .getVpcLink({ VpcLinkId: vpcLinkId })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      return VpcLink.Provider.of({
        stables: ["vpcLinkId"],

        list: () =>
          Effect.gen(function* () {
            const items = yield* collectAllPages((NextToken) =>
              agw2.getVpcLinks({ NextToken }),
            );
            return items
              .filter((link) => link.VpcLinkId != null)
              .map((link) => snapshotFromVpcLink(link));
          }),

        read: Effect.fn(function* ({ output }) {
          if (!output?.vpcLinkId) return undefined;
          const link = yield* getVpcLinkSafe(output.vpcLinkId);
          if (!link?.VpcLinkId) return undefined;
          return snapshotFromVpcLink(link);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          // Subnets and security groups are immutable on a v2 VPC link.
          if (
            !deepEqual(
              [...news.subnetIds].sort(),
              [...olds.subnetIds].sort(),
            ) ||
            !deepEqual(
              [...(news.securityGroupIds ?? [])].sort(),
              [...(olds.securityGroupIds ?? [])].sort(),
            )
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { region } = yield* AWSEnvironment.current;
          const name = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE
          let observed = output?.vpcLinkId
            ? yield* getVpcLinkSafe(output.vpcLinkId)
            : undefined;

          // 2. ENSURE
          if (!observed?.VpcLinkId) {
            observed = yield* retryOnTooManyRequests(
              agw2.createVpcLink({
                Name: name,
                SubnetIds: news.subnetIds,
                SecurityGroupIds: news.securityGroupIds,
                Tags: desiredTags,
              }),
            );
            yield* session.note(`Created VPC link ${observed.VpcLinkId}`);
          }
          const snapshot = snapshotFromVpcLink(observed);

          // 3. SYNC — only the name is mutable.
          if (snapshot.name !== name) {
            yield* retryOnTooManyRequests(
              agw2.updateVpcLink({
                VpcLinkId: snapshot.vpcLinkId,
                Name: name,
              }),
            );
          }

          // 3b. SYNC TAGS — diff against OBSERVED cloud tags.
          if (!deepEqual(snapshot.tags, desiredTags)) {
            yield* syncTags({
              resourceArn: vpcLinkArn(region, snapshot.vpcLinkId),
              oldTags: snapshot.tags,
              newTags: desiredTags,
            });
          }

          // 4. RETURN fresh state. Provisioning is asynchronous (~1–2 min);
          //    the `status` attribute surfaces it rather than blocking the
          //    deploy on AVAILABLE.
          const final = yield* agw2.getVpcLink({
            VpcLinkId: snapshot.vpcLinkId,
          });
          yield* session.note(`Reconciled VPC link ${snapshot.vpcLinkId}`);
          return snapshotFromVpcLink(final);
        }),

        delete: Effect.fn(function* ({ output, session }) {
          yield* retryOnTooManyRequests(
            agw2
              .deleteVpcLink({ VpcLinkId: output.vpcLinkId })
              .pipe(Effect.catchTag("NotFoundException", () => Effect.void)),
          );
          yield* session.note(`Deleted VPC link ${output.vpcLinkId}`);
        }),
      });
    }),
  );
