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
import {
  retryOnConflict,
  waitUntilAbsent,
  waitUntilStable,
} from "./internal.ts";

export interface ServiceNetworkServiceAssociationProps {
  /**
   * ID or ARN of the service network. Immutable — changing it replaces the
   * association.
   */
  serviceNetworkIdentifier: string;
  /**
   * ID or ARN of the lattice service to associate. Immutable — changing it
   * replaces the association.
   */
  serviceIdentifier: string;
  /**
   * User-defined tags to apply to the association.
   */
  tags?: Record<string, string>;
}

export interface ServiceNetworkServiceAssociation extends Resource<
  "AWS.VpcLattice.ServiceNetworkServiceAssociation",
  ServiceNetworkServiceAssociationProps,
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
     * ID of the associated lattice service.
     */
    serviceId?: string;
    /**
     * ID of the service network.
     */
    serviceNetworkId?: string;
    /**
     * DNS name clients in associated VPCs resolve the service by.
     */
    dnsName?: string;
    /**
     * Current tags reported for the association.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * Associates a VPC Lattice service with a service network, making the
 * service reachable from every VPC associated with that network.
 *
 * @resource
 * @section Associating a Service
 * @example Basic Association
 * ```typescript
 * const assoc = yield* ServiceNetworkServiceAssociation("PaymentsLink", {
 *   serviceNetworkIdentifier: network.serviceNetworkId,
 *   serviceIdentifier: service.serviceId,
 * });
 * ```
 */
export const ServiceNetworkServiceAssociation =
  Resource<ServiceNetworkServiceAssociation>(
    "AWS.VpcLattice.ServiceNetworkServiceAssociation",
  );

export const ServiceNetworkServiceAssociationProvider = () =>
  Provider.effect(
    ServiceNetworkServiceAssociation,
    Effect.gen(function* () {
      const observe = (id: string) =>
        vpclattice
          .getServiceNetworkServiceAssociation({
            serviceNetworkServiceAssociationIdentifier: id,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      // Discover an existing association between the pair (create-conflict
      // recovery / lost-state recovery).
      const findByPair = (
        serviceNetworkIdentifier: string,
        serviceIdentifier: string,
      ) =>
        vpclattice.listServiceNetworkServiceAssociations
          .pages({ serviceNetworkIdentifier, serviceIdentifier })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.items ?? []),
            ),
            Effect.flatMap((items) =>
              items[0]?.id ? observe(items[0].id) : Effect.succeed(undefined),
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
            olds?.serviceIdentifier !== news.serviceIdentifier
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const assoc = output?.associationId
            ? yield* observe(output.associationId)
            : olds
              ? yield* findByPair(
                  olds.serviceNetworkIdentifier,
                  olds.serviceIdentifier,
                )
              : undefined;
          if (!assoc?.arn || !assoc.id) return undefined;
          const listed = yield* vpclattice.listTagsForResource({
            resourceArn: assoc.arn,
          });
          const attrs = {
            associationId: assoc.id,
            associationArn: assoc.arn,
            status: assoc.status ?? "UNKNOWN",
            serviceId: assoc.serviceId,
            serviceNetworkId: assoc.serviceNetworkId,
            dnsName: assoc.dnsEntry?.domainName,
            tags: tagRecord(listed.tags),
          };
          return (yield* hasAlchemyTags(id, listed.tags))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — prefer the stable id cache, fall back to pair lookup.
          let assoc = output?.associationId
            ? yield* observe(output.associationId)
            : yield* findByPair(
                news.serviceNetworkIdentifier,
                news.serviceIdentifier,
              );

          // Ensure — create if missing. A ConflictException means the pair
          // is already associated (a race); recover the existing association.
          if (!assoc?.arn || !assoc.id) {
            const created = yield* retryOnConflict(
              vpclattice.createServiceNetworkServiceAssociation({
                serviceNetworkIdentifier: news.serviceNetworkIdentifier,
                serviceIdentifier: news.serviceIdentifier,
                tags: desiredTags,
              }),
            ).pipe(
              Effect.catchTag("ConflictException", () =>
                findByPair(
                  news.serviceNetworkIdentifier,
                  news.serviceIdentifier,
                ),
              ),
            );
            if (!created?.arn || !created.id) {
              return yield* Effect.fail(
                new Error(
                  "Failed to create service network service association",
                ),
              );
            }
            assoc = yield* observe(created.id);
            if (!assoc?.arn || !assoc.id) {
              assoc = {
                id: created.id,
                arn: created.arn,
                status: created.status,
              };
            }
          }
          const associationId = assoc.id;
          const associationArn = assoc.arn;
          if (!associationId || !associationArn) {
            return yield* Effect.fail(
              new Error(
                "Service network service association is missing its id/arn",
              ),
            );
          }

          // Wait for the association to leave CREATE_IN_PROGRESS so
          // dependents observe a routable service.
          const stable = yield* waitUntilStable(observe(associationId));

          yield* syncTags(associationArn, desiredTags);

          yield* session.note(associationArn);
          return {
            associationId,
            associationArn,
            status: stable?.status ?? assoc.status ?? "ACTIVE",
            serviceId: stable?.serviceId,
            serviceNetworkId: stable?.serviceNetworkId,
            dnsName: stable?.dnsEntry?.domainName,
            tags: desiredTags,
          };
        }),
        list: () =>
          Effect.gen(function* () {
            // ListServiceNetworkServiceAssociations requires a service
            // network or service filter, so enumerate networks first.
            const networks = yield* vpclattice.listServiceNetworks
              .pages({})
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk).flatMap((page) => page.items ?? []),
                ),
              );
            const summaries = (yield* Effect.forEach(
              networks.filter(
                (n): n is typeof n & { id: string } => n.id != null,
              ),
              (network) =>
                vpclattice.listServiceNetworkServiceAssociations
                  .pages({ serviceNetworkIdentifier: network.id })
                  .pipe(
                    Stream.runCollect,
                    Effect.map((chunk) =>
                      Array.from(chunk).flatMap((page) => page.items ?? []),
                    ),
                  ),
              { concurrency: 5 },
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
                    serviceId: summary.serviceId,
                    serviceNetworkId: summary.serviceNetworkId,
                    dnsName: summary.dnsEntry?.domainName,
                    tags: tagRecord(listed.tags),
                  };
                }),
              { concurrency: 10 },
            );
          }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryOnConflict(
            vpclattice.deleteServiceNetworkServiceAssociation({
              serviceNetworkServiceAssociationIdentifier: output.associationId,
            }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          // Deletion is asynchronous; wait until the association is actually
          // gone so dependent service/network deletes don't conflict.
          yield* waitUntilAbsent(observe(output.associationId));
        }),
      };
    }),
  );
