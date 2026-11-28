import * as rds from "@distilled.cloud/aws/rds";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { createInternalTags, diffTags } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { SubnetId } from "../EC2/Subnet.ts";
import type { Providers } from "../Providers.ts";

export class RDSDBSubnetGroupUnexpectedResponse extends Data.TaggedError(
  "RDSDBSubnetGroupUnexpectedResponse",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

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
    /**
     * Name of the subnet group.
     */
    dbSubnetGroupName: string;
    /**
     * ARN of the subnet group.
     */
    dbSubnetGroupArn: string | undefined;
    /**
     * VPC the subnets belong to.
     */
    vpcId: string | undefined;
    /**
     * Subnet IDs registered in the group.
     */
    subnetIds: string[];
    /**
     * Status of the subnet group (e.g. `Complete`).
     */
    status: string | undefined;
    /**
     * Network types the group supports (`IPV4`, `DUAL`).
     */
    supportedNetworkTypes: string[] | undefined;
    /**
     * Tags on the subnet group.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An RDS DB subnet group for Aurora clusters, instances, and proxies.
 *
 * RDS requires a subnet group spanning at least two Availability Zones
 * before a cluster or instance can be placed in a VPC. Changing the name
 * replaces the group; the subnet list updates in place.
 * ### Creating a Subnet Group
 * **Example:** Subnet Group Across Two AZs
 * ```typescript
 * const subnetGroup = yield* DBSubnetGroup("SubnetGroup", {
 *   subnetIds: [privateSubnetA.subnetId, privateSubnetB.subnetId],
 * });
 * ```
 *
 * **Example:** Place an Aurora Cluster in the Group
 * ```typescript
 * const cluster = yield* DBCluster("Cluster", {
 *   engine: "aurora-postgresql",
 *   dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
 *   vpcSecurityGroupIds: [dbSecurityGroup.groupId],
 * });
 * ```
 *
 * @resource
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

      const readTags = Effect.fn(function* (arn: string | undefined) {
        if (!arn) return {} as Record<string, string>;
        const response = yield* rds.listTagsForResource({ ResourceName: arn });
        return Object.fromEntries(
          (response.TagList ?? []).flatMap(({ Key, Value }) =>
            Key !== undefined && Value !== undefined ? [[Key, Value]] : [],
          ),
        ) as Record<string, string>;
      });

      const readGroup = Effect.fn(function* (groupName: string) {
        const response = yield* rds
          .describeDBSubnetGroups({
            DBSubnetGroupName: groupName,
          })
          .pipe(Effect.catchTag("DBSubnetGroupNotFoundFault", () => Effect.undefined));
        return response?.DBSubnetGroups?.[0];
      });

      return {
        stables: ["dbSubnetGroupArn", "dbSubnetGroupName", "vpcId"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if ((yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.dbSubnetGroupName ??
            (yield* toName(id, olds ?? ({ subnetIds: [] } as DBSubnetGroupProps)));
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
            tags: yield* readTags(group.DBSubnetGroupArn),
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const dbSubnetGroupName = output?.dbSubnetGroupName ?? (yield* toName(id, news));
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
                DBSubnetGroupDescription: news.description ?? "Managed by Alchemy",
                SubnetIds: news.subnetIds,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(Effect.catchTag("DBSubnetGroupAlreadyExistsFault", () => Effect.void));
            observed = yield* readGroup(dbSubnetGroupName);
            if (!observed?.DBSubnetGroupName) {
              return yield* new RDSDBSubnetGroupUnexpectedResponse({
                message: `Failed to create DB subnet group '${dbSubnetGroupName}'`,
              });
            }
          } else {
            // Sync description and subnet membership — `modifyDBSubnetGroup`
            // accepts the full desired set and is idempotent for unchanged
            // input.
            yield* rds.modifyDBSubnetGroup({
              DBSubnetGroupName: dbSubnetGroupName,
              DBSubnetGroupDescription: news.description ?? "Managed by Alchemy",
              SubnetIds: news.subnetIds,
            });
            observed = yield* readGroup(dbSubnetGroupName);
            if (!observed?.DBSubnetGroupName) {
              return yield* new RDSDBSubnetGroupUnexpectedResponse({
                message: `DB subnet group '${dbSubnetGroupName}' not found after update`,
              });
            }
          }

          const dbSubnetGroupArn = observed.DBSubnetGroupArn;

          // Sync tags — diff observed cloud tags against desired (describe
          // does not surface tags inline).
          const observedTags = yield* readTags(dbSubnetGroupArn);
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
        list: () =>
          // AWS account/region collection: `describeDBSubnetGroups` is
          // paginated (items field `DBSubnetGroups`). Collect every page and
          // map each group into the `read` Attributes shape, with an empty
          // tag map rather than a per-item `listTagsForResource` call.
          rds.describeDBSubnetGroups.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.DBSubnetGroups ?? []).flatMap((group) =>
                  // `default` is the RDS-family subnet group AWS auto-creates
                  // for the default VPC — never ours, never census/nuke it.
                  group.DBSubnetGroupName && group.DBSubnetGroupName !== "default"
                    ? [
                        {
                          dbSubnetGroupName: group.DBSubnetGroupName,
                          dbSubnetGroupArn: group.DBSubnetGroupArn,
                          vpcId: group.VpcId,
                          subnetIds: (group.Subnets ?? []).flatMap((subnet) =>
                            subnet.SubnetIdentifier ? [subnet.SubnetIdentifier] : [],
                          ),
                          status: group.SubnetGroupStatus,
                          supportedNetworkTypes: group.SupportedNetworkTypes,
                          tags: {} as Record<string, string>,
                        },
                      ]
                    : [],
                ),
              ),
            ),
          ),
        delete: Effect.fn(function* ({ output }) {
          yield* rds
            .deleteDBSubnetGroup({
              DBSubnetGroupName: output.dbSubnetGroupName,
            })
            .pipe(Effect.catchTag("DBSubnetGroupNotFoundFault", () => Effect.void));
        }),
      };
    }),
  );
