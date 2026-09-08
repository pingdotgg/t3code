import * as rds from "@distilled.cloud/aws/rds";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
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
   * Instance parameter overrides, e.g. `{ time_zone: "Australia/Sydney" }`.
   *
   * When set, this map is the group's entire user-owned surface: entries are
   * written, and any parameter RDS reports as user-set but absent here is
   * reset to its engine default. `{}` therefore resets every override, while
   * OMITTING the prop leaves parameters alone entirely — which is what makes
   * it safe to adopt a group that was tuned elsewhere.
   *
   * Values must be in the form RDS reports back (it canonicalises some — a
   * boolean set as `ON` reads back as `1`), or the two never compare equal
   * and every deploy re-issues the modify.
   *
   * Static parameters are applied with `pending-reboot`, dynamic parameters
   * with `immediate`.
   */
  parameters?: Record<string, string>;
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
     * The parameter overrides this resource manages; `{}` when `parameters`
     * is omitted and the group's settings are owned elsewhere.
     */
    parameters: Record<string, string>;
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
 * modify API for these); parameters and tags update in place.
 * ### Creating a Parameter Group
 * **Example:** Parameter Group for Aurora Postgres 16 Instances
 * ```typescript
 * const instanceParams = yield* DBParameterGroup("InstanceParams", {
 *   family: "aurora-postgresql16",
 *   description: "Instance-level settings for the app database",
 * });
 * ```
 *
 * **Example:** Set Engine Parameters
 * ```typescript
 * const params = yield* DBParameterGroup("MysqlParams", {
 *   family: "mysql8.4",
 *   parameters: {
 *     time_zone: "Australia/Sydney",
 *     max_connections: "200",
 *   },
 * });
 * ```
 * Dynamic parameters apply immediately, static ones on the next reboot.
 * Cluster-wide settings belong on `DBClusterParameterGroup` instead — Postgres
 * `timezone`, for example, is a cluster parameter on Aurora.
 *
 * **Example:** Attach to an Instance
 * ```typescript
 * const writer = yield* DBInstance("Writer", {
 *   dbClusterIdentifier: cluster.dbClusterIdentifier,
 *   dbInstanceClass: "db.serverless",
 *   engine: "aurora-postgresql",
 *   dbParameterGroupName: instanceParams.dbParameterGroupName,
 * });
 * ```
 *
 * @resource
 */
export const DBParameterGroup = Resource<DBParameterGroup>(
  "AWS.RDS.DBParameterGroup",
);

/**
 * A parameter modify/reset issued immediately after another change fails with
 * `InvalidDBParameterGroupStateFault` ("has pending changes") until the prior
 * change settles — retry it on a short bounded schedule.
 */
const retryWhileParameterGroupBusy = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "InvalidDBParameterGroupStateFault",
    schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(10)]),
  });

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

      // All parameters (defaults + overrides) with their current values and
      // apply types — the observed baseline for the parameter sync.
      const readParameters = Effect.fn(function* (name: string) {
        return yield* rds.describeDBParameters
          .pages({ DBParameterGroupName: name })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.Parameters ?? []),
            ),
          );
      });

      // The subset the user has overridden (Source `user`) — used to compute
      // resets when a prop entry is removed.
      const readUserParameters = Effect.fn(function* (name: string) {
        return yield* rds.describeDBParameters
          .pages({ DBParameterGroupName: name, Source: "user" })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.Parameters ?? []),
            ),
          );
      });

      const toUserParameterRecord = (
        parameters: rds.Parameter[],
      ): Record<string, string> =>
        Object.fromEntries(
          parameters.flatMap((p) =>
            p.ParameterName !== undefined && p.ParameterValue !== undefined
              ? [[p.ParameterName, p.ParameterValue]]
              : [],
          ),
        );

      return {
        stables: ["dbParameterGroupArn", "dbParameterGroupName"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
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
          // Props alone would miss an out-of-band edit: the engine's fallback
          // compares props, so a console change to a parameter this resource
          // owns would never schedule the reconcile that corrects it.
          if (
            news.parameters !== undefined &&
            output !== undefined &&
            !deepEqual(news.parameters, output.parameters)
          ) {
            return { action: "update" } as const;
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
                    // Like tags: a describe per group would be O(groups) calls.
                    parameters: {} as Record<string, string>,
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
          // Unlike tags, parameters come back from the API.
          const parameters = toUserParameterRecord(
            yield* readUserParameters(group.DBParameterGroupName),
          );
          return {
            dbParameterGroupName: group.DBParameterGroupName,
            dbParameterGroupArn: group.DBParameterGroupArn,
            family: group.DBParameterGroupFamily ?? olds?.family ?? "",
            description: group.Description,
            parameters,
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

          // Sync parameters — diff observed cloud values against desired.
          // Only when the prop is present: reconcile also runs on adopt, so
          // defaulting an omitted map to {} would reset every override on a
          // group that was tuned elsewhere.
          const desiredParameters = news.parameters;
          if (desiredParameters !== undefined) {
            const byName = new Map(
              (yield* readParameters(name)).flatMap((p) =>
                p.ParameterName !== undefined
                  ? [[p.ParameterName, p] as const]
                  : [],
              ),
            );

            const toModify: rds.Parameter[] = Object.entries(
              desiredParameters,
            ).flatMap(([ParameterName, ParameterValue]) => {
              const current = byName.get(ParameterName);
              if (current?.ParameterValue === ParameterValue) return [];
              return [
                {
                  ParameterName,
                  ParameterValue,
                  ApplyMethod:
                    current?.ApplyType === "static"
                      ? "pending-reboot"
                      : "immediate",
                },
              ];
            });
            if (toModify.length > 0) {
              // The API caps a single call at 20 parameters.
              for (let i = 0; i < toModify.length; i += 20) {
                yield* retryWhileParameterGroupBusy(
                  rds.modifyDBParameterGroup({
                    DBParameterGroupName: name,
                    Parameters: toModify.slice(i, i + 20),
                  }),
                );
              }
            }

            // Reset user-overridden parameters that were removed from props.
            const toReset = (yield* readUserParameters(name)).flatMap((p) =>
              p.ParameterName !== undefined &&
              !(p.ParameterName in desiredParameters)
                ? [
                    {
                      ParameterName: p.ParameterName,
                      ApplyMethod:
                        p.ApplyType === "static"
                          ? ("pending-reboot" as const)
                          : ("immediate" as const),
                    },
                  ]
                : [],
            );
            if (toReset.length > 0) {
              for (let i = 0; i < toReset.length; i += 20) {
                yield* retryWhileParameterGroupBusy(
                  rds.resetDBParameterGroup({
                    DBParameterGroupName: name,
                    ResetAllParameters: false,
                    Parameters: toReset.slice(i, i + 20),
                  }),
                );
              }
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
            parameters: desiredParameters ?? {},
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
