import * as rds from "@distilled.cloud/aws/rds";
import * as Effect from "effect/Effect";
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
    dbProxyName: string;
    targetGroupName: string;
    targetGroupArn: string | undefined;
    status: string | undefined;
    isDefault: boolean | undefined;
    connectionPoolConfig: rds.ConnectionPoolConfigurationInfo | undefined;
    dbClusterIdentifiers: string[];
    dbInstanceIdentifiers: string[];
  },
  never,
  Providers
> {}

/**
 * The proxy target group that registers Aurora clusters or instances behind an
 * RDS Proxy.
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
