import * as rds from "@distilled.cloud/aws/rds";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";

export interface DBClusterParameterGroupProps {
  /**
   * Name of the parameter group. If omitted, Alchemy generates one.
   */
  dbClusterParameterGroupName?: string;
  /**
   * Parameter group family, for example `aurora-postgresql16`.
   */
  family: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface DBClusterParameterGroup extends Resource<
  "AWS.RDS.DBClusterParameterGroup",
  DBClusterParameterGroupProps,
  {
    /**
     * Name of the cluster parameter group.
     */
    dbClusterParameterGroupName: string;
    /**
     * ARN of the cluster parameter group.
     */
    dbClusterParameterGroupArn: string | undefined;
    /**
     * Parameter group family (e.g. `aurora-postgresql16`).
     */
    family: string;
    /**
     * Description of the parameter group.
     */
    description: string | undefined;
    /**
     * Tags on the parameter group.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Aurora cluster parameter group — cluster-wide engine settings shared by
 * every instance in a `DBCluster`.
 *
 * Name, family, and description changes force a replacement (RDS has no
 * modify API for these); tags update in place.
 * @resource
 * @section Creating a Cluster Parameter Group
 * @example Parameter Group for Aurora Postgres 16
 * ```typescript
 * const clusterParams = yield* DBClusterParameterGroup("ClusterParams", {
 *   family: "aurora-postgresql16",
 *   description: "Cluster-wide settings for the app database",
 * });
 * ```
 *
 * @example Attach to a Cluster
 * ```typescript
 * const cluster = yield* DBCluster("Cluster", {
 *   engine: "aurora-postgresql",
 *   dbClusterParameterGroupName: clusterParams.dbClusterParameterGroupName,
 * });
 * ```
 */
export const DBClusterParameterGroup = Resource<DBClusterParameterGroup>(
  "AWS.RDS.DBClusterParameterGroup",
);

export const DBClusterParameterGroupProvider = () =>
  Provider.effect(
    DBClusterParameterGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: DBClusterParameterGroupProps) =>
        props.dbClusterParameterGroupName
          ? Effect.succeed(props.dbClusterParameterGroupName)
          : createPhysicalName({ id, maxLength: 255 });

      const readGroup = Effect.fn(function* (name: string) {
        const response = yield* rds
          .describeDBClusterParameterGroups({
            DBClusterParameterGroupName: name,
          })
          .pipe(
            Effect.catchTag("DBParameterGroupNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.DBClusterParameterGroups?.[0];
      });

      return {
        stables: ["dbClusterParameterGroupArn", "dbClusterParameterGroupName"],
        list: () =>
          // AWS account/region collection (pattern (a)): exhaustively paginate
          // describeDBClusterParameterGroups and map each group to the exact
          // `read` Attributes shape. `read` derives `tags` from the cached
          // output (the describe response does not surface tags), so list
          // returns `tags: {}` to match — a future read/delete can hydrate
          // them via listTagsForResource. Per-item not-found
          // (DBParameterGroupNotFoundFault) cannot occur here: enumeration
          // passes no name, so the describe never targets a single group.
          rds.describeDBClusterParameterGroups.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.DBClusterParameterGroups ?? [])
                  .filter(
                    (
                      g,
                    ): g is rds.DBClusterParameterGroup & {
                      DBClusterParameterGroupName: string;
                    } =>
                      g.DBClusterParameterGroupName != null &&
                      // AWS-managed `default.*` groups cannot be deleted
                      // (InvalidDBParameterGroupStateFault) — don't enumerate.
                      !g.DBClusterParameterGroupName.startsWith("default."),
                  )
                  .map((g) => ({
                    dbClusterParameterGroupName: g.DBClusterParameterGroupName,
                    dbClusterParameterGroupArn: g.DBClusterParameterGroupArn,
                    family: g.DBParameterGroupFamily ?? "",
                    description: g.Description,
                    tags: {} as Record<string, string>,
                  })),
              ),
            ),
          ),
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toName(
              id,
              olds ?? ({} as DBClusterParameterGroupProps),
            )) !== (yield* toName(id, news))
          ) {
            return { action: "replace" } as const;
          }
          if (
            olds?.family !== news.family ||
            olds?.description !== news.description
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.dbClusterParameterGroupName ??
            (yield* toName(
              id,
              olds ?? ({ family: "" } as DBClusterParameterGroupProps),
            ));
          const group = yield* readGroup(name);
          if (!group?.DBClusterParameterGroupName) {
            return undefined;
          }
          return {
            dbClusterParameterGroupName: group.DBClusterParameterGroupName,
            dbClusterParameterGroupArn: group.DBClusterParameterGroupArn,
            family: group.DBParameterGroupFamily ?? olds?.family ?? "",
            description: group.Description,
            tags: output?.tags ?? {},
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name =
            output?.dbClusterParameterGroupName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — fetch the parameter group's live state.
          let observed = yield* readGroup(name);

          // Ensure — create if missing. Tolerate
          // `DBParameterGroupAlreadyExistsFault` as a race with a peer
          // reconciler by re-reading.
          if (!observed?.DBClusterParameterGroupName) {
            yield* rds
              .createDBClusterParameterGroup({
                DBClusterParameterGroupName: name,
                DBParameterGroupFamily: news.family,
                Description:
                  news.description ?? `Alchemy parameter group ${name}`,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag(
                  "DBParameterGroupAlreadyExistsFault",
                  () => Effect.void,
                ),
              );
            observed = yield* readGroup(name);
            if (!observed?.DBClusterParameterGroupName) {
              return yield* Effect.fail(
                new Error(
                  `Failed to create DB cluster parameter group '${name}'`,
                ),
              );
            }
          }

          const dbClusterParameterGroupArn =
            observed.DBClusterParameterGroupArn;

          // Sync tags — diff observed (the describe response does not
          // surface tags, so use prior `output.tags` as the baseline) ↔
          // desired.
          const observedTags = output?.tags ?? {};
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0 && dbClusterParameterGroupArn) {
            yield* rds.addTagsToResource({
              ResourceName: dbClusterParameterGroupArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0 && dbClusterParameterGroupArn) {
            yield* rds.removeTagsFromResource({
              ResourceName: dbClusterParameterGroupArn,
              TagKeys: removed,
            });
          }

          yield* session.note(dbClusterParameterGroupArn ?? name);
          return {
            dbClusterParameterGroupName: observed.DBClusterParameterGroupName,
            dbClusterParameterGroupArn,
            family: observed.DBParameterGroupFamily ?? news.family,
            description: observed.Description,
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* rds
            .deleteDBClusterParameterGroup({
              DBClusterParameterGroupName: output.dbClusterParameterGroupName,
            })
            .pipe(
              Effect.catchTag(
                "DBParameterGroupNotFoundFault",
                () => Effect.void,
              ),
            );
        }),
      };
    }),
  );
