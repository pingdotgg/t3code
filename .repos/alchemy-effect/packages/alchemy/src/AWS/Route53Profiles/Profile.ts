import * as profiles from "@distilled.cloud/aws/route53profiles";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface ProfileProps {
  /**
   * Name of the Profile. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Profiles have no update API for the name,
   * so changing it replaces the Profile.
   */
  name?: string;

  /**
   * User tags to attach to the Profile. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Profile extends Resource<
  "AWS.Route53Profiles.Profile",
  ProfileProps,
  {
    /** ID of the Profile (e.g. `rp-...`). */
    profileId: string;
    /** ARN of the Profile. */
    profileArn: string;
    /** Name of the Profile. */
    profileName: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon Route 53 Profile — a reusable container of DNS configuration
 * (private hosted zones, Resolver rules, and DNS Firewall rule groups) that
 * can be associated with many VPCs at once.
 *
 * Attach DNS resources to the Profile with `ProfileResourceAssociation` and
 * apply the whole bundle to a VPC with `ProfileAssociation`.
 * @resource
 * @section Creating Profiles
 * @example Basic Profile
 * ```typescript
 * import * as Route53Profiles from "alchemy/AWS/Route53Profiles";
 *
 * const profile = yield* Route53Profiles.Profile("DnsProfile");
 * ```
 *
 * @example Profile with Tags
 * ```typescript
 * const profile = yield* Route53Profiles.Profile("DnsProfile", {
 *   name: "shared-dns-config",
 *   tags: { team: "platform" },
 * });
 * ```
 *
 * @section Applying a Profile to VPCs
 * @example Associate the Profile with a VPC
 * ```typescript
 * const vpc = yield* EC2.Vpc("AppVpc", { cidrBlock: "10.0.0.0/16" });
 *
 * yield* Route53Profiles.ProfileAssociation("AppVpcDns", {
 *   profileId: profile.profileId,
 *   resourceId: vpc.vpcId,
 * });
 * ```
 */
export const Profile = Resource<Profile>("AWS.Route53Profiles.Profile");

/**
 * A Profile whose VPC associations are still draining rejects `DeleteProfile`
 * with `ConflictException`. Disassociation completes asynchronously (observed
 * ~1–2 minutes), so retry deletion on a bounded schedule (~2 min).
 *
 * Explicitly typed: inlining `Effect.retry` in provider lifecycle code can
 * widen the provider layer to `unknown` in declaration emit.
 *
 * @internal
 */
const retryDeleteConflict = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("4 seconds"), Schedule.recurs(30)]),
  });

/**
 * Bounded wait (~30s) for a freshly created Profile to leave `CREATING`
 * (observed to settle in a few seconds).
 *
 * @internal
 */
const untilProfileSettled = <E, R>(
  self: Effect.Effect<profiles.Profile | undefined, E, R>,
): Effect.Effect<profiles.Profile | undefined, E, R> =>
  self.pipe(
    Effect.repeat({
      schedule: Schedule.fixed("2 seconds"),
      until: (profile) =>
        profile === undefined || profile.Status !== "CREATING",
      times: 15,
    }),
  );

