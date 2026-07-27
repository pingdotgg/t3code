import * as rds from "@distilled.cloud/aws/rds";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface DBProxyTargetGroupProps {
  /**
   * Proxy that owns the target group.
   */
  dbProxyName: string;
  /**
   * Target group name.
   * @default "default"
   */
  targetGroupName?: string;
  /**
   * Cluster targets registered with the proxy.
   */
  dbClusterIdentifiers?: string[];
  /**
   * Instance targets registered with the proxy.
   */
  dbInstanceIdentifiers?: string[];
  /**
   * Connection pool configuration.
   */
  connectionPoolConfig?: rds.ConnectionPoolConfiguration;
}

export interface DBProxyTargetGroup extends Resource<
  "AWS.RDS.DBProxyTargetGroup",
  DBProxyTargetGroupProps,
  {
    /**
     * Proxy that owns the target group.
     */
    dbProxyName: string;
    /**
     * Name of the target group (`default` unless overridden).
     */
    targetGroupName: string;
    /**
     * ARN of the target group.
     */
    targetGroupArn: string | undefined;
    /**
     * Status of the target group (e.g. `available`).
     */
    status: string | undefined;
    /**
     * Whether this is the proxy's default target group.
     */
    isDefault: boolean | undefined;
    /**
     * Observed connection pool configuration.
     */
    connectionPoolConfig: rds.ConnectionPoolConfigurationInfo | undefined;
    /**
     * Cluster targets registered with the proxy.
     */
    dbClusterIdentifiers: string[];
    /**
     * Instance targets registered with the proxy.
     */
    dbInstanceIdentifiers: string[];
  },
  never,
  Providers
> {}

/**
 * The proxy target group that registers Aurora clusters or instances behind an
 * RDS Proxy.
 *
 * Every `DBProxy` has exactly one `default` target group; this resource
 * adopts it, tunes its connection pool, and reconciles the registered
 * cluster/instance targets. Deleting it deregisters the targets rather than
 * deleting the group itself.
 * @resource
 * @section Registering Targets
 * @example Register a Cluster Behind a Proxy
 * ```typescript
 * const targets = yield* DBProxyTargetGroup("ProxyTargets", {
 *   dbProxyName: proxy.dbProxyName,
 *   dbClusterIdentifiers: [cluster.dbClusterIdentifier],
 * });
 * ```
 *
 * @example Tune the Connection Pool
 * ```typescript
 * const targets = yield* DBProxyTargetGroup("ProxyTargets", {
 *   dbProxyName: proxy.dbProxyName,
 *   dbClusterIdentifiers: [cluster.dbClusterIdentifier],
 *   connectionPoolConfig: {
 *     MaxConnectionsPercent: 90,
 *     MaxIdleConnectionsPercent: 10,
 *   },
 * });
 * ```
 */
export const DBProxyTargetGroup = Resource<DBProxyTargetGroup>(
  "AWS.RDS.DBProxyTargetGroup",
);

const toTargetGroupName = (props: DBProxyTargetGroupProps) =>
  props.targetGroupName ?? "default";

