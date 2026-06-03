import * as identitystore from "@distilled.cloud/aws/identitystore";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  listGroups,
  resolveIdentityStoreId,
  retryIdentityCenter,
} from "./common.ts";

export interface GroupProps {
  /**
   * Explicit identity store ID.
   * If omitted, Alchemy resolves it from the selected Identity Center instance.
   */
  identityStoreId?: string;
  /**
   * Optional instance ARN used to discover the identity store ID.
   */
  instanceArn?: string;
  /**
   * Group display name.
   */
  displayName: string;
  /**
   * Optional group description.
   */
  description?: string;
}

export interface Group extends Resource<
  "AWS.IdentityCenter.Group",
  GroupProps,
  {
    identityStoreId: string;
    groupId: string;
    displayName: string | undefined;
    description: string | undefined;
    createdAt: Date | undefined;
    updatedAt: Date | undefined;
  },
  never,
  Providers
> {}

/**
 * A group in the IAM Identity Center identity store.
 *
 * @section Creating Groups
 * @example Platform Engineers
 * ```typescript
 * const engineers = yield* Group("PlatformEngineers", {
 *   displayName: "platform-engineers",
 *   description: "Platform engineering team",
 * });
 * ```
 */
export const Group = Resource<Group>("AWS.IdentityCenter.Group");

export const GroupProvider = () =>
  Provider.effect(
    Group,
    Effect.gen(function* () {
      return {
        stables: ["identityStoreId", "groupId"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (olds?.identityStoreId !== news.identityStoreId) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          if (output?.groupId && output.identityStoreId) {
            return yield* readGroupById(output.identityStoreId, output.groupId);
          }

          if (!olds) {
            return undefined;
          }

          return yield* readGroupByDisplayName(olds);
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          const identityStoreId =
            output?.identityStoreId ?? (yield* resolveIdentityStoreId(news));

          // Observe — find the group by id (if we already have one) or
          // by display name. We never trust `output.groupId` blindly: a
          // group deleted out of band shows up as missing here.
          let existing =
            (output?.groupId
              ? yield* readGroupById(identityStoreId, output.groupId)
              : undefined) ??
            (yield* readGroupByDisplayName({
              ...news,
              identityStoreId,
            }));

          // Ensure — create the group if missing.
          if (!existing) {
            const response = yield* retryIdentityCenter(
              identitystore.createGroup({
                IdentityStoreId: identityStoreId,
                DisplayName: news.displayName,
                Description: news.description,
              }),
            );

            existing =
              (response.GroupId
                ? yield* readGroupById(identityStoreId, response.GroupId)
                : undefined) ??
              (yield* readGroupByDisplayName({
                ...news,
                identityStoreId,
              }));

            if (!existing) {
              return yield* Effect.fail(
                new Error(`group '${news.displayName}' not found after create`),
              );
            }

            yield* session.note(existing.groupId);
            return existing;
          }

          // Sync mutable attributes — `updateGroup` overwrites
          // displayName and description in one call. We diff against
          // observed cloud state so adoption converges.
          const operations: {
            AttributePath: string;
            AttributeValue: string;
          }[] = [];
          if (existing.displayName !== news.displayName) {
            operations.push({
              AttributePath: "DisplayName",
              AttributeValue: news.displayName,
            });
          }
          const desiredDescription = news.description ?? "";
          if ((existing.description ?? "") !== desiredDescription) {
            operations.push({
              AttributePath: "Description",
              AttributeValue: desiredDescription,
            });
          }

          if (operations.length > 0) {
            yield* retryIdentityCenter(
              identitystore.updateGroup({
                IdentityStoreId: existing.identityStoreId,
                GroupId: existing.groupId,
                Operations: operations,
              }),
            );

            const updated = yield* readGroupById(
              existing.identityStoreId,
              existing.groupId,
            );
            if (!updated) {
              return yield* Effect.fail(
                new Error(`group '${existing.groupId}' not found after update`),
              );
            }
            yield* session.note(updated.groupId);
            return updated;
          }

          yield* session.note(existing.groupId);
          return existing;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryIdentityCenter(
            identitystore
              .deleteGroup({
                IdentityStoreId: output.identityStoreId,
                GroupId: output.groupId,
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              ),
          );
        }),
      };
    }),
  );

const readGroupById = Effect.fn(function* (
  identityStoreId: string,
  groupId: string,
) {
  const response = yield* retryIdentityCenter(
    identitystore
      .describeGroup({
        IdentityStoreId: identityStoreId,
        GroupId: groupId,
      })
      .pipe(
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed(undefined),
        ),
      ),
  );

  if (!response?.GroupId || !response.IdentityStoreId) {
    return undefined;
  }

  return {
    identityStoreId: response.IdentityStoreId,
    groupId: response.GroupId,
    displayName: response.DisplayName as string | undefined,
    description: response.Description as string | undefined,
    createdAt: response.CreatedAt,
    updatedAt: response.UpdatedAt,
  } satisfies Group["Attributes"];
});

const readGroupByDisplayName = Effect.fn(function* ({
  identityStoreId,
  instanceArn,
  displayName,
}: Pick<GroupProps, "identityStoreId" | "instanceArn" | "displayName">) {
  const resolvedIdentityStoreId = yield* resolveIdentityStoreId({
    identityStoreId,
    instanceArn,
  });
  const groups = yield* listGroups(resolvedIdentityStoreId);
  const match = groups.find((group) => group.DisplayName === displayName);
  return match?.GroupId
    ? yield* readGroupById(resolvedIdentityStoreId, match.GroupId)
    : undefined;
});
