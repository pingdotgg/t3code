import * as rds from "@distilled.cloud/aws/rds";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";

export interface DBParameterGroupProps {
  /**
   * Name of the parameter group. If omitted, Alchemy generates one.
   */
  dbParameterGroupName?: string;
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

export interface DBParameterGroup extends Resource<
  "AWS.RDS.DBParameterGroup",
  DBParameterGroupProps,
  {
    /**
     * Name of the parameter group.
     */
    dbParameterGroupName: string;
    /**
     * ARN of the parameter group.
     */
    dbParameterGroupArn: string | undefined;
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
 * An RDS DB parameter group — instance-level engine settings, applied to a
 * `DBInstance` (as opposed to the cluster-wide `DBClusterParameterGroup`).
 *
 * Name, family, and description changes force a replacement (RDS has no
 * modify API for these); tags update in place.
 * @resource
 * @section Creating a Parameter Group
 * @example Parameter Group for Aurora Postgres 16 Instances
 * ```typescript
 * const instanceParams = yield* DBParameterGroup("InstanceParams", {
 *   family: "aurora-postgresql16",
 *   description: "Instance-level settings for the app database",
 * });
 * ```
 *
 * @example Attach to an Instance
 * ```typescript
 * const writer = yield* DBInstance("Writer", {
 *   dbClusterIdentifier: cluster.dbClusterIdentifier,
 *   dbInstanceClass: "db.serverless",
 *   engine: "aurora-postgresql",
 *   dbParameterGroupName: instanceParams.dbParameterGroupName,
 * });
 * ```
 */
export const DBParameterGroup = Resource<DBParameterGroup>(
  "AWS.RDS.DBParameterGroup",
);

export const DBParameterGroupProvider = () =>
  Provider.effect(
    DBParameterGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: DBParameterGroupProps) =>
        props.dbParameterGroupName
          ? Effect.succeed(props.dbParameterGroupName)
          : createPhysicalName({ id, maxLength: 255 });

      const readGroup = Effect.fn(function* (name: string) {
        const response = yield* rds
          .describeDBParameterGroups({
            DBParameterGroupName: name,
          })
          .pipe(
            Effect.catchTag("DBParameterGroupNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.DBParameterGroups?.[0];
      });

      return {
        stables: ["dbParameterGroupArn", "dbParameterGroupName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? ({} as DBParameterGroupProps))) !==
            (yield* toName(id, news))
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
        list: () =>
          // AWS account/region collection (pattern (a)): exhaustively paginate
          // describeDBParameterGroups and map each group to the exact `read`
          // Attributes shape. `read` derives `tags` from the cached output
          // (the describe response does not surface tags), so list returns
          // `tags: {}` to match — a future read/delete can hydrate them.
          rds.describeDBParameterGroups.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.DBParameterGroups ?? [])
                  .filter(
                    (
                      g,
                    ): g is rds.DBParameterGroup & {
                      DBParameterGroupName: string;
                    } =>
                      g.DBParameterGroupName != null &&
                      // AWS-managed `default.*` groups cannot be deleted
                      // (InvalidDBParameterGroupStateFault) — don't enumerate.
                      !g.DBParameterGroupName.startsWith("default."),
                  )
                  .map((g) => ({
                    dbParameterGroupName: g.DBParameterGroupName,
                    dbParameterGroupArn: g.DBParameterGroupArn,
                    family: g.DBParameterGroupFamily ?? "",
                    description: g.Description,
                    tags: {} as Record<string, string>,
                  })),
              ),
            ),
          ),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.dbParameterGroupName ??
            (yield* toName(
              id,
              olds ?? ({ family: "" } as DBParameterGroupProps),
            ));
          const group = yield* readGroup(name);
          if (!group?.DBParameterGroupName) {
            return undefined;
          }
          return {
            dbParameterGroupName: group.DBParameterGroupName,
            dbParameterGroupArn: group.DBParameterGroupArn,
            family: group.DBParameterGroupFamily ?? olds?.family ?? "",
            description: group.Description,
            tags: output?.tags ?? {},
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name =
            output?.dbParameterGroupName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — fetch live parameter-group state.
          let observed = yield* readGroup(name);

          // Ensure — create if missing. Tolerate
          // `DBParameterGroupAlreadyExistsFault` as a race with a peer
          // reconciler by re-reading.
          if (!observed?.DBParameterGroupName) {
            yield* rds
              .createDBParameterGroup({
                DBParameterGroupName: name,
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
            if (!observed?.DBParameterGroupName) {
              return yield* Effect.fail(
                new Error(`Failed to create DB parameter group '${name}'`),
              );
            }
          }

          const dbParameterGroupArn = observed.DBParameterGroupArn;

          // Sync tags — diff prior recorded tags against desired (the
          // describe response does not surface tags directly).
          const observedTags = output?.tags ?? {};
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0 && dbParameterGroupArn) {
            yield* rds.addTagsToResource({
              ResourceName: dbParameterGroupArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0 && dbParameterGroupArn) {
            yield* rds.removeTagsFromResource({
              ResourceName: dbParameterGroupArn,
              TagKeys: removed,
            });
          }

          yield* session.note(dbParameterGroupArn ?? name);
          return {
            dbParameterGroupName: observed.DBParameterGroupName,
            dbParameterGroupArn,
            family: observed.DBParameterGroupFamily ?? news.family,
            description: observed.Description,
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* rds
            .deleteDBParameterGroup({
              DBParameterGroupName: output.dbParameterGroupName,
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
