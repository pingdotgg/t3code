import * as r53r from "@distilled.cloud/aws/route53resolver";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface ResolverRuleAssociationProps {
  /**
   * ID of the resolver rule to attach. Changing it forces replacement.
   */
  resolverRuleId: string;
  /**
   * ID of the VPC the rule takes effect in. Changing it forces
   * replacement.
   */
  vpcId: string;
  /**
   * Optional friendly name recorded on the association. Changing it forces
   * replacement (associations cannot be updated).
   */
  name?: string;
}

export interface ResolverRuleAssociation extends Resource<
  "AWS.Route53Resolver.ResolverRuleAssociation",
  ResolverRuleAssociationProps,
  {
    /**
     * ID of the association (e.g. `rslvr-rrassoc-...`).
     */
    resolverRuleAssociationId: string;
    /**
     * ID of the associated resolver rule.
     */
    resolverRuleId: string;
    /**
     * ID of the VPC the rule is associated with.
     */
    vpcId: string;
  },
  never,
  Providers
> {}

/**
 * An association between a Route 53 Resolver rule and a VPC. Once
 * associated, Resolver applies the rule to DNS queries that originate in
 * that VPC.
 * @resource
 * @section Associating Rules
 * @example Attach a Forwarding Rule to a VPC
 * ```typescript
 * import * as Route53Resolver from "alchemy/AWS/Route53Resolver";
 *
 * const association = yield* Route53Resolver.ResolverRuleAssociation(
 *   "CorpForwardAssoc",
 *   {
 *     resolverRuleId: rule.resolverRuleId,
 *     vpcId: vpc.vpcId,
 *   },
 * );
 * ```
 */
export const ResolverRuleAssociation = Resource<ResolverRuleAssociation>(
  "AWS.Route53Resolver.ResolverRuleAssociation",
);

/**
 * Re-associating a (rule, VPC) pair whose previous association is still
 * draining (`DELETING`) surfaces `InvalidRequestException` or
 * `ResourceExistsException`; the rule itself may also still be settling
 * (`ResourceUnavailableException`). All are bounded races — retry (~60s).
 *
 * Explicitly typed: inlining `Effect.retry` in provider lifecycle code can
 * widen the provider layer to `unknown` in declaration emit.
 *
 * @internal
 */
const retryAssociateRaces = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "InvalidRequestException" ||
      e._tag === "ResourceExistsException" ||
      e._tag === "ResourceUnavailableException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(20)]),
  });

/**
 * Best-effort bounded wait (~30s) for an association to leave `CREATING`.
 * Associations routinely take 1-2 minutes to reach `COMPLETE`; the
 * association is already effective for reconciliation purposes, so the
 * reconciler does not block on the full transition.
 *
 * @internal
 */
const untilAssociationSettled = <E, R>(
  self: Effect.Effect<r53r.ResolverRuleAssociation | undefined, E, R>,
): Effect.Effect<r53r.ResolverRuleAssociation | undefined, E, R> =>
  self.pipe(
    Effect.repeat({
      schedule: Schedule.fixed("3 seconds"),
      until: (association) =>
        association === undefined || association.Status !== "CREATING",
      times: 10,
    }),
  );

/**
 * Bounded wait (~2 min) for an association to fully drain after
 * disassociation. Deletion must converge before returning: the parent
 * resolver rule cannot be deleted while any association (even `DELETING`)
 * remains, so returning early cascades `ResourceInUseException` onto the
 * rule's delete.
 *
 * @internal
 */
const untilAssociationGone = <A, E, R>(
  self: Effect.Effect<A | undefined, E, R>,
): Effect.Effect<A | undefined, E, R> =>
  self.pipe(
    Effect.repeat({
      schedule: Schedule.fixed("5 seconds"),
      until: (association) => association === undefined,
      times: 24,
    }),
  );

/**
 * Disassociating an association that is still `CREATING` transiently fails
 * with `InvalidRequestException` — retry briefly until it settles.
 *
 * @internal
 */
const retryDisassociateRaces = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "InvalidRequestException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(20)]),
  });

