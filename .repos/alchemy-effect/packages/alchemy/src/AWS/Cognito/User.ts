import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface UserProps {
  /**
   * The ID of the user pool the user belongs to. Changing this triggers a
   * replacement.
   */
  userPoolId: string;
  /**
   * The username. If omitted, a deterministic physical name is generated
   * from the app, stage, and logical ID. Changing this triggers a
   * replacement. For pools with `usernameAttributes` this must be a value
   * of one of those attributes (e.g. an email address).
   */
  username?: string;
  /**
   * User attributes as name → value pairs (e.g.
   * `{ email: "a@b.com", email_verified: "true" }`). Attributes declared
   * here are kept in sync; removing a previously declared attribute deletes
   * it from the user.
   */
  attributes?: Record<string, string>;
  /**
   * A permanent password for the user, set via `AdminSetUserPassword`
   * (`Permanent: true`), which moves the user to `CONFIRMED`. Without it
   * the user is created in `FORCE_CHANGE_PASSWORD` state. Must satisfy the
   * pool's password policy. Wrap with `Redacted.make(...)` so the value
   * never leaks into logs or state output.
   */
  password?: Redacted.Redacted<string>;
  /**
   * Whether the user account is enabled.
   * @default true
   */
  enabled?: boolean;
}

export interface User extends Resource<
  "AWS.Cognito.User",
  UserProps,
  {
    /** The username. */
    username: string;
    /** The ID of the user pool the user belongs to. */
    userPoolId: string;
    /** The user's stable unique identifier (the `sub` attribute). */
    sub: string;
    /** The user's status, e.g. `CONFIRMED` or `FORCE_CHANGE_PASSWORD`. */
    userStatus: string;
  },
  never,
  Providers
> {}

/**
 * A user within an Amazon Cognito user pool, created administratively via
 * `AdminCreateUser`. The invitation message is always suppressed
 * (`MessageAction: SUPPRESS`) — declaratively managed users never trigger
 * invite emails/SMS; set a permanent `password` to make the account usable
 * immediately.
 * @resource
 * @section Creating Users
 * @example Basic User
 * ```typescript
 * import * as Cognito from "alchemy/AWS/Cognito";
 *
 * const pool = yield* Cognito.UserPool("Users", {});
 * const user = yield* Cognito.User("Admin", {
 *   userPoolId: pool.userPoolId,
 *   attributes: { email: "admin@example.com", email_verified: "true" },
 * });
 * ```
 *
 * @example Confirmed User with a Permanent Password
 * ```typescript
 * import * as Redacted from "effect/Redacted";
 *
 * const user = yield* Cognito.User("ServiceAccount", {
 *   userPoolId: pool.userPoolId,
 *   username: "service-account",
 *   password: Redacted.make("A-Str0ng-Passw0rd!"),
 *   attributes: { email: "svc@example.com", email_verified: "true" },
 * });
 * // user.userStatus === "CONFIRMED"
 * ```
 */
export const User = Resource<User>("AWS.Cognito.User");

const plain = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.value(value);

/** Observed user attributes as a plain name → value record. */
const attributeRecordOf = (
  attributes: cip.AttributeType[] | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (attributes ?? []).flatMap((attribute) => {
      const value = plain(attribute.Value);
      return value === undefined ? [] : [[attribute.Name, value] as const];
    }),
  );

