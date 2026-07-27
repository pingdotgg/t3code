import * as aoss from "@distilled.cloud/aws/opensearchserverless";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  recordToTagList,
  retryWhileConflict,
  tagsToRecord,
} from "./internal.ts";

export interface CollectionGroupCapacityLimits {
  /**
   * Maximum indexing capacity, in OpenSearch Compute Units (OCUs), shared by
   * the group's collections.
   */
  maxIndexingCapacityInOCU?: number;
  /**
   * Maximum search capacity, in OCUs, shared by the group's collections.
   */
  maxSearchCapacityInOCU?: number;
  /**
   * Minimum indexing capacity, in OCUs, reserved for the group.
   */
  minIndexingCapacityInOCU?: number;
  /**
   * Minimum search capacity, in OCUs, reserved for the group.
   */
  minSearchCapacityInOCU?: number;
}

export interface CollectionGroupProps {
  /**
   * Name of the collection group (3-32 characters, lowercase; must start with
   * a lowercase letter). Changing the name replaces the group.
   * @default a generated physical name
   */
  groupName?: string;
  /**
   * Whether collections in the group deploy redundant standby replicas. Set
   * at creation time; changing it replaces the group.
   * @default "ENABLED"
   */
  standbyReplicas?: "ENABLED" | "DISABLED";
  /**
   * A human-readable description of the collection group.
   */
  description?: string;
  /**
   * OCU capacity limits shared by the collections in the group.
   */
  capacityLimits?: CollectionGroupCapacityLimits;
  /**
   * Tags to apply to the collection group. Merged with the internal Alchemy
   * tags.
   */
  tags?: Record<string, string>;
}

export interface CollectionGroup extends Resource<
  "AWS.OpenSearchServerless.CollectionGroup",
  CollectionGroupProps,
  {
    /**
     * Unique identifier of the collection group.
     */
    collectionGroupId: string;
    /**
     * Name of the collection group.
     */
    collectionGroupName: string;
    /**
     * ARN of the collection group.
     */
    collectionGroupArn: string;
    /**
     * Whether standby replicas are enabled for the group's collections.
     */
    standbyReplicas?: string;
    /**
     * Number of collections currently in the group.
     */
    numberOfCollections?: number;
    /**
     * The capacity generation of the group.
     */
    generation?: string;
  },
  {},
  Providers
> {}

/**
 * An Amazon OpenSearch Serverless collection group. Collection groups manage
 * OpenSearch Compute Units (OCUs) at a group level — multiple collections
 * share the group's capacity limits instead of each collection scaling
 * independently.
 *
 * @resource
 * @section Creating Collection Groups
 * @example Capacity-Bounded Collection Group
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const group = yield* AWS.OpenSearchServerless.CollectionGroup("Group", {
 *   groupName: "analytics",
 *   standbyReplicas: "DISABLED",
 *   capacityLimits: {
 *     maxIndexingCapacityInOCU: 4,
 *     maxSearchCapacityInOCU: 4,
 *   },
 * });
 * ```
 */
export const CollectionGroup = Resource<CollectionGroup>(
  "AWS.OpenSearchServerless.CollectionGroup",
);

