import * as oslogin from "@distilled.cloud/gcp/oslogin_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_USER,
  findKeyByText,
  fingerprintOf,
  getSshPublicKey,
  ignoreMissing,
  resourceName,
  retryConflict,
  sameText,
  toUserId,
  toUserParent,
} from "./internal.ts";

export type UsersSshPublicKeyProps = {
  /**
   * Google account that owns the key. Email, `"me"`, or
   * `users/{user}`. `"me"` only works for user credentials; with a
   * service account, pass its email (`users/me` fails with
   * `UserCredentialMismatch`). Immutable — changing it replaces the key.
   * @default "me"
   */
  user?: string;
  /**
   * Public key text in SSH format (RFC4253). The fingerprint covers the
   * whole text (comment included), so any change replaces the key.
   */
  key: string;
  /**
   * Expiration time in microseconds since epoch. Omit for no expiry.
   */
  expirationTimeUsec?: string;
};

export type UsersSshPublicKey = Resource<
  "GCP.OSLogin.UsersSshPublicKey",
  UsersSshPublicKeyProps,
  {
    /** Canonical name `users/{user}/sshPublicKeys/{fingerprint}`. */
    name: string;
    /** User id used when the key was reconciled (`me` or email). */
    user: string;
    /** SHA-256 fingerprint of the SSH public key. */
    fingerprint: string;
    /** SSH public key text. */
    key: string;
    /** Expiration time in microseconds since epoch, if set. */
    expirationTimeUsec: string | undefined;
    /** Project id used when the key was reconciled. */
    project: string;
  },
  never,
  Providers
>;

/**
 * An OS Login SSH public key on a Google account.
 *
 * SSH public keys have no labels field, so Alchemy tracks a key by the
 * name in state; without state an identical key on the account is
 * reported as unowned. `user` and the key text are identity — changing
 * either replaces the key. Expiration updates in place. `"me"` works for
 * user credentials; service accounts must pass their email as `user`.
 *
 * ### Creating a Key
 * **Example:** Current user
 * ```typescript
 * const sshKey = yield* GCP.OSLogin.UsersSshPublicKey("Laptop", {
 *   key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... laptop",
 * });
 * ```
 *
 * **Example:** With expiration
 * ```typescript
 * const sshKey = yield* GCP.OSLogin.UsersSshPublicKey("Laptop", {
 *   user: "me",
 *   key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... laptop",
 *   expirationTimeUsec: "4102444800000000",
 * });
 * ```
 *
 * **Example:** Key for a service account
 * ```typescript
 * const sshKey = yield* GCP.OSLogin.UsersSshPublicKey("Deploy", {
 *   user: "deployer@my-project.iam.gserviceaccount.com",
 *   key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... deploy",
 * });
 * ```
 *
 * ### Updating a Key
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Extend expiration
 * ```typescript
 * const sshKey = yield* GCP.OSLogin.UsersSshPublicKey("Laptop", {
 *   key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... laptop",
 *   expirationTimeUsec: "4133980800000000",
 * });
 * ```
 *
 * @resource
 * @category OSLogin
 */
export const UsersSshPublicKey = Resource<UsersSshPublicKey>(
  "GCP.OSLogin.UsersSshPublicKey",
);

export class UsersSshPublicKeyNotResolved extends Data.TaggedError(
  "GCP.OSLogin.UsersSshPublicKeyNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (key: oslogin.SshPublicKey, user: string, project: string) => {
  const name = key.name ?? "";
  return {
    name,
    user,
    fingerprint: key.fingerprint ?? fingerprintOf(name),
    key: key.key ?? "",
    expirationTimeUsec: key.expirationTimeUsec,
    project,
  };
};

export const UsersSshPublicKeyProvider = () =>
  Provider.succeed(UsersSshPublicKey, {
    stables: ["name", "user", "fingerprint", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousUser = olds?.user ?? output?.user ?? DEFAULT_USER;
      const nextUser = toUserId(news.user, news.user);
      const oldUser = toUserId(previousUser, previousUser);
      if (
        news.user !== undefined &&
        nextUser !== oldUser &&
        nextUser !== DEFAULT_USER &&
        oldUser !== DEFAULT_USER
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousKey = olds?.key ?? output?.key;
      if (
        previousKey !== undefined &&
        news.key !== undefined &&
        !sameText(news.key.trim(), previousKey.trim())
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const user = toUserId(olds?.user, output?.user);
      const byName = yield* getSshPublicKey(
        output?.name ??
          (output?.fingerprint ? resourceName(user, output.fingerprint) : ""),
      );
      if (byName !== undefined) return toAttrs(byName, user, env.project);
      if (olds === undefined) return undefined;
      // No labels: an identical key without state may belong to anyone.
      const found = yield* findKeyByText(user, olds.key, env.project);
      return found === undefined
        ? undefined
        : Unowned(toAttrs(found, user, env.project));
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const user = toUserId(news.user, output?.user);
      const desiredKey = news.key.trim();

      let current = yield* getSshPublicKey(output?.name ?? "");
      if (current === undefined) {
        current = yield* findKeyByText(user, desiredKey, env.project);
      }

      if (current === undefined) {
        const created = yield* retryConflict(
          oslogin.createUsersSshPublicKeys({
            parent: toUserParent(user),
            body: {
              key: desiredKey,
              expirationTimeUsec: news.expirationTimeUsec,
            },
          }),
        ).pipe(
          Effect.catchTag("Conflict", () =>
            findKeyByText(user, desiredKey, env.project),
          ),
        );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new UsersSshPublicKeyNotResolved({
          name: output?.name ?? resourceName(user, output?.fingerprint ?? ""),
        });
      }

      const name =
        current.name ??
        resourceName(user, current.fingerprint ?? output?.fingerprint ?? "");
      // The fingerprint covers the full key text, so `key` is never patched.
      const expirationChanged =
        (current.expirationTimeUsec ?? "") !== (news.expirationTimeUsec ?? "");

      if (expirationChanged) {
        current = yield* retryConflict(
          oslogin.patchUsersSshPublicKeys({
            name,
            updateMask: "expirationTimeUsec",
            body: {
              expirationTimeUsec: news.expirationTimeUsec,
            },
          }),
        );
      }

      return toAttrs(current, user, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name =
        output.name ||
        (output.fingerprint
          ? resourceName(output.user || DEFAULT_USER, output.fingerprint)
          : "");
      if (name.length === 0) return;
      yield* ignoreMissing(
        retryConflict(oslogin.deleteUsersSshPublicKeys({ name })),
      );
    }),
  });
