import * as cloudidentity from "@distilled.cloud/gcp/cloudidentity_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  expandGroup,
  getMembership,
  getMembershipByKey,
  lastSegment,
  listMemberships,
  listOwnedGroups,
  replaceOnIdentity,
  sameJson,
  sameText,
} from "./internal.ts";
import {
  resourceNameFromOperation,
  waitForOperation,
  waitUntilPresent,
} from "./operations.ts";

export type GroupsMembershipRole = {
  /** Role name: `OWNER`, `MANAGER`, or `MEMBER`. */
  name?: string;
  /** Expiry, only valid when `name` is `MEMBER`. */
  expiryDetail?: {
    expireTime?: string;
  };
};

export type GroupsMembershipProps = {
  /**
   * Parent group resource name (`groups/{group}`) or group id.
   * Immutable — changing it replaces the membership.
   */
  parent: string;
  /**
   * Member entity key id (user or group email). Immutable —
   * changing it replaces the membership.
   */
  memberKeyId: string;
  /**
   * Member entity-key namespace for external identities.
   */
  memberKeyNamespace?: string;
  /**
   * Roles for the membership. Defaults to a single `MEMBER` role.
   * `MEMBER` cannot be removed; drop `MANAGER` / `OWNER` in place.
   */
  roles?: GroupsMembershipRole[];
};

export type GroupsMembership = Resource<
  "GCP.CloudIdentity.GroupsMembership",
  GroupsMembershipProps,
  {
    /** Resource name `groups/{group}/memberships/{membership}`. */
    name: string;
    /** Membership id (last path segment). */
    membershipId: string;
    /** Parent group name. */
    parent: string;
    /** Member entity key id. */
    memberKeyId: string;
    /** Member entity-key namespace, if any. */
    memberKeyNamespace: string | undefined;
    /** Membership roles. */
    roles: GroupsMembershipRole[];
    /** Member type (`USER`, `GROUP`, …). */
    type: string | undefined;
    /** Delivery setting. */
    deliverySetting: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Identity group membership.
 *
 * Memberships have no labels or description, so Alchemy lists
 * memberships of alchemy-owned groups (ownership stamped on the parent
 * group description) for `list` / nuke. Parent group and member key
 * are identity; roles update in place via `modifyMembershipRoles`.
 *
 * ### Creating a Membership
 * **Example:** Add a member
 * ```typescript
 * const membership = yield* GCP.CloudIdentity.GroupsMembership("Ada", {
 *   parent: group.name,
 *   memberKeyId: "ada@example.com",
 * });
 * ```
 *
 * **Example:** Manager role
 * ```typescript
 * const membership = yield* GCP.CloudIdentity.GroupsMembership("Ada", {
 *   parent: group.name,
 *   memberKeyId: "ada@example.com",
 *   roles: [{ name: "MEMBER" }, { name: "MANAGER" }],
 * });
 * ```
 *
 * @resource
 * @category CloudIdentity
 */
export const GroupsMembership = Resource<GroupsMembership>(
  "GCP.CloudIdentity.GroupsMembership",
);

export class GroupsMembershipNotResolved extends Data.TaggedError(
  "GCP.CloudIdentity.GroupsMembershipNotResolved",
)<{
  parent: string;
  memberKeyId: string;
}> {}

const DEFAULT_ROLES: GroupsMembershipRole[] = [{ name: "MEMBER" }];

const rolesOf = (
  roles: cloudidentity.MembershipRoleList | undefined,
): GroupsMembershipRole[] =>
  (roles ?? DEFAULT_ROLES).map((role) => ({
    name: role.name,
    expiryDetail: role.expiryDetail
      ? { expireTime: role.expiryDetail.expireTime }
      : undefined,
  }));

const desiredRoles = (roles: GroupsMembershipRole[] | undefined) => {
  const next = roles !== undefined && roles.length > 0 ? roles : DEFAULT_ROLES;
  return next.map((role) => ({
    name: role.name ?? "MEMBER",
    expiryDetail: role.expiryDetail,
  }));
};

const roleNames = (roles: GroupsMembershipRole[]) =>
  [...roles]
    .map((role) => role.name ?? "MEMBER")
    .sort((left, right) => left.localeCompare(right));

const parentOfName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const index = parts.lastIndexOf("memberships");
  return index > 0 ? parts.slice(0, index).join("/") : expandGroup(name);
};

const toAttrs = (membership: cloudidentity.Membership, parent: string) => {
  const name = membership.name ?? "";
  return {
    name,
    membershipId: lastSegment(name),
    parent: parentOfName(name) || parent,
    memberKeyId: membership.preferredMemberKey?.id ?? "",
    memberKeyNamespace: membership.preferredMemberKey?.namespace,
    roles: rolesOf(membership.roles),
    type: membership.type,
    deliverySetting: membership.deliverySetting,
    createTime: membership.createTime,
    updateTime: membership.updateTime,
  };
};

const observeMembership = (input: {
  name?: string;
  parent: string;
  memberKeyId: string;
  memberKeyNamespace?: string;
}) =>
  Effect.gen(function* () {
    const byName = yield* getMembership(input.name ?? "");
    if (byName !== undefined) return byName;
    return yield* getMembershipByKey(
      input.parent,
      input.memberKeyId,
      input.memberKeyNamespace,
    );
  });

