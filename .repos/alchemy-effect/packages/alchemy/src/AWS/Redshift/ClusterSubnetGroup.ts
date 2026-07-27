import * as redshift from "@distilled.cloud/aws/redshift";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { SubnetId } from "../EC2/Subnet.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  applyRedshiftTagDelta,
  redshiftArn,
  sameStringSet,
  toTagRecord,
} from "./internal.ts";

export interface ClusterSubnetGroupProps {
  /**
   * Name of the cluster subnet group. Must contain no more than 255
   * lowercase alphanumeric characters or hyphens and must not be `default`.
   * If omitted, a deterministic physical name is generated. Changing the
   * name replaces the subnet group.
   */
  clusterSubnetGroupName?: string;
  /**
   * Human-readable description of the subnet group.
   * @default "Managed by Alchemy"
   */
  description?: string;
  /**
   * VPC subnet IDs the subnet group spans. Redshift places cluster nodes
   * into these subnets; span at least two Availability Zones so the cluster
   * can relocate during maintenance.
   */
  subnetIds: SubnetId[];
  /**
   * User-defined tags for the subnet group.
   */
  tags?: Record<string, string>;
}

export interface ClusterSubnetGroup extends Resource<
  "AWS.Redshift.ClusterSubnetGroup",
  ClusterSubnetGroupProps,
  {
    /**
     * Name of the subnet group.
     */
    clusterSubnetGroupName: string;
    /**
     * ARN of the subnet group.
     */
    clusterSubnetGroupArn: string;
    /**
     * Description of the subnet group.
     */
    description: string | undefined;
    /**
     * ID of the VPC the subnets belong to.
     */
    vpcId: string | undefined;
    /**
     * IDs of the subnets in the group.
     */
    subnetIds: string[];
    /**
     * Status of the subnet group (e.g. `"Complete"`).
     */
    subnetGroupStatus: string | undefined;
    /**
     * Tags on the subnet group (including internal Alchemy tags).
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Redshift cluster subnet group — the set of VPC subnets a
 * provisioned Redshift cluster's nodes are placed into.
 *
 * Subnet groups are free and provision instantly. A {@link Cluster}
 * references one by name via `clusterSubnetGroupName`.
 * @resource
 * @section Creating a Cluster Subnet Group
 * @example Subnet Group Spanning Two Subnets
 * ```typescript
 * const subnetGroup = yield* Redshift.ClusterSubnetGroup("WarehouseSubnets", {
 *   description: "Subnets for the analytics warehouse",
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId],
 * });
 * ```
 * @example Tagged Subnet Group
 * ```typescript
 * const subnetGroup = yield* Redshift.ClusterSubnetGroup("WarehouseSubnets", {
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId],
 *   tags: { team: "analytics" },
 * });
 * ```
 */
export const ClusterSubnetGroup = Resource<ClusterSubnetGroup>(
  "AWS.Redshift.ClusterSubnetGroup",
);

/**
 * Retry an effect while the subnet group is still held by a cluster that is
 * mid-deletion (`InvalidClusterSubnetGroupStateFault`), bounded to ~10
 * minutes — a Redshift cluster releases its subnet group only once its own
 * deletion completes, several minutes after `deleteCluster` returns.
 *
 * Expressed as an explicitly-typed module-scope helper: inlining
 * `Effect.retry` in a lifecycle operation leaves `Retry.Return`'s
 * conditional type unresolved in the provider's inferred layer type, which
 * declaration emit widens to an `unknown` R — poisoning `AWS.providers()`
 * for every downstream consumer.
 */
const retryWhileSubnetGroupInUse = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "InvalidClusterSubnetGroupStateFault",
    schedule: Schedule.max([Schedule.fixed("15 seconds"), Schedule.recurs(40)]),
  });

