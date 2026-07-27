import * as neptune from "@distilled.cloud/aws/neptune";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface DBClusterParameterGroupProps {
  /**
   * Name of the DB cluster parameter group. If omitted, a deterministic name
   * is generated. Changing it forces replacement.
   */
  dbClusterParameterGroupName?: string;
  /**
   * DB cluster parameter group family, e.g. `neptune1.4`, `neptune1.3`.
   * Immutable — forces replacement.
   */
  family: string;
  /**
   * Description for the parameter group.
   * @default "Managed by Alchemy"
   */
  description?: string;
  /**
   * Cluster parameter overrides, e.g.
   * `{ neptune_query_timeout: "120000" }`. Parameters removed from this map
   * are reset to their engine defaults. Static parameters are applied with
   * `pending-reboot`, dynamic parameters with `immediate`.
   */
  parameters?: Record<string, string>;
  /**
   * User-defined tags for the parameter group.
   */
  tags?: Record<string, string>;
}

export interface DBClusterParameterGroup extends Resource<
  "AWS.Neptune.DBClusterParameterGroup",
  DBClusterParameterGroupProps,
  {
    /** Name of the parameter group. */
    dbClusterParameterGroupName: string;
    /** ARN of the parameter group. */
    dbClusterParameterGroupArn: string | undefined;
    /** Parameter group family (e.g. `neptune1.4`). */
    family: string;
    /** Description of the parameter group. */
    description: string | undefined;
    /** Non-default parameter values applied to the group. */
    parameters: Record<string, string>;
    /** Tags on the parameter group (user + internal Alchemy tags). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Neptune DB cluster parameter group — a named set of engine
 * configuration parameters (query timeout, audit logging, ...) that can be
 * attached to one or more Neptune {@link DBCluster}s.
 * @resource
 * @section Creating a Parameter Group
 * @example Parameter group with a custom query timeout
 * ```typescript
 * const params = yield* DBClusterParameterGroup("Params", {
 *   family: "neptune1.4",
 *   parameters: {
 *     neptune_query_timeout: "120000",
 *   },
 * });
 * ```
 *
 * @section Attaching to a Cluster
 * @example Cluster using the parameter group
 * ```typescript
 * const cluster = yield* DBCluster("Graph", {
 *   dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
 *   dbClusterParameterGroupName: params.dbClusterParameterGroupName,
 * });
 * ```
 */
export const DBClusterParameterGroup = Resource<DBClusterParameterGroup>(
  "AWS.Neptune.DBClusterParameterGroup",
);

const toTagRecord = (
  tags: Array<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
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

export const DBClusterParameterGroupProvider = () =>
  Provider.effect(
    DBClusterParameterGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: DBClusterParameterGroupProps) =>
        props.dbClusterParameterGroupName
          ? Effect.succeed(props.dbClusterParameterGroupName)
          : createPhysicalName({ id, maxLength: 255 });

      const readGroup = Effect.fn(function* (groupName: string) {
        const response = yield* neptune
          .describeDBClusterParameterGroups({
            DBClusterParameterGroupName: groupName,
          })
          .pipe(
            Effect.catchTag("DBParameterGroupNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.DBClusterParameterGroups?.[0];
      });

      // All parameters (defaults + overrides) with their current values and
      // apply types — the observed baseline for the parameter sync.
      const readParameters = Effect.fn(function* (groupName: string) {
        return yield* neptune.describeDBClusterParameters
          .pages({ DBClusterParameterGroupName: groupName })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.Parameters ?? []),
            ),
          );
      });

      // The subset of parameters the user has overridden (Source `user`) —
      // used to compute resets when a prop entry is removed.
      const readUserParameters = Effect.fn(function* (groupName: string) {
        return yield* neptune.describeDBClusterParameters
          .pages({ DBClusterParameterGroupName: groupName, Source: "user" })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.Parameters ?? []),
            ),
          );
      });

      const readTags = Effect.fn(function* (arn: string | undefined) {
        if (!arn) return {} as Record<string, string>;
        const response = yield* neptune.listTagsForResource({
          ResourceName: arn,
        });
        return toTagRecord(response?.TagList);
      });

      const toUserParameterRecord = (
        parameters: neptune.Parameter[],
      ): Record<string, string> =>
        Object.fromEntries(
          parameters.flatMap((p) =>
            p.ParameterName !== undefined && p.ParameterValue !== undefined
              ? [[p.ParameterName, p.ParameterValue]]
              : [],
          ),
        );

      return {
        stables: [
          "dbClusterParameterGroupArn",
          "dbClusterParameterGroupName",
          "family",
        ],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? { family: "" })) !==
            (yield* toName(id, news))
          ) {
            return { action: "replace" } as const;
          }
          // Family is immutable — any change forces a fresh group.
          if (olds !== undefined && olds.family !== news.family) {
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
          const userParameters = yield* readUserParameters(name);
          const tags = yield* readTags(group.DBClusterParameterGroupArn);
          return {
            dbClusterParameterGroupName: group.DBClusterParameterGroupName,
            dbClusterParameterGroupArn: group.DBClusterParameterGroupArn,
            family: group.DBParameterGroupFamily ?? "",
            description: group.Description,
            parameters: toUserParameterRecord(userParameters),
            tags,
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name =
            output?.dbClusterParameterGroupName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — fetch live parameter-group state.
          let observed = yield* readGroup(name);

          // Ensure — create if missing. Tolerate
          // `DBParameterGroupAlreadyExistsFault` as a race with a peer
          // reconciler by re-reading.
          if (!observed?.DBClusterParameterGroupName) {
            yield* neptune
              .createDBClusterParameterGroup({
                DBClusterParameterGroupName: name,
                DBParameterGroupFamily: news.family,
                Description: news.description ?? "Managed by Alchemy",
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

          // Sync parameters — diff observed cloud values against desired.
          const desiredParameters = news.parameters ?? {};
          const allParameters = yield* readParameters(name);
          const byName = new Map(
            allParameters.map((p) => [p.ParameterName, p]),
          );

          const toModify: neptune.Parameter[] = Object.entries(
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
                neptune.modifyDBClusterParameterGroup({
                  DBClusterParameterGroupName: name,
                  Parameters: toModify.slice(i, i + 20),
                }),
              );
            }
          }

          // Reset user-overridden parameters that were removed from props.
          const userParameters = yield* readUserParameters(name);
          const toReset = userParameters.flatMap((p) =>
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
                neptune.resetDBClusterParameterGroup({
                  DBClusterParameterGroupName: name,
                  ResetAllParameters: false,
                  Parameters: toReset.slice(i, i + 20),
                }),
              );
            }
          }

          const arn = observed.DBClusterParameterGroupArn;

          // Sync tags — diff observed cloud tags against desired.
          const observedTags = yield* readTags(arn);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0 && arn) {
            yield* neptune.addTagsToResource({
              ResourceName: arn,
              Tags: upsert,
            });
          }
          if (removed.length > 0 && arn) {
            yield* neptune.removeTagsFromResource({
              ResourceName: arn,
              TagKeys: removed,
            });
          }

          yield* session.note(arn ?? name);
          return {
            dbClusterParameterGroupName: observed.DBClusterParameterGroupName,
            dbClusterParameterGroupArn: arn,
            family: observed.DBParameterGroupFamily ?? news.family,
            description: observed.Description,
            parameters: desiredParameters,
            tags: desiredTags,
          };
        }),
        list: () =>
          // AWS account/region collection: the RDS-family control plane
          // serves parameter groups for every engine, so keep only families
          // beginning with `neptune`. Hydrating per-group parameters/tags
          // would fan out one call per item — mirror `DBSubnetGroup.list` and
          // emit empty maps instead.
          neptune.describeDBClusterParameterGroups.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.DBClusterParameterGroups ?? []).flatMap((group) =>
                  group.DBClusterParameterGroupName &&
                  group.DBParameterGroupFamily?.startsWith("neptune")
                    ? [
                        {
                          dbClusterParameterGroupName:
                            group.DBClusterParameterGroupName,
                          dbClusterParameterGroupArn:
                            group.DBClusterParameterGroupArn,
                          family: group.DBParameterGroupFamily,
                          description: group.Description,
                          parameters: {} as Record<string, string>,
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
