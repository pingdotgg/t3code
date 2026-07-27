import * as synthetics from "@distilled.cloud/aws/synthetics";
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

export interface GroupProps {
  /**
   * Name of the group. Must match `^[0-9a-zA-Z_-]+$` and be at most 64
   * characters. Group names must be unique in the account (groups are
   * global resources visible from every Region).
   * @default ${app}-${id}-${stage}-${suffix}
   */
  groupName?: string;
  /**
   * ARNs of the canaries associated with this group (as many as 10). The
   * canaries must exist in the Region the group is managed from; membership
   * is converged on every deploy (canaries added here are associated,
   * canaries removed are disassociated).
   */
  members?: string[];
  /**
   * Tags to apply to the group. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Group extends Resource<
  "AWS.Synthetics.Group",
  GroupProps,
  {
    /**
     * Physical name of the group.
     */
    groupName: string;
    /**
     * ARN of the group. The ARN reflects the home Region the group was
     * created in, but the group itself is a global resource.
     */
    groupArn: string;
    /**
     * Service-assigned unique ID of the group.
     */
    groupId: string;
  },
  never,
  Providers
> {}

/**
 * A CloudWatch Synthetics group — associates canaries (including
 * cross-Region canaries) so you can view aggregated run results and manage
 * them as a unit. A group can hold as many as 10 canaries, and an account
 * can have as many as 20 groups.
 * @resource
 * @section Creating Groups
 * @example Group of Canaries
 * ```typescript
 * import * as Synthetics from "alchemy/AWS/Synthetics";
 *
 * const group = yield* Synthetics.Group("ApiCanaries", {
 *   members: [checkoutCanary.canaryArn, searchCanary.canaryArn],
 * });
 * ```
 *
 * @example Empty Group with Tags
 * ```typescript
 * const group = yield* Synthetics.Group("Fleet", {
 *   tags: { team: "platform" },
 * });
 * ```
 */
export const Group = Resource<Group>("AWS.Synthetics.Group");

export const GroupProvider = () =>
  Provider.effect(
    Group,
    Effect.gen(function* () {
      const createGroupName = Effect.fn(function* (
        id: string,
        props: { groupName?: string | undefined },
      ) {
        if (props.groupName) return props.groupName;
        return yield* createPhysicalName({ id, maxLength: 64 });
      });

      const getGroupOrUndefined = Effect.fn(function* (identifier: string) {
        return yield* synthetics.getGroup({ GroupIdentifier: identifier }).pipe(
          Effect.map((r) => r.Group),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      const listMembers = Effect.fn(function* (identifier: string) {
        const pages = yield* synthetics.listGroupResources
          .pages({ GroupIdentifier: identifier })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) => page.Resources ?? []);
      });

      const filterTags = (
        tags: { [key: string]: string | undefined } | undefined,
      ): Record<string, string> =>
        Object.fromEntries(
          Object.entries(tags ?? {}).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        );

      const toAttributes = (
        groupName: string,
        group: synthetics.Group,
      ): Group["Attributes"] => ({
        groupName,
        groupArn: group.Arn ?? "",
        groupId: group.Id ?? "",
      });

      return Group.Provider.of({
        stables: ["groupName", "groupArn", "groupId"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* synthetics.listGroups
              .pages({})
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.Groups ?? [])
              .filter((group) => group.Name !== undefined)
              .map((group) => ({
                groupName: group.Name!,
                groupArn: group.Arn ?? "",
                groupId: group.Id ?? "",
              }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const groupName =
            output?.groupName ?? (yield* createGroupName(id, olds ?? {}));
          const group = yield* getGroupOrUndefined(groupName);
          if (group === undefined) return undefined;
          const attrs = toAttributes(groupName, group);
          const tags = filterTags(group.Tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createGroupName(id, olds);
          const newName = yield* createGroupName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // members and tags converge through reconcile
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const groupName =
            output?.groupName ?? (yield* createGroupName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative.
          let observed = yield* getGroupOrUndefined(groupName);

          // 2. ENSURE — create if missing; tolerate a concurrent-create race.
          if (observed === undefined) {
            yield* synthetics
              .createGroup({ Name: groupName, Tags: desiredTags })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
            observed = yield* getGroupOrUndefined(groupName);
            yield* session.note(`created group ${groupName}`);
          }
          const groupArn = observed?.Arn ?? "";

          // 3. SYNC members — diff observed canary associations against the
          // desired members and apply only the delta. Association calls are
          // idempotent per (group, canary) pair.
          const observedMembers = yield* listMembers(groupName);
          const desiredMembers = news.members ?? [];
          const toAssociate = desiredMembers.filter(
            (arn) => !observedMembers.includes(arn),
          );
          const toDisassociate = observedMembers.filter(
            (arn) => !desiredMembers.includes(arn),
          );
          for (const ResourceArn of toAssociate) {
            yield* synthetics
              .associateResource({ GroupIdentifier: groupName, ResourceArn })
              .pipe(
                Effect.retry({
                  while: (e): boolean => e._tag === "ConflictException",
                  schedule: Schedule.max([
                    Schedule.fixed("2 seconds"),
                    Schedule.recurs(8),
                  ]),
                }),
              );
          }
          for (const ResourceArn of toDisassociate) {
            yield* synthetics
              .disassociateResource({
                GroupIdentifier: groupName,
                ResourceArn,
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
                Effect.retry({
                  while: (e): boolean => e._tag === "ConflictException",
                  schedule: Schedule.max([
                    Schedule.fixed("2 seconds"),
                    Schedule.recurs(8),
                  ]),
                }),
              );
          }
          if (toAssociate.length > 0 || toDisassociate.length > 0) {
            yield* session.note(
              `synced group ${groupName} members (+${toAssociate.length}/-${toDisassociate.length})`,
            );
          }

          // 4. SYNC tags — diff against OBSERVED cloud tags so adoption
          // converges (create already applied them).
          const currentTags = filterTags(observed?.Tags);
          const { upsert, removed } = diffTags(currentTags, desiredTags);
          if (upsert.length > 0) {
            yield* synthetics.tagResource({
              ResourceArn: groupArn,
              Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* synthetics.untagResource({
              ResourceArn: groupArn,
              TagKeys: removed,
            });
          }

          yield* session.note(groupName);
          return {
            groupName,
            groupArn,
            groupId: observed?.Id ?? "",
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // The group does not need to be emptied first — deleting a group
          // never deletes its canaries.
          yield* synthetics
            .deleteGroup({ GroupIdentifier: output.groupName })
            .pipe(
              Effect.retry({
                while: (e): boolean => e._tag === "ConflictException",
                schedule: Schedule.max([
                  Schedule.fixed("2 seconds"),
                  Schedule.recurs(8),
                ]),
              }),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
