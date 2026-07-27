import * as memorydb from "@distilled.cloud/aws/memorydb";
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
import { readMemoryDbTags } from "./internal.ts";

export interface ACLProps {
  /**
   * Name of the Access Control List. Must be 1-40 alphanumeric characters. If
   * omitted, a deterministic physical name is generated. Changing the name
   * replaces the ACL.
   */
  aclName?: string;
  /**
   * Names of the {@link User}s in this ACL. The account's built-in `default`
   * user belongs to the reserved `open-access` ACL and cannot be added to a
   * custom ACL — reference your own {@link User}s here instead.
   * @default [] (an empty ACL)
   */
  userNames?: string[];
  /**
   * User-defined tags for the ACL.
   */
  tags?: Record<string, string>;
}

export interface ACL extends Resource<
  "AWS.MemoryDB.ACL",
  ACLProps,
  {
    /** Name of the ACL. */
    aclName: string;
    /** ARN of the ACL. */
    aclArn: string;
    /** Current lifecycle status (e.g. `creating`, `active`). */
    status: string;
    /** Names of the users in the ACL. */
    userNames: string[];
    /** Minimum engine version the ACL is compatible with. */
    minimumEngineVersion: string | undefined;
    /** Tags on the ACL (user + internal Alchemy tags). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A MemoryDB Access Control List (ACL) — a named collection of {@link User}s
 * that a cluster authenticates against. Attach an ACL to a
 * {@link Cluster} via `aclName`.
 *
 * ACLs are free and provision quickly.
 * @resource
 * @section Creating an ACL
 * @example ACL with a Custom User
 * ```typescript
 * const appUser = yield* User("AppUser", {
 *   authenticationMode: { type: "password", passwords: [appPassword] },
 *   accessString: "on ~* +@all",
 * });
 * const acl = yield* ACL("AppAcl", {
 *   userNames: [appUser.userName],
 * });
 * ```
 */
export const ACL = Resource<ACL>("AWS.MemoryDB.ACL");

export const ACLProvider = () =>
  Provider.effect(
    ACL,
    Effect.gen(function* () {
      const toName = (id: string, props: ACLProps) =>
        props.aclName
          ? Effect.succeed(props.aclName)
          : createPhysicalName({ id, maxLength: 40, lowercase: true });

      const desiredUsers = (props: ACLProps): string[] => props.userNames ?? [];

      const readAcl = Effect.fn(function* (name: string) {
        const response = yield* memorydb
          .describeACLs({ ACLName: name })
          .pipe(
            Effect.catchTag("ACLNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.ACLs?.[0];
      });

      // Wait for the ACL to leave a transitional state before mutating or
      // deleting it (avoids InvalidACLStateFault).
      const waitUntilActive = Effect.fn(function* (name: string) {
        return yield* readAcl(name).pipe(
          Effect.flatMap((acl) => {
            if (
              acl !== undefined &&
              acl.Status !== "active" &&
              acl.Status !== undefined
            ) {
              return Effect.fail(
                new Error(`ACL '${name}' not active (${acl.Status})`),
              );
            }
            return Effect.succeed(acl);
          }),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.fixed("5 seconds"),
              Schedule.recurs(24),
            ]),
          }),
        );
      });

      const toAttrs = Effect.fn(function* (acl: memorydb.ACL) {
        if (!acl.Name || !acl.ARN) {
          return yield* Effect.fail(
            new Error(`ACL '${acl.Name}' is missing its ARN`),
          );
        }
        return {
          aclName: acl.Name,
          aclArn: acl.ARN,
          status: acl.Status ?? "active",
          userNames: [...(acl.UserNames ?? [])],
          minimumEngineVersion: acl.MinimumEngineVersion,
          tags: yield* readMemoryDbTags(acl.ARN),
        };
      });

      return {
        stables: ["aclName", "aclArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.aclName ?? (yield* toName(id, olds ?? {}));
          const acl = yield* readAcl(name);
          if (!acl?.ARN) return undefined;
          const attrs = yield* toAttrs(acl);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news ?? {};
          const name = output?.aclName ?? (yield* toName(id, props));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...props.tags };
          const desired = desiredUsers(props);

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readAcl(name);

          // 2. Ensure — create if missing; tolerate AlreadyExists as a race.
          if (observed === undefined) {
            yield* memorydb
              .createACL({
                ACLName: name,
                UserNames: desired,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag("ACLAlreadyExistsFault", () => Effect.void),
              );
            observed = yield* waitUntilActive(name);
          }
          if (observed === undefined) {
            return yield* Effect.fail(
              new Error(`ACL '${name}' not found after create`),
            );
          }

          // 3. Sync — compute the user membership delta from OBSERVED state.
          const observedUsers = new Set(observed.UserNames ?? []);
          const desiredSet = new Set(desired);
          const toAdd = desired.filter((u) => !observedUsers.has(u));
          const toRemove = [...observedUsers].filter((u) => !desiredSet.has(u));
          if (toAdd.length > 0 || toRemove.length > 0) {
            yield* memorydb.updateACL({
              ACLName: name,
              ...(toAdd.length > 0 ? { UserNamesToAdd: toAdd } : {}),
              ...(toRemove.length > 0 ? { UserNamesToRemove: toRemove } : {}),
            });
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
          const name = output.aclName;
          // The ACL must be detached from any cluster first; while it is still
          // in use (or mid-modify) deletion rejects with InvalidACLStateFault.
          // Retry bounded; NotFound is success.
          yield* waitUntilActive(name).pipe(Effect.catch(() => Effect.void));
          yield* memorydb.deleteACL({ ACLName: name }).pipe(
            Effect.catchTag("ACLNotFoundFault", () => Effect.void),
            Effect.retry({
              while: (e) => e._tag === "InvalidACLStateFault",
              schedule: Schedule.max([
                Schedule.fixed("5 seconds"),
                Schedule.recurs(12),
              ]),
            }),
          );
        }),

        list: () =>
          memorydb.describeACLs.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.ACLs ?? []).filter(
                  (acl) =>
                    acl.Name !== undefined &&
                    acl.ARN !== undefined &&
                    // `open-access` is the AWS-managed default ACL that
                    // always exists and can never be deleted — keep it out
                    // of enumeration for account-wide teardown (nuke).
                    acl.Name !== "open-access",
                ),
              ),
            ),
            Effect.flatMap(
              Effect.forEach((acl) => toAttrs(acl), { concurrency: 4 }),
            ),
          ),
      };
    }),
  );