export const ClusterSubnetGroupProvider = () =>
  Provider.effect(
    ClusterSubnetGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<ClusterSubnetGroupProps>) =>
        props.clusterSubnetGroupName
          ? Effect.succeed(props.clusterSubnetGroupName)
          : createPhysicalName({ id, maxLength: 255, lowercase: true });

      const readGroup = Effect.fn(function* (name: string) {
        const response = yield* redshift
          .describeClusterSubnetGroups({ ClusterSubnetGroupName: name })
          .pipe(
            Effect.catchTag("ClusterSubnetGroupNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.ClusterSubnetGroups?.[0];
      });

      const toAttrs = Effect.fn(function* (group: redshift.ClusterSubnetGroup) {
        const { accountId, region } = yield* AWSEnvironment.current;
        if (!group.ClusterSubnetGroupName) {
          return yield* Effect.fail(
            new Error("Cluster subnet group is missing its name"),
          );
        }
        return {
          clusterSubnetGroupName: group.ClusterSubnetGroupName,
          clusterSubnetGroupArn: redshiftArn(
            region,
            accountId,
            "subnetgroup",
            group.ClusterSubnetGroupName,
          ),
          description: group.Description,
          vpcId: group.VpcId,
          subnetIds: (group.Subnets ?? []).flatMap((subnet) =>
            subnet.SubnetIdentifier ? [subnet.SubnetIdentifier] : [],
          ),
          subnetGroupStatus: group.SubnetGroupStatus,
          tags: toTagRecord(group.Tags),
        };
      });

      return {
        stables: ["clusterSubnetGroupName", "clusterSubnetGroupArn", "vpcId"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.clusterSubnetGroupName ?? (yield* toName(id, olds ?? {}));
          const group = yield* readGroup(name);
          if (!group?.ClusterSubnetGroupName) return undefined;
          const attrs = yield* toAttrs(group);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name =
            output?.clusterSubnetGroupName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const description = news.description ?? "Managed by Alchemy";

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readGroup(name);

          // 2. Ensure — create if missing; tolerate AlreadyExists as a race
          //    with a peer reconciler by re-reading.
          if (!observed?.ClusterSubnetGroupName) {
            yield* redshift
              .createClusterSubnetGroup({
                ClusterSubnetGroupName: name,
                Description: description,
                SubnetIds: news.subnetIds,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag(
                  "ClusterSubnetGroupAlreadyExistsFault",
                  () => Effect.void,
                ),
              );
            observed = yield* readGroup(name);
            if (!observed?.ClusterSubnetGroupName) {
              return yield* Effect.fail(
                new Error(`Failed to create cluster subnet group '${name}'`),
              );
            }
          }

          // 3. Sync — diff OBSERVED description/subnets against desired;
          //    modifyClusterSubnetGroup replaces the whole subnet list.
          const observedSubnets = (observed.Subnets ?? []).flatMap((subnet) =>
            subnet.SubnetIdentifier ? [subnet.SubnetIdentifier] : [],
          );
          if (
            observed.Description !== description ||
            !sameStringSet(observedSubnets, news.subnetIds)
          ) {
            yield* redshift.modifyClusterSubnetGroup({
              ClusterSubnetGroupName: name,
              Description: description,
              SubnetIds: news.subnetIds,
            });
            observed = yield* readGroup(name);
            if (!observed?.ClusterSubnetGroupName) {
              return yield* Effect.fail(
                new Error(
                  `Cluster subnet group '${name}' not found after update`,
                ),
              );
            }
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags (describe
          //     surfaces them inline).
          const { accountId, region } = yield* AWSEnvironment.current;
          const arn = redshiftArn(region, accountId, "subnetgroup", name);
          const { removed, upsert } = diffTags(
            toTagRecord(observed.Tags),
            desiredTags,
          );
          yield* applyRedshiftTagDelta({ arn, upsert, removed });

          yield* session.note(arn);
          const attrs = yield* toAttrs(observed);
          return { ...attrs, tags: desiredTags };
        }),

        delete: Effect.fn(function* ({ output }) {
          // A cluster deleting out of this group holds it until the
          // cluster's own deletion completes — retry through that window.
          yield* retryWhileSubnetGroupInUse(
            redshift
              .deleteClusterSubnetGroup({
                ClusterSubnetGroupName: output.clusterSubnetGroupName,
              })
              .pipe(
                Effect.catchTag("ClusterSubnetGroupNotFoundFault", () =>
                  Effect.succeed(undefined),
                ),
              ),
          );
        }),

        list: () =>
          // Top-level account/region collection: exhaustively paginate
          // describeClusterSubnetGroups; tags come inline on each group.
          redshift.describeClusterSubnetGroups.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.ClusterSubnetGroups ?? []).filter(
                  (group) => group.ClusterSubnetGroupName !== undefined,
                ),
              ),
            ),
            Effect.flatMap(
              Effect.forEach((group) => toAttrs(group), { concurrency: 4 }),
            ),
          ),
      };
    }),
  );
