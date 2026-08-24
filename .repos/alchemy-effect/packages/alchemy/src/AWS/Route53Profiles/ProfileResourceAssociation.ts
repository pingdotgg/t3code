import * as profiles from "@distilled.cloud/aws/route53profiles";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface ProfileResourceAssociationProps {
  /**
   * ID of the Route 53 Profile to attach the resource to. Changing it
   * forces replacement.
   */
  profileId: string;
  /**
   * ARN of the DNS resource to attach — a private hosted zone, Resolver
   * rule, or DNS Firewall rule group. Changing it forces replacement.
   */
  resourceArn: string;
  /**
   * Friendly name recorded on the association. If omitted, a unique name
   * is generated. Names can be updated in place.
   */
  name?: string;
  /**
   * Resource-specific configuration, as a JSON string. DNS Firewall rule
   * group associations require a priority, e.g.
   * `JSON.stringify({ priority: 102 })`. Updated in place.
   */
  resourceProperties?: string;
}

export interface ProfileResourceAssociation extends Resource<
  "AWS.Route53Profiles.ProfileResourceAssociation",
  ProfileResourceAssociationProps,
  {
    /** ID of the association (e.g. `rpr-...`). */
    profileResourceAssociationId: string;
    /** ID of the Profile. */
    profileId: string;
    /** ARN of the attached DNS resource. */
    resourceArn: string;
    /** Type of the attached resource (e.g. `FIREWALL_RULE_GROUP`). */
    resourceType: string;
    /** Name recorded on the association. */
    name: string;
    /** Resource-specific configuration JSON, if any. */
    resourceProperties: string | undefined;
    /**
     * Status of the association at the end of the deploy. Associations
     * settle asynchronously (typically within a minute or two), so this is
     * usually still `UPDATING`.
     */
    status: profiles.ProfileStatus;
  },
  never,
  Providers
> {}

/**
 * An attachment of a DNS resource to a Route 53 Profile. Attach private
 * hosted zones, Resolver rules, or DNS Firewall rule groups; every VPC the
 * Profile is associated with picks up the resource.
 * @resource
 * @section Attaching Resources
 * @example Attach a DNS Firewall Rule Group
 * ```typescript
 * import * as Route53Profiles from "alchemy/AWS/Route53Profiles";
 *
 * const attachment = yield* Route53Profiles.ProfileResourceAssociation(
 *   "FirewallRules",
 *   {
 *     profileId: profile.profileId,
 *     resourceArn: ruleGroupArn,
 *     resourceProperties: JSON.stringify({ priority: 102 }),
 *   },
 * );
 * ```
 *
 * @example Attach a Resolver Rule
 * ```typescript
 * const attachment = yield* Route53Profiles.ProfileResourceAssociation(
 *   "CorpForwarding",
 *   {
 *     profileId: profile.profileId,
 *     resourceArn: rule.resolverRuleArn,
 *   },
 * );
 * ```
 */
export const ProfileResourceAssociation = Resource<ProfileResourceAssociation>(
  "AWS.Route53Profiles.ProfileResourceAssociation",
);

/**
 * Associating/updating/disassociating while the Profile or the association
 * is still settling surfaces `ConflictException`; retry on a bounded
 * schedule (~60s).
 *
 * Explicitly typed: inlining `Effect.retry` in provider lifecycle code can
 * widen the provider layer to `unknown` in declaration emit.
 *
 * @internal
 */
const retryConflict = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(20)]),
  });

/**
 * Bounded wait (~2 min) for a disassociation to drain so the Profile and
 * the attached resource can be deleted right after. If it is still draining
 * after the budget we proceed — downstream deletes absorb the residual with
 * their own bounded retries.
 *
 * @internal
 */
const untilAssociationGone = <E, R>(
  self: Effect.Effect<profiles.ProfileResourceAssociation | undefined, E, R>,
): Effect.Effect<profiles.ProfileResourceAssociation | undefined, E, R> =>
  self.pipe(
    Effect.repeat({
      schedule: Schedule.fixed("4 seconds"),
      until: (association) => association === undefined,
      times: 30,
    }),
  );

/**
 * Compare two resource-properties JSON strings structurally (key order and
 * whitespace insensitive). Invalid JSON falls back to string equality.
 *
 * @internal
 */
const sameResourceProperties = (
  a: string | undefined,
  b: string | undefined,
): boolean => {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return false;
  }
};

