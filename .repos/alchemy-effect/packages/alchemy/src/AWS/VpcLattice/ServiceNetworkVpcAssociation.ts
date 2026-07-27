import * as vpclattice from "@distilled.cloud/aws/vpc-lattice";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  tagRecord,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { retryOnConflict, waitUntilAbsent } from "./internal.ts";

export interface ServiceNetworkVpcAssociationProps {
  /**
   * ID or ARN of the service network to associate. Immutable — changing it
   * replaces the association.
   */
  serviceNetworkIdentifier: string;
  /**
   * ID of the VPC to associate. Immutable — changing it replaces the
   * association.
   */
  vpcIdentifier: string;
  /**
   * Security group IDs controlling access from the VPC to the service network.
   */
  securityGroupIds?: string[];
  /**
   * User-defined tags to apply to the association.
   */
  tags?: Record<string, string>;
}

export interface ServiceNetworkVpcAssociation extends Resource<
  "AWS.VpcLattice.ServiceNetworkVpcAssociation",
  ServiceNetworkVpcAssociationProps,
  {
    /**
     * Service-assigned unique ID of the association.
     */
    associationId: string;
    /**
     * ARN of the association.
     */
    associationArn: string;
    /**
     * Current lifecycle status (e.g. `ACTIVE`, `CREATE_IN_PROGRESS`).
     */
    status: string;
    /**
     * ID of the associated service network.
     */
    serviceNetworkId?: string;
    /**
     * ID of the associated VPC.
     */
    vpcId?: string;
    /**
     * Current tags reported for the association.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * Associates a VPC with a VPC Lattice service network, letting workloads in the
 * VPC reach every service in the network (subject to auth policies). The most
 * common VPC Lattice wiring step.
 *
 * @resource
 * @section Associating a VPC
 * @example Basic Association
 * ```typescript
 * const assoc = yield* ServiceNetworkVpcAssociation("AppVpcLink", {
 *   serviceNetworkIdentifier: network.serviceNetworkId,
 *   vpcIdentifier: vpc.vpcId,
 *   securityGroupIds: [sg.groupId],
 * });
 * ```
 */
export const ServiceNetworkVpcAssociation =
  Resource<ServiceNetworkVpcAssociation>(
    "AWS.VpcLattice.ServiceNetworkVpcAssociation",
  );

export const ServiceNetworkVpcAssociationProvider = () =>
  Provider.effect(
    ServiceNetworkVpcAssociation,
    Effect.gen(function* () {
      const observe = (id: string) =>
        vpclattice
          .getServiceNetworkVpcAssociation({
            serviceNetworkVpcAssociationIdentifier: id,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const syncTags = Effect.fn(function* (
        arn: string,
        desiredTags: Record<string, string>,
      ) {
        const listed = yield* vpclattice.listTagsForResource({
          resourceArn: arn,
        });
        const { removed, upsert } = diffTags(
          tagRecord(listed.tags),
          desiredTags,
        );
        if (upsert.length > 0) {
          yield* vpclattice.tagResource({
            resourceArn: arn,
            tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
          });
        }
        if (removed.length > 0) {
          yield* vpclattice.untagResource({
            resourceArn: arn,
            tagKeys: removed,
          });
        }
      });

      return {
        stables: ["associationId", "associationArn"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (
            olds?.serviceNetworkIdentifier !== news.serviceNetworkIdentifier ||
            olds?.vpcIdentifier !== news.vpcIdentifier
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, output }) {
          if (!output?.associationId) return undefined;
          const assoc = yield* observe(output.associationId);
          if (!assoc?.arn || !assoc.id) return undefined;
          const listed = yield* vpclattice.listTagsForResource({
            resourceArn: assoc.arn,
          });
          const attrs = {
            associationId: assoc.id,
            associationArn: assoc.arn,
            status: assoc.status ?? "UNKNOWN",
            serviceNetworkId: assoc.serviceNetworkId,
            vpcId: assoc.vpcId,
            tags: tagRecord(listed.tags),
          };
          return (yield* hasAlchemyTags(id, listed.tags))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          let assoc = output?.associationId
            ? yield* observe(output.associationId)
            : undefined;

          if (!assoc?.arn || !assoc.id) {
            const created =
              yield* vpclattice.createServiceNetworkVpcAssociation({
                serviceNetworkIdentifier: news.serviceNetworkIdentifier,
                vpcIdentifier: news.vpcIdentifier,
                securityGroupIds: news.securityGroupIds,
                tags: desiredTags,
              });
            if (!created.arn || !created.id) {
              return yield* Effect.fail(
                new Error("Failed to create service network VPC association"),
              );
            }
            assoc = yield* observe(created.id);
            if (!assoc?.arn || !assoc.id) {
              assoc = {
                id: created.id,
                arn: created.arn,
                status: created.status,
                securityGroupIds: created.securityGroupIds,
              };
            }
          } else if (
            news.securityGroupIds &&
            news.securityGroupIds.length > 0
          ) {
            // Sync security groups (association keeps at least one).
            const current = (assoc.securityGroupIds ?? []).slice().sort();
            const desired = news.securityGroupIds.slice().sort();
            if (JSON.stringify(current) !== JSON.stringify(desired)) {
              yield* vpclattice.updateServiceNetworkVpcAssociation({
                serviceNetworkVpcAssociationIdentifier: assoc.id,
                securityGroupIds: news.securityGroupIds,
              });
            }
          }

          // Every branch above guarantees id/arn; this narrows the reassigned
          // `let` for the type-checker and guards a malformed API response.
          if (!assoc?.arn || !assoc.id) {
            return yield* Effect.fail(
              new Error(
                "service network VPC association is missing its id/arn",
              ),
            );
          }

          yield* syncTags(assoc.arn, desiredTags);

          yield* session.note(assoc.arn);
          return {
            associationId: assoc.id,
            associationArn: assoc.arn,
            status: assoc.status ?? "ACTIVE",
            serviceNetworkId: assoc.serviceNetworkId,
            vpcId: assoc.vpcId,
            tags: desiredTags,
          };
        }),
        list: () =>
          Effect.gen(function* () {
            // AWS does not support an unfiltered account-wide association
            // listing: at least one serviceNetworkIdentifier or vpcIdentifier
            // is required. Enumerate service networks first, then list each
            // network's associations so nuke can discover orphaned links.
            const serviceNetworkIds = yield* vpclattice.listServiceNetworks
              .pages({})
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk)
                    .flatMap((page) => page.items ?? [])
                    .flatMap((network) =>
                      network.id === undefined ? [] : [network.id],
                    ),
                ),
              );
            const summaries = (yield* Effect.forEach(
              serviceNetworkIds,
              (serviceNetworkIdentifier) =>
                vpclattice.listServiceNetworkVpcAssociations
                  .pages({ serviceNetworkIdentifier })
                  .pipe(
                    Stream.runCollect,
                    Effect.map((chunk) =>
                      Array.from(chunk).flatMap((page) => page.items ?? []),
                    ),
                  ),
              { concurrency: 10 },
            )).flat();
            return yield* Effect.forEach(
              summaries.filter(
                (s): s is typeof s & { id: string; arn: string } =>
                  s.id != null && s.arn != null,
              ),
              (summary) =>
                Effect.gen(function* () {
                  const listed = yield* vpclattice.listTagsForResource({
                    resourceArn: summary.arn,
                  });
                  return {
                    associationId: summary.id,
                    associationArn: summary.arn,
                    status: summary.status ?? "UNKNOWN",
                    serviceNetworkId: summary.serviceNetworkId,
                    vpcId: summary.vpcId,
                    tags: tagRecord(listed.tags),
                  };
                }),
              { concurrency: 10 },
            );
          }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryOnConflict(
            vpclattice.deleteServiceNetworkVpcAssociation({
              serviceNetworkVpcAssociationIdentifier: output.associationId,
            }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          // Deletion is asynchronous (the association sits in
          // DELETE_IN_PROGRESS while hyperplane ENIs are torn down). Wait
          // until it is actually gone so a dependent ServiceNetwork delete
          // doesn't hit `ConflictException: has VPC(s) associated`.
          yield* waitUntilAbsent(observe(output.associationId));
        }),
      };
    }),
  );
