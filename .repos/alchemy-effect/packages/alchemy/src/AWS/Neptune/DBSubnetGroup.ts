import * as neptune from "@distilled.cloud/aws/neptune";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import type { SubnetId } from "../EC2/Subnet.ts";
import type { Providers } from "../Providers.ts";

export interface DBSubnetGroupProps {
  /**
   * Name of the DB subnet group. If omitted, a deterministic name is generated.
   */
  dbSubnetGroupName?: string;
  /**
   * Description for the subnet group.
   * @default "Managed by Alchemy"
   */
  description?: string;
  /**
   * Subnets the Neptune cluster may use. Must span at least two
   * Availability Zones.
   */
  subnetIds: SubnetId[];
  /**
   * User-defined tags for the subnet group.
   */
  tags?: Record<string, string>;
}

export interface DBSubnetGroup extends Resource<
  "AWS.Neptune.DBSubnetGroup",
  DBSubnetGroupProps,
  {
    /** Name of the subnet group. */
    dbSubnetGroupName: string;
    /** ARN of the subnet group. */
    dbSubnetGroupArn: string | undefined;
    /** ID of the VPC the subnets belong to. */
    vpcId: string | undefined;
    /** IDs of the subnets in the group. */
    subnetIds: string[];
    /** Status of the subnet group (e.g. `Complete`). */
    status: string | undefined;
    /** Tags on the subnet group (user + internal Alchemy tags). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Neptune DB subnet group — the set of VPC subnets a Neptune
 * cluster and its instances are placed into. Neptune is VPC-only, so a
 * subnet group spanning at least two Availability Zones is required before a
 * cluster can be created.
 * @resource
 * @section Creating a Subnet Group
 * @example Multi-AZ subnet group
 * ```typescript
 * const subnetGroup = yield* DBSubnetGroup("NeptuneSubnets", {
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId],
 * });
 * ```
 */
export const DBSubnetGroup = Resource<DBSubnetGroup>(
  "AWS.Neptune.DBSubnetGroup",
);

export const DBSubnetGroupProvider = () =>
  Provider.effect(
    DBSubnetGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: DBSubnetGroupProps) =>
        props.dbSubnetGroupName
          ? Effect.succeed(props.dbSubnetGroupName)
          : createPhysicalName({ id, maxLength: 255 });

      const readGroup = Effect.fn(function* (groupName: string) {
        const response = yield* neptune
          .describeDBSubnetGroups({
            DBSubnetGroupName: groupName,
          })
          .pipe(
            Effect.catchTag("DBSubnetGroupNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.DBSubnetGroups?.[0];
      });

      return {
        stables: ["dbSubnetGroupArn", "dbSubnetGroupName", "vpcId"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? { subnetIds: [] })) !==
            (yield* toName(id, news))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.dbSubnetGroupName ??
            (yield* toName(
              id,
              olds ?? ({ subnetIds: [] } as DBSubnetGroupProps),
            ));
          const group = yield* readGroup(name);
          if (!group?.DBSubnetGroupName) {
            return undefined;
          }

          return {
            dbSubnetGroupName: group.DBSubnetGroupName,
            dbSubnetGroupArn: group.DBSubnetGroupArn,
            vpcId: group.VpcId,
            subnetIds: (group.Subnets ?? []).flatMap((subnet) =>
              subnet.SubnetIdentifier ? [subnet.SubnetIdentifier] : [],
            ),
            status: group.SubnetGroupStatus,
            tags: output?.tags ?? {},
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const dbSubnetGroupName =
            output?.dbSubnetGroupName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — fetch live subnet-group state.
          let observed = yield* readGroup(dbSubnetGroupName);

          // Ensure — create if missing. Tolerate
          // `DBSubnetGroupAlreadyExistsFault` as a race with a peer
          // reconciler by re-reading.
          if (!observed?.DBSubnetGroupName) {
            yield* neptune
              .createDBSubnetGroup({
                DBSubnetGroupName: dbSubnetGroupName,
                DBSubnetGroupDescription:
                  news.description ?? "Managed by Alchemy",
                SubnetIds: news.subnetIds,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag(
                  "DBSubnetGroupAlreadyExistsFault",
                  () => Effect.void,
                ),
              );
            observed = yield* readGroup(dbSubnetGroupName);
            if (!observed?.DBSubnetGroupName) {
              return yield* Effect.fail(
                new Error(
                  `Failed to create DB subnet group '${dbSubnetGroupName}'`,
                ),
              );
            }
          } else {
            // Sync description and subnet membership — `modifyDBSubnetGroup`
            // accepts the full desired set and is idempotent for unchanged
            // input.
            yield* neptune.modifyDBSubnetGroup({
              DBSubnetGroupName: dbSubnetGroupName,
              DBSubnetGroupDescription:
                news.description ?? "Managed by Alchemy",
              SubnetIds: news.subnetIds,
            });
            observed = yield* readGroup(dbSubnetGroupName);
            if (!observed?.DBSubnetGroupName) {
              return yield* Effect.fail(
                new Error(
                  `DB subnet group '${dbSubnetGroupName}' not found after update`,
                ),
              );
            }
          }

          const dbSubnetGroupArn = observed.DBSubnetGroupArn;

          // Sync tags — diff prior recorded tags against desired (describe
          // does not surface tags inline).
          const observedTags = output?.tags ?? {};
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0 && dbSubnetGroupArn) {
            yield* neptune.addTagsToResource({
              ResourceName: dbSubnetGroupArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0 && dbSubnetGroupArn) {
            yield* neptune.removeTagsFromResource({
              ResourceName: dbSubnetGroupArn,
              TagKeys: removed,
            });
          }

          yield* session.note(dbSubnetGroupArn ?? dbSubnetGroupName);
          return {
            dbSubnetGroupName: observed.DBSubnetGroupName,
            dbSubnetGroupArn,
            vpcId: observed.VpcId,
            subnetIds: (observed.Subnets ?? []).flatMap((subnet) =>
              subnet.SubnetIdentifier ? [subnet.SubnetIdentifier] : [],
            ),
            status: observed.SubnetGroupStatus,
            tags: desiredTags,
          };
        }),
        list: () =>
          // AWS account/region collection: `describeDBSubnetGroups` is
          // paginated (items field `DBSubnetGroups`). Subnet groups are shared
          // across the RDS-family engines (RDS/DocumentDB/Neptune), so this
          // enumerates all of them — mirroring the DocDB provider. `read` does
          // not hydrate tags from the cloud (it returns the cached
          // `output.tags`), so we mirror that here with an empty tag map.
          neptune.describeDBSubnetGroups.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.DBSubnetGroups ?? []).flatMap((group) =>
                  group.DBSubnetGroupName
                    ? [
                        {
                          dbSubnetGroupName: group.DBSubnetGroupName,
                          dbSubnetGroupArn: group.DBSubnetGroupArn,
                          vpcId: group.VpcId,
                          subnetIds: (group.Subnets ?? []).flatMap((subnet) =>
                            subnet.SubnetIdentifier
                              ? [subnet.SubnetIdentifier]
                              : [],
                          ),
                          status: group.SubnetGroupStatus,
                          tags: {} as Record<string, string>,
                        },
                      ]
                    : [],
                ),
              ),
            ),
          ),
        delete: Effect.fn(function* ({ output }) {
          yield* neptune
            .deleteDBSubnetGroup({
              DBSubnetGroupName: output.dbSubnetGroupName,
            })
            .pipe(
              Effect.catchTag("DBSubnetGroupNotFoundFault", () => Effect.void),
            );
        }),
      };
    }),
  );
