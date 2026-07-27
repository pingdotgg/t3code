import * as memorydb from "@distilled.cloud/aws/memorydb";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readMemoryDbTags } from "./internal.ts";

/**
 * Authentication mode for a MemoryDB user.
 */
export interface UserAuthenticationMode {
  /**
   * How the user authenticates:
   * - `"password"` — one or two SHA-256 passwords (supplied in `passwords`).
   * - `"iam"` — IAM authentication; the username must match the IAM identity.
   * - `"no-password"` — the user has no password (typically the default user).
   */
  type: "password" | "iam" | "no-password";
  /**
   * One or two passwords (16-128 printable characters each). Required when
   * `type` is `"password"`. Passwords are write-only — the API never returns
   * them, so changes to `passwords` alone are not auto-detected on update;
   * change `type` (or replace the user) to force a credential reset.
   */
  passwords?: Redacted.Redacted<string>[];
}

export interface UserProps {
  /**
   * Name of the user. Must be 1-40 alphanumeric characters. If omitted, a
   * deterministic physical name is generated. Changing the name replaces the
   * user.
   */
  userName?: string;
  /**
   * How the user authenticates.
   */
  authenticationMode: UserAuthenticationMode;
  /**
   * Redis ACL access string describing the user's permissions, e.g.
   * `"on ~* +@all"`. See the MemoryDB / Redis ACL documentation.
   */
  accessString: string;
  /**
   * User-defined tags for the user.
   */
  tags?: Record<string, string>;
}