export const ProfileResourceAssociationProvider = () =>
  Provider.effect(
    ProfileResourceAssociation,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string | undefined },
      ) {
        return props.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
      });

      // `DELETING`/`DELETED` associations count as missing so reconcile
      // re-associates and delete converges.
      const isLive = (
        association: profiles.ProfileResourceAssociation | undefined,
      ) =>
        association !== undefined &&
        association.Status !== "DELETING" &&
        association.Status !== "DELETED"
          ? association
          : undefined;

      const observeById = (profileResourceAssociationId: string) =>
        profiles
          .getProfileResourceAssociation({
            ProfileResourceAssociationId: profileResourceAssociationId,
          })
          .pipe(
            Effect.map((r) => isLive(r.ProfileResourceAssociation)),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const observeByPair = (profileId: string, resourceArn: string) =>
        profiles.listProfileResourceAssociations
          .items({ ProfileId: profileId })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .filter(
                  (association) => association.ResourceArn === resourceArn,
                )
                .map(isLive)
                .find((association) => association !== undefined),
            ),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const toAttributes = (
        association: profiles.ProfileResourceAssociation,
      ) => ({
        profileResourceAssociationId: association.Id!,
        profileId: association.ProfileId!,
        resourceArn: association.ResourceArn!,
        resourceType: association.ResourceType ?? "",
        name: association.Name ?? "",
        resourceProperties: association.ResourceProperties,
        status: association.Status ?? "COMPLETE",
      });

      return ProfileResourceAssociation.Provider.of({
        stables: ["profileResourceAssociationId", "profileId", "resourceArn"],
        // Parent-keyed listing only — enumerate every Profile, then each
        // Profile's resource associations.
        list: () =>
          profiles.listProfiles.items({}).pipe(
            Stream.runCollect,
            Effect.flatMap((chunk) =>
              Effect.forEach(
                Array.from(chunk).flatMap((summary) =>
                  summary.Id !== undefined ? [summary.Id] : [],
                ),
                (profileId) =>
                  profiles.listProfileResourceAssociations
                    .items({ ProfileId: profileId })
                    .pipe(
                      Stream.runCollect,
                      Effect.map(
                        Array.from<profiles.ProfileResourceAssociation>,
                      ),
                      // The profile can vanish between enumeration and listing.
                      Effect.catchTag("ResourceNotFoundException", () =>
                        Effect.succeed([]),
                      ),
                    ),
                { concurrency: 5 },
              ),
            ),
            Effect.map((groups) =>
              groups
                .flat()
                .filter(
                  (association) =>
                    association.Id !== undefined &&
                    association.ProfileId !== undefined &&
                    association.ResourceArn !== undefined &&
                    association.Status !== "DELETING" &&
                    association.Status !== "DELETED",
                )
                .map(toAttributes),
            ),
          ),
        read: Effect.fn(function* ({ olds, output }) {
          const association = output?.profileResourceAssociationId
            ? yield* observeById(output.profileResourceAssociationId)
            : olds?.profileId !== undefined && olds.resourceArn !== undefined
              ? yield* observeByPair(olds.profileId, olds.resourceArn)
              : undefined;
          if (association?.Id === undefined) return undefined;
          return toAttributes(association);
        }),
        // Identity changes replace; name and resourceProperties update in
        // place via the default update path.
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            olds.profileId !== news.profileId ||
            olds.resourceArn !== news.resourceArn
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.name ?? (yield* createName(id, news));

          // OBSERVE
          let association = output?.profileResourceAssociationId
            ? yield* observeById(output.profileResourceAssociationId)
            : undefined;
          if (!association) {
            association = yield* observeByPair(
              news.profileId,
              news.resourceArn,
            );
          }

          // ENSURE
          if (!association) {
            association = yield* retryConflict(
              profiles.associateResourceToProfile({
                ProfileId: news.profileId,
                ResourceArn: news.resourceArn,
                Name: name,
                ResourceProperties: news.resourceProperties,
              }),
            ).pipe(Effect.map((r) => r.ProfileResourceAssociation!));
          }

          // SYNC name + resourceProperties against OBSERVED state. Updates
          // are accepted even while the association is still settling.
          const nameDelta = association.Name !== name ? name : undefined;
          const propsDelta =
            news.resourceProperties !== undefined &&
            !sameResourceProperties(
              association.ResourceProperties,
              news.resourceProperties,
            )
              ? news.resourceProperties
              : undefined;
          if (nameDelta !== undefined || propsDelta !== undefined) {
            const updated = yield* retryConflict(
              profiles.updateProfileResourceAssociation({
                ProfileResourceAssociationId: association.Id!,
                Name: nameDelta,
                ResourceProperties: propsDelta,
              }),
            );
            association = updated.ProfileResourceAssociation ?? association;
          }

          yield* session.note(`${news.profileId}/${news.resourceArn}`);
          return toAttributes(association);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryConflict(
            profiles.disassociateResourceFromProfile({
              ProfileId: output.profileId,
              ResourceArn: output.resourceArn,
            }),
          ).pipe(
            Effect.asVoid,
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          // Disassociation drains asynchronously (~1 min). Wait (bounded) so
          // the Profile and the attached resource can be deleted right after.
          yield* untilAssociationGone(
            observeById(output.profileResourceAssociationId),
          );
        }),
      });
    }),
  );
