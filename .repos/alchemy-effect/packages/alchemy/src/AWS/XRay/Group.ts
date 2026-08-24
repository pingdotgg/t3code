import * as xray from "@distilled.cloud/aws/xray";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface GroupProps {
  /**
   * Name of the group (1-32 characters). `Default` is reserved by X-Ray for
   * the built-in group that matches all traces.
   *
   * Changing the name replaces the group.
   * @default ${app}-${stage}-${id}
   */
  groupName?: string;
  /**
   * The filter expression defining the criteria by which traces belong to
   * the group, e.g. `service("my-api") AND responsetime > 2`.
   */
  filterExpression: string;
  /**
   * Whether to enable insights for the group. Insights detect anomalies in
   * the group's traces.
   * @default false
   */
  insightsEnabled?: boolean;
  /**
   * Whether insights should generate EventBridge notifications. Requires
   * `insightsEnabled: true`.
   * @default false
   */
  notificationsEnabled?: boolean;
  /**
   * Tags to apply to the group. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Group extends Resource<
  "AWS.XRay.Group",
  GroupProps,
  {
    /**
     * Name of the group.
     */
    groupName: string;
    /**
     * ARN of the group.
     */
    groupArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS X-Ray group that collects traces matching a filter expression, for
 * focused service maps, analytics, and insights.
 * @resource
 * @section Creating Groups
 * @example Group traces for one service
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * const group = yield* XRay.Group("ApiGroup", {
 *   filterExpression: 'service("my-api")',
 * });
 * ```
 *
 * @example Group slow requests with insights enabled
 * ```typescript
 * const group = yield* XRay.Group("SlowRequests", {
 *   filterExpression: "responsetime > 2",
 *   insightsEnabled: true,
 *   notificationsEnabled: true,
 * });
 * ```
 */
export const Group = Resource<Group>("AWS.XRay.Group");

/**
 * Raised when a `Group` is configured with the reserved group name
 * `Default`, which X-Ray uses for the built-in group matching all traces.
 */
export class XRayReservedGroupName extends Data.TaggedError(
  "XRayReservedGroupName",
)<{ message: string }> {}

const validateGroupName = (props: Pick<GroupProps, "groupName">) =>
  props.groupName === "Default"
    ? Effect.fail(
        new XRayReservedGroupName({
          message:
            '"Default" is reserved for the built-in X-Ray group — choose another groupName.',
        }),
      )
    : Effect.void;

export const GroupProvider = () =>
  Provider.effect(
    Group,
    Effect.gen(function* () {
      const createGroupName = Effect.fn(function* (
        id: string,
        props: Pick<GroupProps, "groupName">,
      ) {
        // X-Ray group names are limited to 32 characters.
        return (
          props.groupName ?? (yield* createPhysicalName({ id, maxLength: 32 }))
        );
      });

      const desiredInsights = (props: GroupProps) => ({
        InsightsEnabled: props.insightsEnabled ?? false,
        NotificationsEnabled: props.notificationsEnabled ?? false,
      });

      const observeGroup = (groupName: string) =>
        xray.getGroup({ GroupName: groupName }).pipe(
          Effect.map((r) => r.Group),
          // Typed synthetic tag for a missing group.
          Effect.catchTag("GroupNotFound", () => Effect.succeed(undefined)),
        );

      const observedTags = (groupArn: string) =>
        xray.listTagsForResource.items({ ResourceARN: groupArn }).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Object.fromEntries(Array.from(chunk).map((t) => [t.Key, t.Value])),
          ),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({} as Record<string, string>),
          ),
        );

      return Group.Provider.of({
        stables: ["groupName", "groupArn"],
        list: () =>
          Effect.gen(function* () {
            const groups = yield* xray.getGroups
              .items({})
              .pipe(Stream.runCollect);
            return Array.from(groups).flatMap((group) =>
              group.GroupName && group.GroupARN && group.GroupName !== "Default"
                ? [{ groupName: group.GroupName, groupArn: group.GroupARN }]
                : [],
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const groupName =
            output?.groupName ?? (yield* createGroupName(id, olds ?? {}));
          const found = yield* observeGroup(groupName);
          if (!found?.GroupARN) return undefined;
          const attrs = { groupName, groupArn: found.GroupARN };
          const tags = yield* observedTags(found.GroupARN);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          yield* validateGroupName(news ?? {});
          const oldName = yield* createGroupName(id, olds ?? {});
          const newName = yield* createGroupName(id, news ?? {});
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // fall through: engine default update logic for mutable fields
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          yield* validateGroupName(news);
          const groupName =
            output?.groupName ?? (yield* createGroupName(id, news));
          const insights = desiredInsights(news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative.
          let live = yield* observeGroup(groupName);

          // 2. ENSURE — create when missing; a concurrent create surfaces as
          //    the typed GroupAlreadyExists tag, which we treat as a race
          //    and re-observe.
          if (live === undefined) {
            live = yield* xray
              .createGroup({
                GroupName: groupName,
                FilterExpression: news.filterExpression,
                InsightsConfiguration: insights,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.map((r) => r.Group),
                Effect.catchTag("GroupAlreadyExists", () =>
                  observeGroup(groupName),
                ),
              );
          }

          // 3. SYNC — diff the OBSERVED filter expression and insights
          //    configuration against the desired state; update only on drift.
          const observedInsights = live?.InsightsConfiguration ?? {};
          const inSync =
            live !== undefined &&
            live.FilterExpression === news.filterExpression &&
            (observedInsights.InsightsEnabled ?? false) ===
              insights.InsightsEnabled &&
            (observedInsights.NotificationsEnabled ?? false) ===
              insights.NotificationsEnabled;
          if (!inSync) {
            live = yield* xray
              .updateGroup({
                GroupName: groupName,
                FilterExpression: news.filterExpression,
                InsightsConfiguration: insights,
              })
              .pipe(Effect.map((r) => r.Group));
          }

          const groupArn = live?.GroupARN ?? output?.groupArn;

          // 3b. SYNC TAGS — diff against OBSERVED cloud tags so adoption
          //     converges (create-time Tags only apply on first create).
          if (groupArn !== undefined) {
            const currentTags = yield* observedTags(groupArn);
            const { upsert, removed } = diffTags(currentTags, desiredTags);
            if (upsert.length > 0) {
              yield* xray.tagResource({ ResourceARN: groupArn, Tags: upsert });
            }
            if (removed.length > 0) {
              yield* xray.untagResource({
                ResourceARN: groupArn,
                TagKeys: removed,
              });
            }
          }

          yield* session.note(groupName);
          return { groupName, groupArn: groupArn! };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* xray.deleteGroup({ GroupName: output.groupName }).pipe(
            // Typed synthetic tag for a missing group — idempotent delete.
            Effect.catchTag("GroupNotFound", () => Effect.void),
          );
        }),
      });
    }),
  );