export const ProfileProvider = () =>
  Provider.effect(
    Profile,
    Effect.gen(function* () {
      // `props` may be undefined at runtime — all ProfileProps fields are
      // optional, so callers can omit the props object entirely.
      const createName = Effect.fn(function* (
        id: string,
        props: ProfileProps | undefined,
      ) {
        return (
          props?.name ?? (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      // A deleted Profile lingers in `DELETING`/`DELETED` and is still
      // returned by `GetProfile` — those states count as missing.
      const observe = (profileId: string) =>
        profiles.getProfile({ ProfileId: profileId }).pipe(
          Effect.map((r) =>
            r.Profile === undefined ||
            r.Profile.Status === "DELETING" ||
            r.Profile.Status === "DELETED"
              ? undefined
              : r.Profile,
          ),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );

      const findByName = (name: string) =>
        profiles.listProfiles.items({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).find((summary) => summary.Name === name),
          ),
        );

      const readTags = (profileArn: string) =>
        profiles.listTagsForResource({ ResourceArn: profileArn }).pipe(
          Effect.map((r) => {
            const tags: Record<string, string> = {};
            for (const [key, value] of Object.entries(r.Tags)) {
              if (value !== undefined) tags[key] = value;
            }
            return tags;
          }),
          Effect.catch(() => Effect.succeed({} as Record<string, string>)),
        );

      const syncTags = Effect.fn(function* (
        id: string,
        profileArn: string,
        userTags: Record<string, string> | undefined,
      ) {
        const internalTags = yield* createInternalTags(id);
        // Diff against OBSERVED cloud tags so adoption converges.
        const currentTags = yield* readTags(profileArn);
        const { upsert, removed } = diffTags(currentTags, {
          ...userTags,
          ...internalTags,
        });
        if (upsert.length > 0) {
          yield* profiles.tagResource({
            ResourceArn: profileArn,
            Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
          });
        }
        if (removed.length > 0) {
          yield* profiles.untagResource({
            ResourceArn: profileArn,
            TagKeys: removed,
          });
        }
      });

      return Profile.Provider.of({
        stables: ["profileId", "profileArn", "profileName"],
        // Top-level enumeration of every Profile in the account/region.
        list: () =>
          profiles.listProfiles.items({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((summary) =>
                summary.Id !== undefined &&
                summary.Arn !== undefined &&
                summary.Name !== undefined
                  ? [
                      {
                        profileId: summary.Id,
                        profileArn: summary.Arn,
                        profileName: summary.Name,
                      },
                    ]
                  : [],
              ),
            ),
          ),
        read: Effect.fn(function* ({ id, olds, output }) {
          const profileId =
            output?.profileId ??
            (yield* createName(id, olds ?? {}).pipe(
              Effect.flatMap(findByName),
              Effect.map((summary) => summary?.Id),
            ));
          if (profileId === undefined) return undefined;
          const live = yield* observe(profileId);
          if (!live) return undefined;
          const attrs = {
            profileId,
            profileArn: live.Arn!,
            profileName: live.Name!,
          };
          const tags = yield* readTags(live.Arn!);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          // Profiles have no update API for the name.
          if (oldName !== newName) return { action: "replace" } as const;
          // Fall through: tags changes take the default update path.
        }),
        reconcile: Effect.fn(function* ({
          id,
          instanceId,
          news,
          output,
          session,
        }) {
          const name = output?.profileName ?? (yield* createName(id, news));

          // OBSERVE — output is only an id cache; fall back to a lookup by
          // deterministic name so state loss / adoption converges.
          let live = output?.profileId
            ? yield* observe(output.profileId)
            : undefined;
          if (!live) {
            const found = yield* findByName(name);
            live = found?.Id ? yield* observe(found.Id) : undefined;
          }

          // ENSURE — the instance ID is the idempotency token, so a crashed
          // reconcile that re-runs the create is a no-op returning the same
          // Profile.
          if (!live) {
            const created = yield* profiles.createProfile({
              Name: name,
              ClientToken: instanceId,
            });
            live = created.Profile!;
          }

          // Profiles settle to COMPLETE within seconds.
          const settled = yield* untilProfileSettled(observe(live.Id!));
          live = settled ?? live;

          // SYNC tags against observed cloud tags.
          yield* syncTags(id, live.Arn!, news?.tags);

          yield* session.note(live.Id!);
          return {
            profileId: live.Id!,
            profileArn: live.Arn!,
            profileName: live.Name ?? name,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // VPC disassociations drain asynchronously; DeleteProfile conflicts
          // until they finish, so retry on a bounded schedule.
          yield* retryDeleteConflict(
            profiles.deleteProfile({ ProfileId: output.profileId }),
          ).pipe(
            Effect.asVoid,
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      });
    }),
  );