export interface User extends Resource<
  "AWS.MemoryDB.User",
  UserProps,
  {
    /** Name of the user. */
    userName: string;
    /** ARN of the user. */
    userArn: string;
    /** Current lifecycle status (e.g. `active`, `modifying`). */
    status: string;
    /** Access string defining the user's permissions. */
    accessString: string | undefined;
    /** How the user authenticates (`password` or `iam`). */
    authenticationType: string | undefined;
    /** Minimum engine version the user is compatible with. */
    minimumEngineVersion: string | undefined;
    /** Tags on the user (user + internal Alchemy tags). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A MemoryDB user — an RBAC identity that authenticates to a cluster and is
 * granted permissions through an access string. Users are grouped into
 * {@link ACL}s, which are attached to clusters.
 *
 * Users are free and provision quickly. Passwords are write-only.
 * @resource
 * @section Creating a User
 * @example Password User with Full Access
 * ```typescript
 * const user = yield* User("AppUser", {
 *   authenticationMode: { type: "password", passwords: [appPassword] },
 *   accessString: "on ~* +@all",
 * });
 * ```
 *
 * @example IAM-Authenticated User
 * ```typescript
 * const user = yield* User("IamUser", {
 *   userName: "iam-app-user",
 *   authenticationMode: { type: "iam" },
 *   accessString: "on ~* +@all",
 * });
 * ```
 */
export const User = Resource<User>("AWS.MemoryDB.User");

export const UserProvider = () =>
  Provider.effect(
    User,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<UserProps>) =>
        props.userName
          ? Effect.succeed(props.userName)
          : createPhysicalName({ id, maxLength: 40, lowercase: true });

      const readUser = Effect.fn(function* (name: string) {
        const response = yield* memorydb
          .describeUsers({ UserName: name })
          .pipe(
            Effect.catchTag("UserNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.Users?.[0];
      });

      // Wait for the user to leave a transitional (modifying) state so a
      // subsequent modify/delete does not hit InvalidUserStateFault.
      const waitUntilActive = Effect.fn(function* (name: string) {
        return yield* readUser(name).pipe(
          Effect.flatMap((user) => {
            if (user !== undefined && user.Status === "modifying") {
              return Effect.fail(
                new Error(`User '${name}' still modifying (${user.Status})`),
              );
            }
            return Effect.succeed(user);
          }),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.fixed("5 seconds"),
              Schedule.recurs(24),
            ]),
          }),
        );
      });

      const toAttrs = Effect.fn(function* (user: memorydb.User) {
        if (!user.Name || !user.ARN) {
          return yield* Effect.fail(
            new Error(`User '${user.Name}' is missing its ARN`),
          );
        }
        return {
          userName: user.Name,
          userArn: user.ARN,
          status: user.Status ?? "active",
          accessString: user.AccessString,
          authenticationType: user.Authentication?.Type,
          minimumEngineVersion: user.MinimumEngineVersion,
          tags: yield* readMemoryDbTags(user.ARN),
        };
      });

      // Distilled types `Passwords` as sensitive — pass the Redacted values
      // through as-is so they stay redacted in traces and logs.
      const toWireAuth = (
        mode: UserAuthenticationMode,
      ): memorydb.AuthenticationMode => ({
        Type: mode.type,
        ...(mode.passwords ? { Passwords: mode.passwords } : {}),
      });

      return {
        stables: ["userName", "userArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.userName ?? (yield* toName(id, olds ?? {}));
          const user = yield* readUser(name);
          if (!user?.ARN) return undefined;
          const attrs = yield* toAttrs(user);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news!;
          const name = output?.userName ?? (yield* toName(id, props));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...props.tags };

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readUser(name);

          // 2. Ensure — create if missing; tolerate AlreadyExists as a race.
          if (observed === undefined) {
            yield* memorydb
              .createUser({
                UserName: name,
                AuthenticationMode: toWireAuth(props.authenticationMode),
                AccessString: props.accessString,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag("UserAlreadyExistsFault", () => Effect.void),
                Effect.catchTag("DuplicateUserNameFault", () => Effect.void),
              );
            observed = yield* waitUntilActive(name);
          }
          if (observed === undefined) {
            return yield* Effect.fail(
              new Error(`User '${name}' not found after create`),
            );
          }

          // 3. Sync — access string is observable; auth passwords are not, so
          // only re-apply the auth mode when its observable TYPE changed.
          const update: memorydb.UpdateUserRequest = { UserName: name };
          let mutated = false;
          if (props.accessString !== observed.AccessString) {
            update.AccessString = props.accessString;
            mutated = true;
          }
          if (props.authenticationMode.type !== observed.Authentication?.Type) {
            update.AuthenticationMode = toWireAuth(props.authenticationMode);
            mutated = true;
          }
          if (mutated) {
            yield* memorydb.updateUser(update);
            observed = (yield* waitUntilActive(name)) ?? observed;
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          const arn = observed.ARN;
          if (arn) {
            const observedTags = yield* readMemoryDbTags(arn);
            const { removed, upsert } = diffTags(observedTags, desiredTags);
            if (upsert.length > 0) {
              yield* memorydb.tagResource({ ResourceArn: arn, Tags: upsert });
            }
            if (removed.length > 0) {
              yield* memorydb.untagResource({
                ResourceArn: arn,
                TagKeys: removed,
              });
            }
          }

          yield* session.note(name);
          return yield* toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          const name = output.userName;
          // A user mid-modify rejects deletion — settle first (bounded), then
          // delete. NotFound is success (idempotent delete).
          yield* waitUntilActive(name).pipe(Effect.catch(() => Effect.void));
          yield* memorydb.deleteUser({ UserName: name }).pipe(
            Effect.catchTag("UserNotFoundFault", () => Effect.void),
            Effect.retry({
              while: (e) => e._tag === "InvalidUserStateFault",
              schedule: Schedule.max([
                Schedule.fixed("5 seconds"),
                Schedule.recurs(12),
              ]),
            }),
          );
        }),

        list: () =>
          memorydb.describeUsers.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.Users ?? []).filter(
                  (user) =>
                    user.Name !== undefined &&
                    user.ARN !== undefined &&
                    // `default` is the AWS-managed default user that always
                    // exists and can never be deleted — keep it out of
                    // enumeration for account-wide teardown (nuke).
                    user.Name !== "default",
                ),
              ),
            ),
            Effect.flatMap(
              Effect.forEach((user) => toAttrs(user), { concurrency: 4 }),
            ),
          ),
      };
    }),
  );
