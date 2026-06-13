import * as rds from "@distilled.cloud/aws/rds";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import type { SubnetId } from "../EC2/Subnet.ts";

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
   * Subnets that the database resources may use.
   */
  subnetIds: SubnetId[];
  /**
   * User-defined tags for the subnet group.
   */
  tags?: Record<string, string>;
}

export interface DBSubnetGroup extends Resource<
  "AWS.RDS.DBSubnetGroup",
  DBSubnetGroupProps,
  {
    dbSubnetGroupName: string;
    dbSubnetGroupArn: string | undefined;
    vpcId: string | undefined;
    subnetIds: string[];
    status: string | undefined;
    supportedNetworkTypes: string[] | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An RDS DB subnet group for Aurora clusters, instances, and proxies.
 */
export const DBSubnetGroup = Resource<DBSubnetGroup>("AWS.RDS.DBSubnetGroup");

export const DBSubnetGroupProvider = () =>
  Provider.effect(
    DBSubnetGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: DBSubnetGroupProps) =>
        props.dbSubnetGroupName
          ? Effect.succeed(props.dbSubnetGroupName)
          : createPhysicalName({ id, maxLength: 255 });

      const readGroup = Effect.fn(function* (groupName: string) {
        const response = yield* rds
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
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
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
            supportedNetworkTypes: group.SupportedNetworkTypes,
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
            yield* rds
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
            yield* rds.modifyDBSubnetGroup({
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
            yield* rds.addTagsToResource({
              ResourceName: dbSubnetGroupArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0 && dbSubnetGroupArn) {
            yield* rds.removeTagsFromResource({
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
            supportedNetworkTypes: observed.SupportedNetworkTypes,
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* rds
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