export const CollectionGroupProvider = () =>
  Provider.effect(
    CollectionGroup,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { groupName?: string | undefined },
      ) {
        return (
          props.groupName ??
          (yield* createPhysicalName({ id, maxLength: 32, lowercase: true }))
        );
      });

      const toAttributes = (detail: aoss.CollectionGroupDetail) => ({
        collectionGroupId: detail.id!,
        collectionGroupName: detail.name!,
        collectionGroupArn: detail.arn!,
        standbyReplicas: detail.standbyReplicas,
        numberOfCollections: detail.numberOfCollections,
        generation: detail.generation,
      });

      // batchGetCollectionGroup reports a missing group in
      // collectionGroupErrorDetails instead of failing.
      const observeByName = Effect.fn(function* (name: string) {
        const response = yield* aoss.batchGetCollectionGroup({
          names: [name],
        });
        return response.collectionGroupDetails?.[0];
      });

      const capacityDrift = (
        desired: CollectionGroupCapacityLimits | undefined,
        observed: aoss.CollectionGroupCapacityLimits | undefined,
      ): boolean =>
        desired !== undefined &&
        (desired.maxIndexingCapacityInOCU !==
          observed?.maxIndexingCapacityInOCU ||
          desired.maxSearchCapacityInOCU !== observed?.maxSearchCapacityInOCU ||
          desired.minIndexingCapacityInOCU !==
            observed?.minIndexingCapacityInOCU ||
          desired.minSearchCapacityInOCU !== observed?.minSearchCapacityInOCU);

      // batchGetCollectionGroup does not return the group's tags — read them
      // via listTagsForResource (the authoritative tag store).
      const observeTags = Effect.fn(function* (arn: string) {
        return yield* aoss
          .listTagsForResource({ resourceArn: arn })
          .pipe(Effect.map((r) => tagsToRecord(r.tags)));
      });

      const syncTags = Effect.fn(function* (
        arn: string,
        observed: Record<string, string>,
        desired: Record<string, string>,
      ) {
        const { upsert, removed } = diffTags(observed, desired);
        if (upsert.length > 0) {
          yield* aoss.tagResource({
            resourceArn: arn,
            tags: recordToTagList(
              Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            ),
          });
        }
        if (removed.length > 0) {
          yield* aoss.untagResource({ resourceArn: arn, tagKeys: removed });
        }
      });

      return CollectionGroup.Provider.of({
        stables: [
          "collectionGroupId",
          "collectionGroupName",
          "collectionGroupArn",
        ],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* aoss.listCollectionGroups
              .pages({})
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.collectionGroupSummaries ?? [])
              .filter(
                (s) =>
                  s.id !== undefined &&
                  s.name !== undefined &&
                  s.arn !== undefined,
              )
              .map((s) => ({
                collectionGroupId: s.id!,
                collectionGroupName: s.name!,
                collectionGroupArn: s.arn!,
                generation: s.generation,
              }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.collectionGroupName ?? (yield* createName(id, olds ?? {}));
          const detail = yield* observeByName(name);
          if (detail?.id === undefined || detail.arn === undefined) {
            return undefined;
          }
          const attrs = toAttributes(detail);
          const tags = yield* observeTags(detail.arn).pipe(
            Effect.catch(() => Effect.succeed({})),
          );
          return (yield* hasAlchemyTags(
            id,
            Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
          ))
            ? attrs
            : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          if (
            olds.standbyReplicas !== undefined &&
            news.standbyReplicas !== undefined &&
            olds.standbyReplicas !== news.standbyReplicas
          ) {
            return { action: "replace" } as const;
          }
          // description/capacityLimits/tags fall through to update
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name =
            output?.collectionGroupName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative
          let detail = yield* observeByName(name);

          // 2. ENSURE — create if missing; tolerate a concurrent create race
          if (detail === undefined) {
            const created = yield* aoss
              .createCollectionGroup({
                name,
                standbyReplicas: news.standbyReplicas ?? "ENABLED",
                description: news.description,
                capacityLimits: news.capacityLimits,
                tags: recordToTagList(desiredTags),
              })
              .pipe(
                Effect.map((r) => r.createCollectionGroupDetail),
                Effect.catchTag("ConflictException", () =>
                  Effect.succeed(undefined),
                ),
              );
            detail =
              created !== undefined
                ? { ...created }
                : yield* observeByName(name);
          } else {
            // 3. SYNC — description/capacityLimits when observed drifts
            const descriptionDrift =
              news.description !== undefined &&
              news.description !== detail.description;
            const limitsDrift = capacityDrift(
              news.capacityLimits,
              detail.capacityLimits,
            );
            if (descriptionDrift || limitsDrift) {
              yield* aoss.updateCollectionGroup({
                id: detail.id!,
                description: descriptionDrift ? news.description : undefined,
                capacityLimits: limitsDrift ? news.capacityLimits : undefined,
              });
            }
          }

          if (detail?.id === undefined || detail.arn === undefined) {
            return yield* Effect.fail(
              new aoss.ResourceNotFoundException({
                message: `collection group ${name} not visible after reconcile`,
              }),
            );
          }

          // 3b. SYNC TAGS — diff against observed cloud tags (read via
          // listTagsForResource on every path: adoption may bring foreign
          // tags, and a create race may have dropped ours).
          yield* syncTags(
            detail.arn,
            yield* observeTags(detail.arn),
            desiredTags,
          );

          yield* session.note(detail.id);
          return toAttributes(detail);
        }),

        delete: Effect.fn(function* ({ output }) {
          // A group with collections still in it (or tearing down) surfaces
          // ConflictException — retry through the teardown window.
          yield* retryWhileConflict(
            aoss.deleteCollectionGroup({ id: output.collectionGroupId }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      });
    }),
  );