export const UserProvider = () =>
  Provider.effect(
    User,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<UserProps, "username">,
      ) {
        return (
          props.username ?? (yield* createPhysicalName({ id, maxLength: 128 }))
        );
      });

      const getUser = Effect.fn(function* (
        userPoolId: string,
        username: string,
      ) {
        return yield* cip
          .adminGetUser({ UserPoolId: userPoolId, Username: username })
          .pipe(
            Effect.catchTag(
              ["UserNotFoundException", "ResourceNotFoundException"],
              () => Effect.succeed(undefined),
            ),
          );
      });

      const attributesOf = (
        username: string,
        userPoolId: string,
        observed: cip.AdminGetUserResponse,
      ) => ({
        username,
        userPoolId,
        sub: attributeRecordOf(observed.UserAttributes).sub ?? "",
        userStatus: observed.UserStatus ?? "UNKNOWN",
      });

      return User.Provider.of({
        stables: ["username", "userPoolId", "sub"],

        // Sub-resource keyed entirely by its user pool (userPoolId) with no
        // global enumeration API of its own — nuke reaches it through the
        // parent's deletion, so enumeration returns empty per the
        // ProviderService doctrine.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ id, olds, output }) {
          const userPoolId = output?.userPoolId ?? olds?.userPoolId;
          if (userPoolId === undefined) return undefined;
          const username =
            output?.username ?? (yield* createName(id, olds ?? {}));
          const observed = yield* getUser(userPoolId, username);
          return observed === undefined
            ? undefined
            : attributesOf(username, userPoolId, observed);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          if (oldName !== newName || olds?.userPoolId !== news?.userPoolId) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
          const username = output?.username ?? (yield* createName(id, news));
          const userPoolId = news.userPoolId;
          const desiredAttributes = news.attributes ?? {};

          // 1. OBSERVE — cloud state is authoritative.
          let observed = yield* getUser(userPoolId, username);

          // 2. ENSURE — create when missing (invitation always suppressed);
          //    tolerate the create race.
          if (observed === undefined) {
            yield* cip
              .adminCreateUser({
                UserPoolId: userPoolId,
                Username: username,
                MessageAction: "SUPPRESS",
                UserAttributes: Object.entries(desiredAttributes).map(
                  ([Name, Value]) => ({ Name, Value }),
                ),
              })
              .pipe(
                Effect.catchTag("UsernameExistsException", () => Effect.void),
              );
            observed = yield* getUser(userPoolId, username);
          } else {
            // 3. SYNC ATTRIBUTES — upsert declared attributes that drifted
            //    from the OBSERVED values; delete attributes that were
            //    previously declared but no longer are (`olds` is only the
            //    hint for which attributes we manage — never for values).
            const observedAttributes = attributeRecordOf(
              observed.UserAttributes,
            );
            const upsert = Object.entries(desiredAttributes).filter(
              ([name, value]) => observedAttributes[name] !== value,
            );
            if (upsert.length > 0) {
              yield* cip.adminUpdateUserAttributes({
                UserPoolId: userPoolId,
                Username: username,
                UserAttributes: upsert.map(([Name, Value]) => ({
                  Name,
                  Value,
                })),
              });
            }
            const removed = Object.keys(olds?.attributes ?? {}).filter(
              (name) =>
                desiredAttributes[name] === undefined &&
                observedAttributes[name] !== undefined,
            );
            if (removed.length > 0) {
              yield* cip.adminDeleteUserAttributes({
                UserPoolId: userPoolId,
                Username: username,
                UserAttributeNames: removed,
              });
            }
          }

          if (observed === undefined) {
            return yield* Effect.die(
              `Cognito user ${username} not observable after create`,
            );
          }

          // 3b. SYNC PASSWORD — a permanent password confirms the account.
          //    Passwords are write-only, so `olds` is the only drift signal;
          //    fresh creates and adoptions always apply it.
          if (
            news.password !== undefined &&
            (output === undefined ||
              olds === undefined ||
              plain(olds.password) !== plain(news.password))
          ) {
            yield* cip.adminSetUserPassword({
              UserPoolId: userPoolId,
              Username: username,
              Password: news.password,
              Permanent: true,
            });
          }

          // 3c. SYNC ENABLED — diff against the OBSERVED flag.
          const desiredEnabled = news.enabled ?? true;
          if ((observed.Enabled ?? true) !== desiredEnabled) {
            yield* desiredEnabled
              ? cip.adminEnableUser({
                  UserPoolId: userPoolId,
                  Username: username,
                })
              : cip.adminDisableUser({
                  UserPoolId: userPoolId,
                  Username: username,
                });
          }

          // 4. RETURN fresh attributes (status/attributes may have changed
          //    during sync).
          const final = (yield* getUser(userPoolId, username)) ?? observed;
          yield* session.note(username);
          return attributesOf(username, userPoolId, final);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* cip
            .adminDeleteUser({
              UserPoolId: output.userPoolId,
              Username: output.username,
            })
            .pipe(
              Effect.catchTag(
                ["UserNotFoundException", "ResourceNotFoundException"],
                () => Effect.void,
              ),
            );
        }),
      });
    }),
  );
