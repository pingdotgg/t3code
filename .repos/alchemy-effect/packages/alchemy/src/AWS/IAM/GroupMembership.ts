import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface GroupMembershipProps {
  /**
   * Name of the IAM group to manage membership for.
   */
  groupName: Input<string>;
  /**
   * Exact set of user names that should be members of the group.
   */
  userNames: Input<string[]>;
}

export interface GroupMembership extends Resource<
  "AWS.IAM.GroupMembership",
  GroupMembershipProps,
  {
    /** The group whose membership is managed. */
    groupName: string;
    /** The user names currently in the group. */
    userNames: string[];
  },
  never,
  Providers
> {}

/**
 * An explicit IAM group membership resource that owns a group's managed users.
 *
 * `GroupMembership` models the exact set of users in a group, making membership
 * reconciliation explicit instead of spreading it across user or group resources.
 * @resource
 * @section Managing Group Membership
 * @example Sync a Group's Members
 * ```typescript
 * const admins = yield* Group("Admins", {
 *   groupName: "admins",
 * });
 *
 * const alice = yield* User("Alice", {
 *   userName: "alice",
 * });
 *
 * const bob = yield* User("Bob", {
 *   userName: "bob",
 * });
 *
 * const membership = yield* GroupMembership("AdminsMembership", {
 *   groupName: admins.groupName,
 *   userNames: [alice.userName, bob.userName],
 * });
 * ```
 */
export const GroupMembership = Resource<GroupMembership>(
  "AWS.IAM.GroupMembership",
);

export const GroupMembershipProvider = () =>
  Provider.succeed(GroupMembership, {
    stables: ["groupName"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      if (olds.groupName !== news.groupName) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output) {
        return undefined;
      }
      const response = yield* iam
        .getGroup({
          GroupName: output.groupName,
        })
        .pipe(
          Effect.catchTag("NoSuchEntityException", () =>
            Effect.succeed(undefined),
          ),
        );
      if (!response?.Group?.GroupName) {
        return undefined;
      }
      return {
        groupName: response.Group.GroupName,
        userNames: (response.Users ?? [])
          .map((user) => user.UserName)
          .filter(
            (userName): userName is string => typeof userName === "string",
          ),
      };
    }),
    reconcile: Effect.fn(function* ({ news, session }) {
      const groupName = news.groupName as string;
      const desiredUsers = news.userNames as string[];

      // Observe — read the actual membership of the group. `getGroup`
      // both confirms the group exists and returns the current user list
      // in a single call.
      const response = yield* iam
        .getGroup({ GroupName: groupName })
        .pipe(
          Effect.catchTag("NoSuchEntityException", () =>
            Effect.succeed(undefined),
          ),
        );
      const observedUsers = (response?.Users ?? [])
        .map((user) => user.UserName)
        .filter((userName): userName is string => typeof userName === "string");

      // Sync — diff observed against desired and apply only the delta.
      const observedSet = new Set(observedUsers);
      const desiredSet = new Set(desiredUsers);
      for (const userName of desiredUsers) {
        if (!observedSet.has(userName)) {
          yield* iam.addUserToGroup({
            GroupName: groupName,
            UserName: userName,
          });
        }
      }
      for (const userName of observedUsers) {
        if (!desiredSet.has(userName)) {
          yield* iam
            .removeUserFromGroup({
              GroupName: groupName,
              UserName: userName,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }
      }

      yield* session.note(groupName);
      return {
        groupName,
        userNames: desiredUsers,
      };
    }),
    list: Effect.fn(function* () {
      // The membership resource is keyed by groupName and its Attributes are
      // the full set of users in that group, so enumerate every IAM group
      // and read each group's user list — one item per group, matching the
      // shape `read` produces.
      const groups = yield* iam.listGroups.pages({}).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) => page.Groups ?? []),
        ),
      );
      const rows = yield* Effect.forEach(
        groups,
        (group) =>
          iam.getGroup.pages({ GroupName: group.GroupName }).pipe(
            Stream.runCollect,
            Effect.map((chunk) => ({
              groupName: group.GroupName,
              userNames: Array.from(chunk)
                .flatMap((page) => page.Users ?? [])
                .map((user) => user.UserName)
                .filter(
                  (userName): userName is string =>
                    typeof userName === "string",
                ),
            })),
            // The group may be deleted between listGroups and getGroup.
            Effect.catchTag("NoSuchEntityException", () =>
              Effect.succeed(undefined),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.filter(
        (row): row is { groupName: string; userNames: string[] } =>
          row !== undefined,
      );
    }),
    delete: Effect.fn(function* ({ output }) {
      for (const userName of output.userNames) {
        yield* iam
          .removeUserFromGroup({
            GroupName: output.groupName,
            UserName: userName,
          })
          .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
      }
    }),
  });