export const ResolverRuleAssociationProvider = () =>
  Provider.effect(
    ResolverRuleAssociation,
    Effect.gen(function* () {
      const listAssociations = (resolverRuleId: string, vpcId: string) =>
        r53r
          .listResolverRuleAssociations({
            Filters: [
              { Name: "ResolverRuleId", Values: [resolverRuleId] },
              { Name: "VPCId", Values: [vpcId] },
            ],
          })
          .pipe(Effect.map((r) => r.ResolverRuleAssociations ?? []));

      // An association is identified by its (rule, VPC) pair; DELETING and
      // FAILED associations count as missing so reconcile re-associates.
      const observe = (resolverRuleId: string, vpcId: string) =>
        listAssociations(resolverRuleId, vpcId).pipe(
          Effect.map((associations) =>
            associations.find(
              (association) =>
                association.Status !== "DELETING" &&
                association.Status !== "FAILED",
            ),
          ),
        );

      // Any association record at all — used by delete to wait until the
      // (rule, VPC) pair has fully drained, DELETING entries included.
      const observeAny = (resolverRuleId: string, vpcId: string) =>
        listAssociations(resolverRuleId, vpcId).pipe(
          Effect.map((associations) => associations[0]),
        );

      return ResolverRuleAssociation.Provider.of({
        stables: ["resolverRuleAssociationId", "resolverRuleId", "vpcId"],
        // Top-level enumeration: associations are listable account-wide.
        list: () =>
          r53r.listResolverRuleAssociations.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.ResolverRuleAssociations ?? [])
                .flatMap((association) =>
                  association.Id !== undefined &&
                  association.ResolverRuleId !== undefined &&
                  association.VPCId !== undefined &&
                  // AWS creates an Internet Resolver association for each
                  // VPC. It cannot be disassociated directly and disappears
                  // automatically with the VPC.
                  !association.Id.startsWith("rslvr-autodefined") &&
                  !association.ResolverRuleId.startsWith("rslvr-autodefined")
                    ? [
                        {
                          resolverRuleAssociationId: association.Id,
                          resolverRuleId: association.ResolverRuleId,
                          vpcId: association.VPCId,
                        },
                      ]
                    : [],
                ),
            ),
          ),
        read: Effect.fn(function* ({ olds, output }) {
          const resolverRuleId = output?.resolverRuleId ?? olds?.resolverRuleId;
          const vpcId = output?.vpcId ?? olds?.vpcId;
          if (resolverRuleId === undefined || vpcId === undefined) {
            return undefined;
          }
          const association = yield* observe(resolverRuleId, vpcId);
          if (association?.Id === undefined) {
            return undefined;
          }
          return {
            resolverRuleAssociationId: association.Id,
            resolverRuleId,
            vpcId,
          };
        }),
        // Existence-only resource — every identifying property change
        // replaces the association.
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            olds.resolverRuleId !== news.resolverRuleId ||
            olds.vpcId !== news.vpcId ||
            olds.name !== news.name
          ) {
            return { action: "replace" } as const;
          }
        }),
        // Existence-only: observe → if missing, associate. There is no
        // sync step (an association has no mutable aspects).
        reconcile: Effect.fn(function* ({ news, session }) {
          let association = yield* observe(news.resolverRuleId, news.vpcId);
          if (association === undefined) {
            association = yield* retryAssociateRaces(
              r53r.associateResolverRule({
                ResolverRuleId: news.resolverRuleId,
                VPCId: news.vpcId,
                Name: news.name,
              }),
            ).pipe(Effect.map((r) => r.ResolverRuleAssociation!));
          }
          // Association setup is asynchronous but quick; wait (bounded) so
          // the rule is actually in effect when the deploy completes.
          const settled = yield* untilAssociationSettled(
            observe(news.resolverRuleId, news.vpcId),
          );
          association = settled ?? association;

          yield* session.note(`${news.resolverRuleId}/${news.vpcId}`);
          return {
            resolverRuleAssociationId: association.Id!,
            resolverRuleId: news.resolverRuleId,
            vpcId: news.vpcId,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryDisassociateRaces(
            r53r.disassociateResolverRule({
              ResolverRuleId: output.resolverRuleId,
              VPCId: output.vpcId,
            }),
          ).pipe(
            Effect.asVoid,
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          // Disassociation is asynchronous and the parent rule cannot be
          // deleted until the association has fully drained — wait
          // (bounded ~2 min) for it to disappear.
          yield* untilAssociationGone(
            observeAny(output.resolverRuleId, output.vpcId),
          );
        }),
      });
    }),
  );
