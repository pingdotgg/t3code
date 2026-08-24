import * as iam from "@distilled.cloud/cloudflare/iam";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Iam.UserGroup" as const;
type TypeId = typeof TypeId;

/**
 * A fine-grained policy attached to a user group: an allow/deny decision
 * over a set of permission groups (what actions) and resource groups
 * (which resources).
 */
export interface UserGroupPolicyInput {
  /**
   * Whether the policy allows or denies the combined permission/resource
   * groups. Note: Cloudflare currently rejects `deny` user-group policies
   * with "Policy validation failed" — only `allow` is accepted in
   * practice.
   */
  access: "allow" | "deny";
  /**
   * IDs of the permission groups (what actions are permitted). Look these
   * up via the account's `/iam/permission_groups` catalog.
   */
  permissionGroups: string[];
  /**
   * IDs of the resource groups (which resources the permissions apply
   * to) — e.g. from {@link ResourceGroup}.
   */
  resourceGroups: string[];
}

/**
 * A fully-resolved user group policy as observed on Cloudflare, including
 * the server-assigned policy id.
 */
export interface UserGroupPolicy {
  /**
   * Server-assigned identifier of the policy. Not stable — Cloudflare
   * assigns fresh policy ids on every policy update.
   */
  id: string | undefined;
  /** Whether the policy allows or denies. */
  access: "allow" | "deny";
  /** IDs of the permission groups in the policy. */
  permissionGroups: string[];
  /** IDs of the resource groups in the policy. */
  resourceGroups: string[];
}

export interface UserGroupProps {
  /**
   * Name of the user group. If omitted, a unique name is generated from
   * the app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Fine-grained policies attached to the user group. Mutable in place —
   * the full set is replaced on update.
   */
  policies?: UserGroupPolicyInput[];
}

export interface UserGroupAttributes {
  /** Cloudflare-assigned identifier of the user group. */
  userGroupId: string;
  /** The Cloudflare account the user group belongs to. */
  accountId: string;
  /** Name of the user group. */
  name: string;
  /** Policies attached to the user group (with server-assigned ids). */
  policies: UserGroupPolicy[];
  /** ISO8601 creation timestamp. */
  createdOn: string;
  /** ISO8601 last-modified timestamp. */
  modifiedOn: string;
}

