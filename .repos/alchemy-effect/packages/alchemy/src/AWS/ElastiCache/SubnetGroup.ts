import * as elasticache from "@distilled.cloud/aws/elasticache";
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
import { readElastiCacheTags, sameStringSet, tagsToWire } from "./internal.ts";

export interface SubnetGroupProps {
  /** Name of the subnet group. Generated deterministically when omitted. */
  subnetGroupName?: string;
  /** Human-readable description. */
  description: string;
  /** VPC subnet IDs. Use at least two AZs for a highly-available cache. */
  subnetIds: string[];
  /** User-defined tags. */
  tags?: Record<string, string>;
}

export interface SubnetGroup extends Resource<
  "AWS.ElastiCache.SubnetGroup",
  SubnetGroupProps,
  {
    subnetGroupName: string;
    subnetGroupArn: string;
    description: string | undefined;
    vpcId: string | undefined;
    subnetIds: string[];
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A VPC subnet group for provisioned ElastiCache resources.
 *
 * ### Creating a Subnet Group
 * **Example:** Two Availability Zones
 * ```typescript
 * const subnets = yield* SubnetGroup("CacheSubnets", {
 *   description: "cache subnets",
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId],
 * });
 * ```
 *
 * @resource
 */
export const SubnetGroup = Resource<SubnetGroup>("AWS.ElastiCache.SubnetGroup");

export const SubnetGroupProvider = () =>
  Provider.effect(
    SubnetGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: SubnetGroupProps) =>
        props.subnetGroupName
          ? Effect.succeed(props.subnetGroupName)
          : createPhysicalName({ id, maxLength: 40, lowercase: true });
      const readGroup = Effect.fn(function* (name: string) {
        const response = yield* elasticache
          .describeCacheSubnetGroups({ CacheSubnetGroupName: name })
          .pipe(
            Effect.catchTag("CacheSubnetGroupNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.CacheSubnetGroups?.[0];
      });
      const attrs = Effect.fn(function* (group: elasticache.CacheSubnetGroup) {
        if (!group.CacheSubnetGroupName || !group.ARN) {
          return yield* Effect.fail(
            new Error("ElastiCache subnet group is missing its name or ARN"),
          );
        }
        return {
          subnetGroupName: group.CacheSubnetGroupName,
          subnetGroupArn: group.ARN,
          description: group.CacheSubnetGroupDescription,
          vpcId: group.VpcId,
          subnetIds: (group.Subnets ?? [])
            .map((subnet) => subnet.SubnetIdentifier)
            .filter((id): id is string => id !== undefined),
          tags: yield* readElastiCacheTags(group.ARN),
        };
      });

      return {
        stables: ["subnetGroupName", "subnetGroupArn"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? { description: "", subnetIds: [] })) !==
            (yield* toName(id, news ?? { description: "", subnetIds: [] }))
          )
            return { action: "replace" } as const;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const group = yield* readGroup(
            output?.subnetGroupName ??
              (yield* toName(id, olds ?? { description: "", subnetIds: [] })),
          );
          if (!group?.ARN) return undefined;
          const result = yield* attrs(group);
          return (yield* hasAlchemyTags(id, result.tags))
            ? result
            : Unowned(result);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news!;
          const name = output?.subnetGroupName ?? (yield* toName(id, props));
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...props.tags,
          };
          let group = yield* readGroup(name);
          if (!group) {
            yield* elasticache
              .createCacheSubnetGroup({
                CacheSubnetGroupName: name,
                CacheSubnetGroupDescription: props.description,
                SubnetIds: props.subnetIds,
                Tags: tagsToWire(desiredTags),
              })
              .pipe(
                Effect.catchTag(
                  "CacheSubnetGroupAlreadyExistsFault",
                  () => Effect.void,
                ),
              );
            group = yield* readGroup(name);
          }
          if (!group)
            return yield* Effect.fail(
              new Error(`Subnet group '${name}' not found after create`),
            );
          const observedSubnets = (group.Subnets ?? [])
            .map((subnet) => subnet.SubnetIdentifier)
            .filter((id): id is string => id !== undefined);
          if (
            group.CacheSubnetGroupDescription !== props.description ||
            !sameStringSet(observedSubnets, props.subnetIds)
          ) {
            group =
              (yield* elasticache.modifyCacheSubnetGroup({
                CacheSubnetGroupName: name,
                CacheSubnetGroupDescription: props.description,
                SubnetIds: props.subnetIds,
              })).CacheSubnetGroup ?? group;
          }
          if (group.ARN) {
            const { removed, upsert } = diffTags(
              yield* readElastiCacheTags(group.ARN),
              desiredTags,
            );
            if (upsert.length)
              yield* elasticache.addTagsToResource({
                ResourceName: group.ARN,
                Tags: upsert,
              });
            if (removed.length)
              yield* elasticache.removeTagsFromResource({
                ResourceName: group.ARN,
                TagKeys: removed,
              });
          }
          yield* session.note(name);
          return yield* attrs(group);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* elasticache
            .deleteCacheSubnetGroup({
              CacheSubnetGroupName: output.subnetGroupName,
            })
            .pipe(
              Effect.catchTag(
                "CacheSubnetGroupNotFoundFault",
                () => Effect.void,
              ),
              Effect.retry({
                while: (error) => error._tag === "CacheSubnetGroupInUse",
                schedule: Schedule.max([
                  Schedule.fixed("5 seconds"),
                  Schedule.recurs(8),
                ]),
              }),
            );
        }),
        list: () =>
          elasticache.describeCacheSubnetGroups.pages({}).pipe(
            Stream.runCollect,
            Effect.map((pages) =>
              Array.from(pages).flatMap((page) => page.CacheSubnetGroups ?? []),
            ),
            Effect.flatMap((groups) =>
              Effect.forEach(
                groups.filter((group) => group.ARN),
                attrs,
              ),
            ),
          ),
      };
    }),
  );