const syncRoles = (
  name: string,
  current: cloudidentity.Membership,
  desired: GroupsMembershipRole[],
) =>
  Effect.gen(function* () {
    const observed = rolesOf(current.roles);
    if (sameJson(observed, desired)) return current;

    const currentNames = new Set(roleNames(observed));
    const desiredNames = new Set(roleNames(desired));
    const addRoles = desired.filter(
      (role) => !currentNames.has(role.name ?? "MEMBER"),
    );
    const removeRoles = roleNames(observed).filter(
      (role) => role !== "MEMBER" && !desiredNames.has(role),
    );

    let next = current;
    if (addRoles.length > 0 || removeRoles.length > 0) {
      const modified =
        yield* cloudidentity.modifyMembershipRolesGroupsMemberships({
          name,
          body: {
            addRoles: addRoles.length > 0 ? addRoles : undefined,
            removeRoles: removeRoles.length > 0 ? removeRoles : undefined,
          },
        });
      next = modified.membership ?? next;
    }

    const memberExpiry = desired.find((role) => role.name === "MEMBER")
      ?.expiryDetail?.expireTime;
    const observedExpiry = rolesOf(next.roles).find(
      (role) => role.name === "MEMBER",
    )?.expiryDetail?.expireTime;
    if (!sameText(memberExpiry, observedExpiry) && memberExpiry !== undefined) {
      const modified =
        yield* cloudidentity.modifyMembershipRolesGroupsMemberships({
          name,
          body: {
            updateRolesParams: [
              {
                fieldMask: "expiry_detail.expire_time",
                membershipRole: {
                  name: "MEMBER",
                  expiryDetail: { expireTime: memberExpiry },
                },
              },
            ],
          },
        });
      next = modified.membership ?? next;
    }

    return next;
  });

export const GroupsMembershipProvider = () =>
  Provider.succeed(GroupsMembership, {
    stables: ["name", "membershipId", "parent", "memberKeyId", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousId: olds?.memberKeyId ?? output?.memberKeyId,
        nextId: news.memberKeyId,
        previousParent: olds?.parent ?? output?.parent,
        nextParent: expandGroup(news.parent),
        extra:
          news.memberKeyNamespace !== undefined &&
          output?.memberKeyNamespace !== undefined &&
          news.memberKeyNamespace !== output.memberKeyNamespace,
      });
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const parent = expandGroup(olds?.parent ?? output?.parent ?? "");
      const memberKeyId = olds?.memberKeyId ?? output?.memberKeyId ?? "";
      const existing = yield* observeMembership({
        name: output?.name,
        parent,
        memberKeyId,
        memberKeyNamespace:
          olds?.memberKeyNamespace ?? output?.memberKeyNamespace,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, parent);
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const groups = yield* listOwnedGroups();
        const pages = yield* Effect.forEach(
          groups,
          (group) =>
            group.name
              ? listMemberships(group.name).pipe(
                  Effect.map((memberships) =>
                    memberships.map((membership) =>
                      toAttrs(membership, group.name ?? ""),
                    ),
                  ),
                )
              : Effect.succeed([]),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const parent = expandGroup(news.parent);
      const memberKeyId = news.memberKeyId;
      const memberKeyNamespace = news.memberKeyNamespace;
      const roles = desiredRoles(news.roles);

      let current = yield* observeMembership({
        name: output?.name,
        parent,
        memberKeyId,
        memberKeyNamespace,
      });

      if (current === undefined) {
        const created = yield* cloudidentity
          .createGroupsMemberships({
            parent,
            body: {
              preferredMemberKey: {
                id: memberKeyId,
                namespace: memberKeyNamespace,
              },
              roles,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              Effect.succeed<cloudidentity.Operation | undefined>(undefined),
            ),
          );
        if (created !== undefined) {
          yield* waitForOperation(created).pipe(
            Effect.catchTag(
              "GCP.CloudIdentity.OperationPending",
              () => Effect.void,
            ),
          );
          const createdName = resourceNameFromOperation(created);
          if (createdName !== undefined) {
            current = yield* getMembership(createdName);
          }
        }
        if (current === undefined) {
          current = yield* waitUntilPresent(
            observeMembership({
              name: output?.name,
              parent,
              memberKeyId,
              memberKeyNamespace,
            }),
            memberKeyId,
          ).pipe(
            Effect.catchTag("GCP.CloudIdentity.OperationPending", () =>
              observeMembership({
                parent,
                memberKeyId,
                memberKeyNamespace,
              }),
            ),
          );
        }
      }

      if (current === undefined) {
        return yield* new GroupsMembershipNotResolved({
          parent,
          memberKeyId,
        });
      }

      const name = current.name ?? output?.name ?? "";
      if (name.length > 0) {
        current = yield* syncRoles(name, current, roles);
      }

      return toAttrs(current, parent);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.name.length === 0) return;
      const deleted = yield* cloudidentity
        .deleteGroupsMemberships({ name: output.name })
        .pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed<cloudidentity.Operation | undefined>(undefined),
          ),
        );
      if (deleted !== undefined) {
        yield* waitForOperation(deleted, { notFoundOk: true });
      }
    }),
  });