export type UserGroup = Resource<
  TypeId,
  UserGroupProps,
  UserGroupAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare IAM user group — a named set of account members that share
 * fine-grained policies (permission groups scoped to resource groups).
 *
 * Both `name` and `policies` are mutable in place; updating policies
 * replaces the full set. Add members with
 * {@link UserGroupMembership}.
 *
 * Account-scoped IAM (resource groups, user groups) is an Enterprise
 * feature.
 * @resource
 * @product IAM
 * @category Account & Identity
 * @section Creating a User Group
 * @example Empty group
 * ```typescript
 * const group = yield* Cloudflare.Iam.UserGroup("Operators", {});
 * ```
 *
 * @example Group with a policy
 * ```typescript
 * const readers = yield* Cloudflare.Iam.UserGroup("Readers", {
 *   name: "zone-readers",
 *   policies: [
 *     {
 *       access: "allow",
 *       permissionGroups: [readOnlyPermissionGroupId],
 *       resourceGroups: [resourceGroup.resourceGroupId],
 *     },
 *   ],
 * });
 * ```
 *
 * @section Managing Members
 * @example Add an account member to the group
 * ```typescript
 * yield* Cloudflare.Iam.UserGroupMembership("SamInReaders", {
 *   userGroup: readers.userGroupId,
 *   memberId: accountMember.memberId,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/fundamentals/manage-members/user-groups/
 */
export const UserGroup = Resource<UserGroup>(TypeId);

/**
 * Returns true if the given value is an UserGroup resource.
 */
export const isUserGroup = (value: unknown): value is UserGroup =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const UserGroupProvider = () =>
  Provider.succeed(UserGroup, {
    stables: ["userGroupId", "accountId", "createdOn"],

    // Account-scoped collection: exhaustively paginate the account's
    // user-groups list. Each page item already carries the full shape
    // (`id`/`name`/`policies`/`createdOn`/`modifiedOn`) identical to the
    // single-get response, so it hydrates directly into `read`'s
    // Attributes via `toAttributes` — no per-item re-fetch needed.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* iam.listUserGroups.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((group) => toAttributes(group, accountId)),
          ),
        ),
      );
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      if (output?.userGroupId) {
        const observed = yield* getUserGroup(acct, output.userGroupId);
        return observed ? toAttributes(observed, acct) : undefined;
      }

      // Cold read — recover from lost state by matching the deterministic
      // physical name (exact match, re-checked client-side).
      const name = yield* createGroupName(id, olds?.name);
      const match = yield* findByName(acct, name);
      if (match) {
        const observed = yield* getUserGroup(acct, match.id);
        return observed ? toAttributes(observed, acct) : undefined;
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createGroupName(id, news.name);
      const desired = resolvePolicies(news.policies ?? []);

      // 1. Observe — the id cached on `output` is a hint, not a
      //    guarantee: a missing group falls through to the name scan and
      //    then to create.
      let observed = output?.userGroupId
        ? yield* getUserGroup(accountId, output.userGroupId)
        : undefined;
      if (!observed) {
        const match = yield* findByName(accountId, name);
        observed = match ? yield* getUserGroup(accountId, match.id) : undefined;
      }

      // 2. Ensure — create when missing. User group names ARE unique on
      //    Cloudflare's side; losing a create race surfaces as the typed
      //    `UserGroupNameInUse`, in which case we observe the winner and
      //    fall through to sync.
      if (!observed) {
        const created = yield* iam
          .createUserGroup({
            accountId,
            name,
            policies: desired.length > 0 ? desired : undefined,
          })
          .pipe(
            Effect.catchTag("UserGroupNameInUse", () =>
              Effect.succeed(undefined),
            ),
          );
        if (created) {
          return toAttributes(created, accountId);
        }
        const match = yield* findByName(accountId, name);
        observed = match ? yield* getUserGroup(accountId, match.id) : undefined;
        if (!observed) {
          // The name is claimed but invisible to our listing — re-attempt
          // the create so the typed conflict surfaces rather than looping.
          const retried = yield* iam.createUserGroup({
            accountId,
            name,
            policies: desired.length > 0 ? desired : undefined,
          });
          return toAttributes(retried, accountId);
        }
      }

      // 3. Sync — diff observed name/policies against desired. The PUT
      //    replaces the full policy set and entries MUST be sent without
      //    ids (Cloudflare rejects re-used policy ids with "Cannot re-use
      //    policy IDs"); the server assigns fresh ids on every update.
      //    Skip the call entirely on a no-op.
      const observedPolicies = parsePolicies(observed.policies);
      const dirty =
        observed.name !== name || !samePolicies(observedPolicies, desired);
      if (!dirty) {
        return toAttributes(observed, accountId);
      }

      const updated = yield* iam.updateUserGroup({
        accountId,
        userGroupId: observed.id,
        name,
        policies: desired,
      });
      return toAttributes(updated, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* iam
        .deleteUserGroup({
          accountId: output.accountId,
          userGroupId: output.userGroupId,
        })
        .pipe(Effect.catchTag("UserGroupNotFound", () => Effect.void));
    }),
  });

type ObservedUserGroup = iam.GetUserGroupResponse;

/**
 * Read a user group by id, mapping "gone" (`UserGroupNotFound`,
 * HTTP 404) to `undefined`.
 */
const getUserGroup = (accountId: string, userGroupId: string) =>
  iam.getUserGroup({ accountId, userGroupId }).pipe(
    Effect.map((g): ObservedUserGroup | undefined => g),
    Effect.catchTag("UserGroupNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a user group by exact name (re-checked client-side). User group
 * names are unique on Cloudflare's side; the sort is belt-and-braces
 * determinism.
 */
const findByName = (accountId: string, name: string) =>
  iam.listUserGroups.items({ accountId, name }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk)
        .filter((g) => g.name === name)
        .sort((a, b) => a.createdOn.localeCompare(b.createdOn))
        .at(0),
    ),
  );

const createGroupName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

/** Resolve `Input<string>` policy ids to concrete strings (post-Plan). */
const resolvePolicies = (policies: UserGroupPolicyInput[]) =>
  policies.map((p) => ({
    access: p.access,
    permissionGroups: p.permissionGroups.map((id) => ({ id: id as string })),
    resourceGroups: p.resourceGroups.map((id) => ({ id: id as string })),
  }));

const parsePolicies = (
  policies: ObservedUserGroup["policies"],
): UserGroupPolicy[] =>
  (policies ?? []).map((p) => ({
    id: p.id ?? undefined,
    access: p.access === "deny" ? "deny" : "allow",
    permissionGroups: (p.permissionGroups ?? []).map((g) => g.id),
    resourceGroups: (p.resourceGroups ?? []).map((g) => g.id),
  }));

/** Canonical string form of a policy set for order-insensitive diffing. */
const policyKey = (p: {
  access: string;
  permissionGroups: { id: string }[] | string[];
  resourceGroups: { id: string }[] | string[];
}) => {
  const ids = (xs: { id: string }[] | string[]) =>
    xs
      .map((x) => (typeof x === "string" ? x : x.id))
      .sort()
      .join(",");
  return `${p.access}|${ids(p.permissionGroups)}|${ids(p.resourceGroups)}`;
};

const samePolicies = (
  observed: UserGroupPolicy[],
  desired: ReturnType<typeof resolvePolicies>,
) =>
  observed.length === desired.length &&
  observed.map(policyKey).sort().join(";") ===
    desired.map(policyKey).sort().join(";");

const toAttributes = (
  group:
    | iam.GetUserGroupResponse
    | iam.CreateUserGroupResponse
    | iam.UpdateUserGroupResponse,
  accountId: string,
): UserGroupAttributes => ({
  userGroupId: group.id,
  accountId,
  name: group.name,
  policies: parsePolicies(group.policies),
  createdOn: group.createdOn,
  modifiedOn: group.modifiedOn,
});
