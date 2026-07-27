import * as iam from "@distilled.cloud/cloudflare/iam";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Iam.UserGroupMembership" as const;
type TypeId = typeof TypeId;

export interface UserGroupMembershipProps {
  /**
   * ID of the user group to add the member to — e.g.
   * `userGroup.userGroupId`. Immutable — changing it triggers a
   * replacement.
   */
  userGroup: string;
  /**
   * Account member ID to add to the user group (the membership id from
   * the account's member roster, not the user id). Immutable — changing
   * it triggers a replacement.
   */
  memberId: string;
}

export interface UserGroupMembershipAttributes {
  /** ID of the user group the member belongs to. */
  userGroupId: string;
  /** Account member ID of the member. */
  memberId: string;
  /** The Cloudflare account the user group belongs to. */
  accountId: string;
  /** The contact email address of the member, if known. */
  email: string | undefined;
  /** The member's status in the account (`accepted` or `pending`). */
  status: string | undefined;
}

export type UserGroupMembership = Resource<
  TypeId,
  UserGroupMembershipProps,
  UserGroupMembershipAttributes,
  never,
  Providers
>;

/**
 * Membership of a single account member in a Cloudflare IAM user group.
 *
 * This is an existence-only resource: it has no mutable aspects beyond its
 * identity (user group + member), so changing either property triggers a
 * replacement. Cloudflare's member-add API is idempotent — adding a member
 * who is already in the group succeeds — so reconcile is a simple
 * observe-then-ensure flow.
 *
 * Account-scoped IAM (user groups and their members) is an Enterprise
 * feature.
 * @resource
 * @product IAM
 * @category Account & Identity
 * @section Adding a Member
 * @example Add an account member to a user group
 * ```typescript
 * const group = yield* Cloudflare.Iam.UserGroup("Operators", {});
 *
 * yield* Cloudflare.Iam.UserGroupMembership("SamInOperators", {
 *   userGroup: group.userGroupId,
 *   memberId: "b67b4c279ea0177a0ddff0a2ef64b11b",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/fundamentals/manage-members/user-groups/
 */
export const UserGroupMembership = Resource<UserGroupMembership>(TypeId);

/**
 * Returns true if the given value is an UserGroupMembership resource.
 */
