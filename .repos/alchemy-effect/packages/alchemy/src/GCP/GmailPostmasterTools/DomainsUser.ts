import * as gmailpostmastertools from "@distilled.cloud/gcp/gmailpostmastertools_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_PERMISSION,
  findUser,
  fullUserName,
  ignoreMissing,
  isAlchemyEmail,
  isPatchablePermission,
  listOwnedUsers,
  normalize,
  parentOfUserName,
  sameText,
  toDomainName,
  toGeneratedUserId,
  toUserName,
  userEmailOf,
} from "./internal.ts";

export type DomainsUserProps = {
  /**
   * Parent domain (`domains/{domain}` or the FQDN). Immutable —
   * changing it replaces the user.
   */
  parent: string;
  /**
   * User email. If omitted, a unique `alchemy-*@example.com` address is
   * generated. Immutable — changing it replaces the user. Users have no
   * labels field, so Alchemy stamps ownership into the generated local
   * part for `list` / nuke.
   */
  userId?: string;
  /**
   * Permission on the parent domain. Updates in place for `READER` and
   * `ADMIN`. `OWNER` and `NONE` cannot be patched.
   * @default "READER"
   */
  permission?: gmailpostmastertools.UserPermissionEnum | (string & {});
};

export type DomainsUser = Resource<
  "GCP.GmailPostmasterTools.DomainsUser",
  DomainsUserProps,
  {
    /** Full resource name `domains/{domain}/users/{user}`. */
    name: string;
    /** Parent domain name `domains/{domain}`. */
    parent: string;
    /** User email. */
    userId: string;
    /** Project id used when the user was reconciled. */
    project: string;
    /** Permission on the parent domain. */
    permission: string | undefined;
    /** RFC3339 time access was granted. */
    createTime: string | undefined;
    /** Email of the user that granted access. */
    accessGranter: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Gmail Postmaster Tools domain user.
 *
 * Users have no labels or description, so identity is `(parent, userId)`
 * and `list` / nuke returns rows whose email local-part starts with
 * `alchemy-`. Permission updates in place (`READER` / `ADMIN`). Changing
 * parent or email replaces the user.
 *
 * ### Creating a User
 * **Example:** Generated email
 * ```typescript
 * const user = yield* GCP.GmailPostmasterTools.DomainsUser("Ada", {
 *   parent: domain.name,
 * });
 * ```
 *
 * **Example:** Explicit email and permission
 * ```typescript
 * const user = yield* GCP.GmailPostmasterTools.DomainsUser("Ada", {
 *   parent: domain.name,
 *   userId: "ada@example.com",
 *   permission: "ADMIN",
 * });
 * ```
 *
 * ### Updating a User
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Change permission
 * ```typescript
 * const user = yield* GCP.GmailPostmasterTools.DomainsUser("Ada", {
 *   parent: domain.name,
 *   userId: "ada@example.com",
 *   permission: "READER",
 * });
 * ```
 *
 * @resource
 * @category Gmail Postmaster Tools
 */
export const DomainsUser = Resource<DomainsUser>(
  "GCP.GmailPostmasterTools.DomainsUser",
);

export class DomainsUserNotResolved extends Data.TaggedError(
  "GCP.GmailPostmasterTools.DomainsUserNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  user: gmailpostmastertools.User,
  parent: string,
  project: string,
) => {
  const resolvedParent =
    parentOfUserName(user.name ?? "") || toDomainName(parent);
  const name = fullUserName(resolvedParent, user);
  return {
    name,
    parent: resolvedParent,
    userId: userEmailOf(user),
    project,
    permission: user.permission,
    createTime: user.createTime,
    accessGranter: user.accessGranter,
  };
};

export const DomainsUserProvider = () =>
  Provider.succeed(DomainsUser, {
    stables: ["name", "parent", "userId", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      if (
        previousParent !== undefined &&
        toDomainName(news.parent) !== toDomainName(previousParent)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousUser = olds?.userId ?? output?.userId;
      if (
        previousUser !== undefined &&
        news.userId !== undefined &&
        normalize(news.userId) !== normalize(previousUser)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = olds?.parent ?? output?.parent ?? "";
      const userId = olds?.userId ?? output?.userId ?? "";
      const existing = yield* findUser(
        parent,
        userId,
        output?.name ?? toUserName(parent, userId),
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, parent, env.project);
      return output !== undefined || isAlchemyEmail(attrs.userId)
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const users = yield* listOwnedUsers();
        return users.map((user) =>
          toAttrs(user, parentOfUserName(user.name ?? "") || "", env.project),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = toDomainName(news.parent);
      const userId = yield* toGeneratedUserId(id, news.userId, output?.userId);
      const name = toUserName(parent, userId);
      const permission = news.permission ?? DEFAULT_PERMISSION;

      let current = yield* findUser(parent, userId, output?.name ?? name);

      if (current === undefined) {
        const created = yield* gmailpostmastertools
          .createDomainsUsers({
            parent,
            body: { userId, permission },
          })
          .pipe(
            Effect.catchTag("Conflict", () => findUser(parent, userId, name)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DomainsUserNotResolved({ name });
      }

      const resourceName = fullUserName(parent, current);
      if (
        isPatchablePermission(permission) &&
        !sameText(current.permission, permission)
      ) {
        current = yield* gmailpostmastertools.patchDomainsUsers({
          name: resourceName,
          updateMask: "permission",
          body: { permission },
        });
      }

      const fresh = (yield* findUser(parent, userId, resourceName)) ?? current;
      return toAttrs(fresh, parent, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name || toUserName(output.parent, output.userId);
      if (name.length === 0) return;
      yield* ignoreMissing(gmailpostmastertools.deleteDomainsUsers({ name }));
    }),
  });
