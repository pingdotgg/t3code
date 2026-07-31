import * as shield from "@distilled.cloud/aws/shield";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  tagRecord,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

/** How Shield Advanced aggregates traffic across a protection group. */
export type ProtectionGroupAggregation = "SUM" | "MEAN" | "MAX";

/** Which protected resources are members of the group. */
export type ProtectionGroupPattern = "ALL" | "ARBITRARY" | "BY_RESOURCE_TYPE";

/** Resource type selector for `BY_RESOURCE_TYPE` groups. */
export type ProtectedResourceType =
  | "CLOUDFRONT_DISTRIBUTION"
  | "ROUTE_53_HOSTED_ZONE"
  | "ELASTIC_IP_ALLOCATION"
  | "CLASSIC_LOAD_BALANCER"
  | "APPLICATION_LOAD_BALANCER"
  | "GLOBAL_ACCELERATOR";

export interface ProtectionGroupProps {
  /**
   * Identifier of the protection group (alphanumeric and `-`, max 36 chars).
   * Immutable — changing it replaces the group. If omitted, a unique id is
   * generated.
   */
  protectionGroupId?: string;
  /**
   * How Shield Advanced aggregates traffic across the group: `SUM` for
   * combined volume, `MEAN` for per-resource average, `MAX` for the highest
   * single-resource volume. Mutable.
   */
  aggregation: ProtectionGroupAggregation;
  /**
   * Which protected resources are members: `ALL` protected resources,
   * an `ARBITRARY` list (set `members`), or all of one `BY_RESOURCE_TYPE`
   * (set `resourceType`). Mutable.
   */
  pattern: ProtectionGroupPattern;
  /**
   * Resource type included in the group. Required when `pattern` is
   * `BY_RESOURCE_TYPE`; omit otherwise.
   */
  resourceType?: ProtectedResourceType;
  /**
   * ARNs of the protected resources in the group. Required when `pattern` is
   * `ARBITRARY`; omit otherwise.
   */
  members?: string[];
  /**
   * User-defined tags. Alchemy ownership tags are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ProtectionGroup extends Resource<
  "AWS.Shield.ProtectionGroup",
  ProtectionGroupProps,
  {
    /** Identifier of the protection group. */
    protectionGroupId: string;
    /** ARN of the protection group. */
    protectionGroupArn: string;
    /** Traffic aggregation mode. */
    aggregation: string;
    /** Membership pattern. */
    pattern: string;
    /** Resource type for `BY_RESOURCE_TYPE` groups. */
    resourceType: string | undefined;
    /** Member resource ARNs for `ARBITRARY` groups. */
    members: string[];
    /** Tags on the protection group (including Alchemy ownership tags). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS Shield Advanced Protection Group — a collective of protected
 * resources whose traffic Shield Advanced monitors as a unit, improving
 * detection accuracy and reducing false positives.
 *
 * Requires an active Shield Advanced subscription ($3,000/month with a 1-year
 * commitment); without one every call fails with the typed
 * `SubscriptionNotFound` error.
 *
 * @section Grouping Protections
 * @example Group All Protected Resources
 * ```typescript
 * const group = yield* Shield.ProtectionGroup("AllResources", {
 *   aggregation: "SUM",
 *   pattern: "ALL",
 * });
 * ```
 *
 * @example Group by Resource Type
 * ```typescript
 * const group = yield* Shield.ProtectionGroup("Distributions", {
 *   aggregation: "MAX",
 *   pattern: "BY_RESOURCE_TYPE",
 *   resourceType: "CLOUDFRONT_DISTRIBUTION",
 * });
 * ```
 *
 * @example Arbitrary Member List
 * ```typescript
 * const group = yield* Shield.ProtectionGroup("Fleet", {
 *   aggregation: "MEAN",
 *   pattern: "ARBITRARY",
 *   members: [distribution.distributionArn],
 *   tags: { team: "platform" },
 * });
 * ```
 */
export const ProtectionGroup = Resource<ProtectionGroup>(
  "AWS.Shield.ProtectionGroup",
);

const observeGroup = (protectionGroupId: string) =>
  shield.describeProtectionGroup({ ProtectionGroupId: protectionGroupId }).pipe(
    Effect.map((r) => r.ProtectionGroup),
    Effect.catchTag(["ResourceNotFoundException", "SubscriptionNotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

const toTagRecord = (tags: shield.Tag[] | undefined): Record<string, string> =>
  tagRecord(
    (tags ?? []).flatMap((t) =>
      t.Key !== undefined && t.Value !== undefined
        ? [{ Key: t.Key, Value: t.Value }]
        : [],
    ),
  );

const readGroupTags = (protectionGroupArn: string) =>
  shield.listTagsForResource({ ResourceARN: protectionGroupArn }).pipe(
    Effect.map((r) => toTagRecord(r.Tags)),
    Effect.catch(() => Effect.succeed<Record<string, string>>({})),
  );

const buildAttrs = (
  group: shield.ProtectionGroup,
  tags: Record<string, string>,
) => ({
  protectionGroupId: group.ProtectionGroupId,
  protectionGroupArn: group.ProtectionGroupArn!,
  aggregation: group.Aggregation,
  pattern: group.Pattern,
  resourceType: group.ResourceType,
  members: [...group.Members],
  tags,
});

const sameMembers = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

export const ProtectionGroupProvider = () =>
  Provider.effect(
    ProtectionGroup,
    Effect.gen(function* () {
      const toGroupId = (id: string, props: { protectionGroupId?: string }) =>
        props.protectionGroupId
          ? Effect.succeed(props.protectionGroupId)
          : createPhysicalName({ id, maxLength: 36 });

      const syncTags = Effect.fn(function* (
        protectionGroupArn: string,
        desiredTags: Record<string, string>,
      ) {
        const observedTags = yield* readGroupTags(protectionGroupArn);
        const { upsert, removed } = diffTags(observedTags, desiredTags);
        if (upsert.length > 0) {
          yield* shield.tagResource({
            ResourceARN: protectionGroupArn,
            Tags: upsert,
          });
        }
        if (removed.length > 0) {
          yield* shield.untagResource({
            ResourceARN: protectionGroupArn,
            TagKeys: removed,
          });
        }
      });

      return {
        stables: ["protectionGroupId", "protectionGroupArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          if ((yield* toGroupId(id, olds)) !== (yield* toGroupId(id, news))) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const groupId =
            output?.protectionGroupId ?? (yield* toGroupId(id, olds ?? {}));
          const group = yield* observeGroup(groupId);
          if (!group?.ProtectionGroupArn) return undefined;
          const tags = yield* readGroupTags(group.ProtectionGroupArn);
          const attrs = buildAttrs(group, tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, session }) {
          const groupId = yield* toGroupId(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative.
          let group = yield* observeGroup(groupId);

          // 2. ENSURE — create if missing; tolerate the AlreadyExists race.
          if (!group) {
            yield* shield
              .createProtectionGroup({
                ProtectionGroupId: groupId,
                Aggregation: news.aggregation,
                Pattern: news.pattern,
                ResourceType: news.resourceType,
                Members: news.members,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag(
                  "ResourceAlreadyExistsException",
                  () => Effect.void,
                ),
              );
            group = yield* observeGroup(groupId);
            if (!group?.ProtectionGroupArn) {
              return yield* Effect.fail(
                new Error(
                  `Failed to create or read Shield protection group ${groupId}`,
                ),
              );
            }
          } else {
            // 3. SYNC settings — diff observed against desired; update only
            //    on an actual delta.
            const changed =
              group.Aggregation !== news.aggregation ||
              group.Pattern !== news.pattern ||
              (group.ResourceType ?? undefined) !==
                (news.resourceType ?? undefined) ||
              !sameMembers(group.Members ?? [], news.members ?? []);
            if (changed) {
              yield* shield.updateProtectionGroup({
                ProtectionGroupId: groupId,
                Aggregation: news.aggregation,
                Pattern: news.pattern,
                ResourceType: news.resourceType,
                Members: news.members,
              });
              group = yield* observeGroup(groupId);
            }
          }

          // 3b. SYNC tags — diff against OBSERVED cloud tags.
          yield* syncTags(group!.ProtectionGroupArn!, desiredTags);

          // 4. RETURN fresh attributes.
          yield* session.note(group!.ProtectionGroupArn!);
          return buildAttrs(group!, desiredTags);
        }),

        // Enumerate every protection group in the account. Without a Shield
        // Advanced subscription the account cannot have any groups.
        list: () =>
          Effect.gen(function* () {
            const groups = yield* shield.listProtectionGroups.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap(
                  (page) => page.ProtectionGroups ?? [],
                ),
              ),
              Effect.catchTag("SubscriptionNotFound", () => Effect.succeed([])),
            );
            return yield* Effect.forEach(
              groups.filter((g) => g.ProtectionGroupArn != null),
              (group) =>
                Effect.gen(function* () {
                  const tags = yield* readGroupTags(group.ProtectionGroupArn!);
                  return buildAttrs(group, tags);
                }),
              { concurrency: 5 },
            );
          }),

        delete: Effect.fn(function* ({ output }) {
          yield* shield
            .deleteProtectionGroup({
              ProtectionGroupId: output.protectionGroupId,
            })
            .pipe(
              Effect.catchTag(
                ["ResourceNotFoundException", "SubscriptionNotFound"],
                () => Effect.void,
              ),
            );
        }),
      };
    }),
  );