export const DBProxyTargetGroupProvider = () =>
  Provider.effect(
    DBProxyTargetGroup,
    Effect.gen(function* () {
      const readGroup = Effect.fn(function* ({
        dbProxyName,
        targetGroupName,
      }: {
        dbProxyName: string;
        targetGroupName: string;
      }) {
        const response = yield* rds
          .describeDBProxyTargetGroups({
            DBProxyName: dbProxyName,
            TargetGroupName: targetGroupName,
          })
          .pipe(
            Effect.catchTag("DBProxyTargetGroupNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.TargetGroups?.[0];
      });

      const toAttrs = ({
        group,
        props,
      }: {
        group: rds.DBProxyTargetGroup;
        props: DBProxyTargetGroupProps;
      }): DBProxyTargetGroup["Attributes"] => ({
        dbProxyName: group.DBProxyName ?? props.dbProxyName,
        targetGroupName: group.TargetGroupName ?? toTargetGroupName(props),
        targetGroupArn: group.TargetGroupArn,
        status: group.Status,
        isDefault: group.IsDefault,
        connectionPoolConfig: group.ConnectionPoolConfig,
        dbClusterIdentifiers: props.dbClusterIdentifiers ?? [],
        dbInstanceIdentifiers: props.dbInstanceIdentifiers ?? [],
      });

      const readTargets = Effect.fn(function* ({
        dbProxyName,
        targetGroupName,
      }: {
        dbProxyName: string;
        targetGroupName: string;
      }) {
        const response = yield* rds
          .describeDBProxyTargets({
            DBProxyName: dbProxyName,
            TargetGroupName: targetGroupName,
          })
          .pipe(
            Effect.catchTag("DBProxyTargetNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
            Effect.catchTag("DBProxyTargetGroupNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
            Effect.catchTag("DBProxyNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        const targets = response?.Targets ?? [];
        const observedClusters: string[] = [];
        const observedInstances: string[] = [];
        for (const target of targets) {
          const id = target.RdsResourceId;
          if (!id) continue;
          if (target.Type === "TRACKED_CLUSTER") {
            observedClusters.push(id);
          } else if (target.Type === "RDS_INSTANCE") {
            observedInstances.push(id);
          }
        }
        return { observedClusters, observedInstances };
      });

      return {
        stables: ["dbProxyName", "targetGroupArn", "targetGroupName"],
        // Target groups are proxy-scoped: `describeDBProxyTargetGroups`
        // requires a `DBProxyName`, so there is no account-wide enumeration.
        // Fan out — enumerate every proxy via the paginated `describeDBProxies`,
        // then list each proxy's target groups and hydrate registered targets
        // (cluster/instance identifiers) via `describeDBProxyTargets` so each
        // element matches `read`'s `Attributes` shape exactly. A proxy/target
        // group deleted between describes surfaces a typed not-found per item
        // and is dropped.
        list: () =>
          Effect.gen(function* () {
            const proxies = yield* rds.describeDBProxies.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.DBProxies ?? []),
              ),
            );
            const perProxy = yield* Effect.forEach(
              proxies,
              (proxy) =>
                Effect.gen(function* () {
                  const dbProxyName = proxy.DBProxyName;
                  if (!dbProxyName) return [];
                  const groups = yield* rds.describeDBProxyTargetGroups
                    .pages({ DBProxyName: dbProxyName })
                    .pipe(
                      Stream.runCollect,
                      Effect.map((chunk) =>
                        Array.from(chunk).flatMap(
                          (page) => page.TargetGroups ?? [],
                        ),
                      ),
                      Effect.catchTag("DBProxyNotFoundFault", () =>
                        Effect.succeed([] as rds.DBProxyTargetGroup[]),
                      ),
                      Effect.catchTag("DBProxyTargetGroupNotFoundFault", () =>
                        Effect.succeed([] as rds.DBProxyTargetGroup[]),
                      ),
                    );
                  return yield* Effect.forEach(
                    groups,
                    (group) =>
                      Effect.gen(function* () {
                        const targetGroupName =
                          group.TargetGroupName ?? "default";
                        const { observedClusters, observedInstances } =
                          yield* readTargets({ dbProxyName, targetGroupName });
                        return {
                          dbProxyName: group.DBProxyName ?? dbProxyName,
                          targetGroupName,
                          targetGroupArn: group.TargetGroupArn,
                          status: group.Status,
                          isDefault: group.IsDefault,
                          connectionPoolConfig: group.ConnectionPoolConfig,
                          dbClusterIdentifiers: observedClusters,
                          dbInstanceIdentifiers: observedInstances,
                        } satisfies DBProxyTargetGroup["Attributes"];
                      }),
                    { concurrency: 10 },
                  );
                }),
              { concurrency: 10 },
            );
            return perProxy.flat();
          }),
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (olds?.dbProxyName !== news.dbProxyName) {
            return { action: "replace" } as const;
          }
          if (toTargetGroupName(olds ?? news) !== toTargetGroupName(news)) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const props = {
            dbProxyName: output?.dbProxyName ?? olds?.dbProxyName ?? "",
            targetGroupName: output?.targetGroupName ?? olds?.targetGroupName,
            dbClusterIdentifiers:
              output?.dbClusterIdentifiers ?? olds?.dbClusterIdentifiers,
            dbInstanceIdentifiers:
              output?.dbInstanceIdentifiers ?? olds?.dbInstanceIdentifiers,
            connectionPoolConfig:
              output?.connectionPoolConfig ?? olds?.connectionPoolConfig,
          } satisfies DBProxyTargetGroupProps;
          const group = yield* readGroup({
            dbProxyName: props.dbProxyName,
            targetGroupName: toTargetGroupName(props),
          });
          if (!group?.TargetGroupName) {
            return undefined;
          }
          return toAttrs({ group, props });
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          const targetGroupName = toTargetGroupName(news);

          // Observe — the "default" target group is created automatically
          // by RDS when the parent DBProxy is created, so we don't `Ensure`
          // a target group ourselves. We just describe it to confirm the
          // proxy is ready and to read connection-pool config.
          let observedGroup = yield* readGroup({
            dbProxyName: news.dbProxyName,
            targetGroupName,
          });

          // Sync connection pool config — push desired shape if provided.
          // `modifyDBProxyTargetGroup` is idempotent for unchanged config.
          if (news.connectionPoolConfig) {
            yield* rds.modifyDBProxyTargetGroup({
              DBProxyName: news.dbProxyName,
              TargetGroupName: targetGroupName,
              ConnectionPoolConfig: news.connectionPoolConfig,
            });
          }

          // Sync registered targets — diff observed live targets against
          // desired and apply only the delta. We trust live cloud state
          // over `output`/`olds` so adoption and drift converge.
          const { observedClusters, observedInstances } = yield* readTargets({
            dbProxyName: news.dbProxyName,
            targetGroupName,
          });
          const desiredClusters = new Set(news.dbClusterIdentifiers ?? []);
          const desiredInstances = new Set(news.dbInstanceIdentifiers ?? []);
          const observedClusterSet = new Set(observedClusters);
          const observedInstanceSet = new Set(observedInstances);

          const addClusters = [...desiredClusters].filter(
            (id) => !observedClusterSet.has(id),
          );
          const removeClusters = [...observedClusterSet].filter(
            (id) => !desiredClusters.has(id),
          );
          const addInstances = [...desiredInstances].filter(
            (id) => !observedInstanceSet.has(id),
          );
          const removeInstances = [...observedInstanceSet].filter(
            (id) => !desiredInstances.has(id),
          );

          if (addClusters.length > 0 || addInstances.length > 0) {
            yield* rds.registerDBProxyTargets({
              DBProxyName: news.dbProxyName,
              TargetGroupName: targetGroupName,
              DBClusterIdentifiers:
                addClusters.length > 0 ? addClusters : undefined,
              DBInstanceIdentifiers:
                addInstances.length > 0 ? addInstances : undefined,
            });
          }

          if (removeClusters.length > 0 || removeInstances.length > 0) {
            yield* rds.deregisterDBProxyTargets({
              DBProxyName: news.dbProxyName,
              TargetGroupName: targetGroupName,
              DBClusterIdentifiers:
                removeClusters.length > 0 ? removeClusters : undefined,
              DBInstanceIdentifiers:
                removeInstances.length > 0 ? removeInstances : undefined,
            });
          }

          // Re-read so returned attrs reflect post-sync state. If the
          // target group still isn't visible, surface the failure (the
          // parent DBProxy must be up).
          observedGroup = yield* readGroup({
            dbProxyName: news.dbProxyName,
            targetGroupName,
          });
          if (!observedGroup?.TargetGroupName) {
            return yield* Effect.fail(
              new Error(`DB proxy target group '${targetGroupName}' not found`),
            );
          }
          yield* session.note(
            observedGroup.TargetGroupArn ??
              output?.targetGroupArn ??
              observedGroup.TargetGroupName,
          );
          return toAttrs({ group: observedGroup, props: news });
        }),
        delete: Effect.fn(function* ({ output }) {
          if (
            output.dbClusterIdentifiers.length > 0 ||
            output.dbInstanceIdentifiers.length > 0
          ) {
            yield* rds
              .deregisterDBProxyTargets({
                DBProxyName: output.dbProxyName,
                TargetGroupName: output.targetGroupName,
                DBClusterIdentifiers:
                  output.dbClusterIdentifiers.length > 0
                    ? output.dbClusterIdentifiers
                    : undefined,
                DBInstanceIdentifiers:
                  output.dbInstanceIdentifiers.length > 0
                    ? output.dbInstanceIdentifiers
                    : undefined,
              })
              .pipe(
                Effect.catchTag(
                  "DBProxyTargetGroupNotFoundFault",
                  () => Effect.void,
                ),
              );
          }
        }),
      };
    }),
  );
