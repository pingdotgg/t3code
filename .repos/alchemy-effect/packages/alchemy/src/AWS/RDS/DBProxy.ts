import * as rds from "@distilled.cloud/aws/rds";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";

export interface DBProxyProps {
  /**
   * Proxy name. If omitted, Alchemy generates one.
   */
  dbProxyName?: string;
  /**
   * Engine family such as `POSTGRESQL`.
   */
  engineFamily: rds.EngineFamily;
  /**
   * Authentication config for the proxy.
   */
  auth: rds.UserAuthConfig[];
  /**
   * IAM role ARN used by the proxy to read secrets.
   */
  roleArn: string;
  /**
   * Subnets used by the proxy.
   */
  vpcSubnetIds: string[];
  /**
   * Security groups attached to the proxy.
   */
  vpcSecurityGroupIds?: string[];
  /**
   * Require TLS from clients.
   */
  requireTLS?: boolean;
  /**
   * Idle client timeout in seconds.
   */
  idleClientTimeout?: number;
  /**
   * Enable debug logging.
   */
  debugLogging?: boolean;
  /**
   * Endpoint network type.
   */
  endpointNetworkType?: rds.EndpointNetworkType;
  /**
   * Target connection network type.
   */
  targetConnectionNetworkType?: rds.TargetConnectionNetworkType;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface DBProxy extends Resource<
  "AWS.RDS.DBProxy",
  DBProxyProps,
  {
    dbProxyName: string;
    dbProxyArn: string;
    endpoint: string | undefined;
    status: string | undefined;
    engineFamily: string | undefined;
    roleArn: string | undefined;
    vpcId: string | undefined;
    vpcSubnetIds: string[];
    vpcSecurityGroupIds: string[];
    requireTLS: boolean | undefined;
    idleClientTimeout: number | undefined;
    debugLogging: boolean | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An RDS Proxy for pooled Lambda-to-Aurora connectivity.
 */
export const DBProxy = Resource<DBProxy>("AWS.RDS.DBProxy");

const toAttrs = ({
  proxy,
  tags,
}: {
  proxy: rds.DBProxy;
  tags: Record<string, string>;
}): DBProxy["Attributes"] => ({
  dbProxyName: proxy.DBProxyName ?? "",
  dbProxyArn: proxy.DBProxyArn ?? "",
  endpoint: proxy.Endpoint,
  status: proxy.Status,
  engineFamily: proxy.EngineFamily,
  roleArn: proxy.RoleArn,
  vpcId: proxy.VpcId,
  vpcSubnetIds: proxy.VpcSubnetIds ?? [],
  vpcSecurityGroupIds: proxy.VpcSecurityGroupIds ?? [],
  requireTLS: proxy.RequireTLS,
  idleClientTimeout: proxy.IdleClientTimeout,
  debugLogging: proxy.DebugLogging,
  tags,
});

export const DBProxyProvider = () =>
  Provider.effect(
    DBProxy,
    Effect.gen(function* () {
      const toName = (id: string, props: DBProxyProps) =>
        props.dbProxyName
          ? Effect.succeed(props.dbProxyName)
          : createPhysicalName({ id, maxLength: 63 });

      const readProxy = Effect.fn(function* (name: string) {
        const response = yield* rds
          .describeDBProxies({
            DBProxyName: name,
          })
          .pipe(
            Effect.catchTag("DBProxyNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.DBProxies?.[0];
      });

      const waitForProxy = Effect.fn(function* (name: string) {
        const readinessPolicy = Schedule.fixed("2 seconds").pipe(
          Schedule.both(Schedule.recurs(30)),
        );
        return yield* readProxy(name).pipe(
          Effect.flatMap((proxy) =>
            proxy?.DBProxyArn
              ? Effect.succeed(proxy)
              : Effect.fail(new Error(`DB proxy '${name}' not ready`)),
          ),
          Effect.retry({ schedule: readinessPolicy }),
        );
      });

      return {
        stables: ["dbProxyArn", "dbProxyName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? ({} as DBProxyProps))) !==
            (yield* toName(id, news))
          ) {
            return { action: "replace" } as const;
          }
          if (olds?.engineFamily !== news.engineFamily) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.dbProxyName ??
            (yield* toName(
              id,
              olds ??
                ({
                  engineFamily: "POSTGRESQL",
                  auth: [],
                  roleArn: "",
                  vpcSubnetIds: [],
                } as DBProxyProps),
            ));
          const proxy = yield* readProxy(name);
          if (!proxy?.DBProxyArn) {
            return undefined;
          }
          return toAttrs({ proxy, tags: output?.tags ?? {} });
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.dbProxyName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — fetch live proxy state.
          let observed = yield* readProxy(name);

          // Ensure — create if missing. Tolerate
          // `DBProxyAlreadyExistsFault` as a race with a peer reconciler.
          if (!observed?.DBProxyArn) {
            yield* rds
              .createDBProxy({
                DBProxyName: name,
                EngineFamily: news.engineFamily,
                Auth: news.auth,
                RoleArn: news.roleArn,
                VpcSubnetIds: news.vpcSubnetIds,
                VpcSecurityGroupIds: news.vpcSecurityGroupIds,
                RequireTLS: news.requireTLS,
                IdleClientTimeout: news.idleClientTimeout,
                DebugLogging: news.debugLogging,
                EndpointNetworkType: news.endpointNetworkType,
                TargetConnectionNetworkType: news.targetConnectionNetworkType,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag("DBProxyAlreadyExistsFault", () => Effect.void),
              );

            observed = yield* waitForProxy(name);
          } else {
            // Sync mutable proxy config — push desired shape via
            // `modifyDBProxy`. Rename via `NewDBProxyName` is a no-op when
            // the desired name already matches the observed name.
            yield* rds.modifyDBProxy({
              DBProxyName: name,
              Auth: news.auth,
              RoleArn: news.roleArn,
              SecurityGroups: news.vpcSecurityGroupIds,
              RequireTLS: news.requireTLS,
              IdleClientTimeout: news.idleClientTimeout,
              DebugLogging: news.debugLogging,
              NewDBProxyName:
                news.dbProxyName && news.dbProxyName !== name
                  ? news.dbProxyName
                  : undefined,
            });
            observed = yield* waitForProxy(news.dbProxyName ?? name);
          }

          const dbProxyArn = observed.DBProxyArn ?? "";
          const finalName = observed.DBProxyName ?? name;

          // Sync tags — diff prior recorded tags against desired (describe
          // does not surface tags inline).
          const observedTags = output?.tags ?? {};
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0 && dbProxyArn) {
            yield* rds.addTagsToResource({
              ResourceName: dbProxyArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0 && dbProxyArn) {
            yield* rds.removeTagsFromResource({
              ResourceName: dbProxyArn,
              TagKeys: removed,
            });
          }

          yield* session.note(dbProxyArn || finalName);
          return toAttrs({ proxy: observed, tags: desiredTags });
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* rds
            .deleteDBProxy({
              DBProxyName: output.dbProxyName,
            })
            .pipe(Effect.catchTag("DBProxyNotFoundFault", () => Effect.void));
        }),
      };
    }),
  );