export const isUserGroupMembership = (
  value: unknown,
): value is UserGroupMembership =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const UserGroupMembershipProvider = () =>
  Provider.succeed(UserGroupMembership, {
    stables: ["userGroupId", "memberId", "accountId"],

    // Parent fan-out: memberships are keyed by (user group, member) and
    // there is no account-wide membership enumeration API. Enumerate every
    // user group in the account (account-scoped), then list each group's
    // members with bounded concurrency, paginating both levels exhaustively.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const groups = yield* iam.listUserGroups.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) => page.result ?? []),
        ),
      );
      const rows = yield* Effect.forEach(
        groups,
        (group) =>
          iam.listUserGroupMembers
            .pages({ accountId, userGroupId: group.id })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.result ?? []).map(
                    (member): UserGroupMembershipAttributes =>
                      toAttributes(member, group.id, accountId),
                  ),
                ),
              ),
              // Group removed out-of-band between enumeration and member
              // listing — skip it.
              Effect.catchTag("UserGroupNotFound", () =>
                Effect.succeed([] as UserGroupMembershipAttributes[]),
              ),
              // A group whose policy Cloudflare can't validate rejects the
              // member listing with a 400 ("Policy validation failed"). It's
              // not ours to enumerate — contribute nothing rather than failing
              // the whole account-wide listing.
              Effect.catchTag("PolicyValidationFailed", () =>
                Effect.succeed([] as UserGroupMembershipAttributes[]),
              ),
            ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      // Identity change — both props are the resource's identity, so any
      // change is a replacement. Compare only once both sides are concrete.
      if (
        typeof olds?.userGroup === "string" &&
        olds.userGroup !== news.userGroup
      ) {
        return { action: "replace" } as const;
      }
      if (
        typeof olds?.memberId === "string" &&
        olds.memberId !== news.memberId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      // Cold read falls back to the previous props — the identity is fully
      // user-specified, so the (group, member) pair is the lookup key. The
      // props may still hold an unresolved `Output` (e.g. a reference to a
      // sibling group's id when state was persisted before reconcile), so
      // only use them as a lookup key once they're concrete strings —
      // otherwise there is nothing to read.
      const oldGroup =
        typeof olds?.userGroup === "string" ? olds.userGroup : undefined;
      const oldMember =
        typeof olds?.memberId === "string" ? olds.memberId : undefined;
      const userGroupId = output?.userGroupId ?? oldGroup;
      const memberId = output?.memberId ?? oldMember;
      if (userGroupId === undefined || memberId === undefined) {
        return undefined;
      }
      const observed = yield* getMembership(acct, userGroupId, memberId);
      return observed ? toAttributes(observed, userGroupId, acct) : undefined;
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Inputs have been resolved to concrete strings by Plan.
      const userGroupId = news.userGroup as string;
      const memberId = news.memberId as string;

      // A user group created earlier in the same deploy is eventually
      // consistent: its `/members` sub-resource API briefly answers GET and
      // POST with `UserGroupNotFound` (404) until the new group propagates
      // across Cloudflare's edge. Ride out that window with a bounded retry
      // — `UserGroupNotFound` here means "the group isn't visible yet", not
      // "the group is gone" (we are mid-create of its membership).
      const ensure = Effect.gen(function* () {
        // Observe — membership is existence-only; if it's already there we
        // are done. A missing *member* (`UserGroupMemberNotFound`) is the
        // expected greenfield state; a missing *group* (`UserGroupNotFound`)
        // bubbles to the retry below.
        const observed = yield* iam
          .getUserGroupMember({ accountId, userGroupId, memberId })
          .pipe(
            Effect.map((m): ObservedMember | undefined => m),
            Effect.catchTag("UserGroupMemberNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
        if (observed) {
          return toAttributes(observed, userGroupId, accountId);
        }

        // Ensure — add the member. The batch POST is idempotent for members
        // already in the group, so a concurrent add is not an error.
        const created = yield* iam.createUserGroupMember({
          accountId,
          userGroupId,
          members: [{ id: memberId }],
        });
        const member = created.result.find((m) => m.id === memberId);
        if (member) {
          return toAttributes(member, userGroupId, accountId);
        }
        // The POST response echoes the full member set; fall back to a read
        // for the member we just added.
        const reread = yield* getMembership(accountId, userGroupId, memberId);
        return toAttributes(reread ?? { id: memberId }, userGroupId, accountId);
      });

      return yield* ensure.pipe(
        Effect.retry({
          while: (e) => e._tag === "UserGroupNotFound",
          schedule: Schedule.exponential("500 millis"),
          times: 8,
        }),
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* iam
        .deleteUserGroupMember({
          accountId: output.accountId,
          userGroupId: output.userGroupId,
          memberId: output.memberId,
        })
        .pipe(
          // Already gone — the member (404 in group, or no longer a valid
          // account member at all → InvalidMember) or the whole user group
          // (404) has been removed out-of-band.
          Effect.catchTag(
            ["UserGroupMemberNotFound", "UserGroupNotFound", "InvalidMember"],
            () => Effect.void,
          ),
        );
    }),
  });

type ObservedMember = {
  id: string;
  email?: string | null;
  status?: string | null;
};

/**
 * Read a membership, mapping "gone" — the member not being in the group
 * (`UserGroupMemberNotFound`) or the group itself missing
 * (`UserGroupNotFound`) — to `undefined`.
 */
const getMembership = (
  accountId: string,
  userGroupId: string,
  memberId: string,
) =>
  iam.getUserGroupMember({ accountId, userGroupId, memberId }).pipe(
    Effect.map((m): ObservedMember | undefined => m),
    Effect.catchTag(["UserGroupMemberNotFound", "UserGroupNotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

const toAttributes = (
  member: ObservedMember,
  userGroupId: string,
  accountId: string,
): UserGroupMembershipAttributes => ({
  userGroupId,
  memberId: member.id,
  accountId,
  email: member.email ?? undefined,
  status: member.status ?? undefined,
});
