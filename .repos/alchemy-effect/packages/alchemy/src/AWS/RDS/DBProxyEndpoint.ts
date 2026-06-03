import * as rds from "@distilled.cloud/aws/rds";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";

export interface DBProxyEndpointProps {
  /**
   * Proxy endpoint name. If omitted, Alchemy generates one.
   */
  dbProxyEndpointName?: string;
  /**
   * Proxy that owns the endpoint.
   */
  dbProxyName: string;
  /**
   * Subnets used by the proxy endpoint.
   */
  vpcSubnetIds: string[];
  /**
   * Security groups attached to the endpoint.
   */
  vpcSecurityGroupIds?: string[];
  /**
   * Target role for the endpoint.
   */
  targetRole?: rds.DBProxyEndpointTargetRole;
  /**
   * Endpoint network type.
   */
  endpointNetworkType?: rds.EndpointNetworkType;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface DBProxyEndpoint extends Resource<
  "AWS.RDS.DBProxyEndpoint",
  DBProxyEndpointProps,
  {
    dbProxyEndpointName: string;
    dbProxyEndpointArn: string;
    dbProxyName: string | undefined;
    endpoint: string | undefined;
    status: string | undefined;
    vpcId: string | undefined;
    vpcSubnetIds: string[];
    vpcSecurityGroupIds: string[];
    targetRole: string | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An additional RDS Proxy endpoint.
 */
export const DBProxyEndpoint = Resource<DBProxyEndpoint>(
  "AWS.RDS.DBProxyEndpoint",
);

const toAttrs = ({
  endpoint,
  tags,
}: {
  endpoint: rds.DBProxyEndpoint;
  tags: Record<string, string>;
}): DBProxyEndpoint["Attributes"] => ({
  dbProxyEndpointName: endpoint.DBProxyEndpointName ?? "",
  dbProxyEndpointArn: endpoint.DBProxyEndpointArn ?? "",
  dbProxyName: endpoint.DBProxyName,
  endpoint: endpoint.Endpoint,
  status: endpoint.Status,
  vpcId: endpoint.VpcId,
  vpcSubnetIds: endpoint.VpcSubnetIds ?? [],
  vpcSecurityGroupIds: endpoint.VpcSecurityGroupIds ?? [],
  targetRole: endpoint.TargetRole,
  tags,
});

export const DBProxyEndpointProvider = () =>
  Provider.effect(
    DBProxyEndpoint,
    Effect.gen(function* () {
      const toName = (id: string, props: DBProxyEndpointProps) =>
        props.dbProxyEndpointName
          ? Effect.succeed(props.dbProxyEndpointName)
          : createPhysicalName({ id, maxLength: 63 });

      const readEndpoint = Effect.fn(function* ({
        dbProxyName,
        dbProxyEndpointName,
      }: {
        dbProxyName: string;
        dbProxyEndpointName: string;
      }) {
        const response = yield* rds
          .describeDBProxyEndpoints({
            DBProxyName: dbProxyName,
            DBProxyEndpointName: dbProxyEndpointName,
          })
          .pipe(
            Effect.catchTag("DBProxyEndpointNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.DBProxyEndpoints?.[0];
      });

      const waitForEndpoint = Effect.fn(function* (props: {
        dbProxyName: string;
        dbProxyEndpointName: string;
      }) {
        const readinessPolicy = Schedule.fixed("2 seconds").pipe(
          Schedule.both(Schedule.recurs(30)),
        );
        return yield* readEndpoint(props).pipe(
          Effect.flatMap((endpoint) =>
            endpoint?.DBProxyEndpointArn
              ? Effect.succeed(endpoint)
              : Effect.fail(
                  new Error(
                    `DB proxy endpoint '${props.dbProxyEndpointName}' not ready`,
                  ),
                ),
          ),
          Effect.retry({ schedule: readinessPolicy }),
        );
      });

      return {
        stables: ["dbProxyEndpointArn", "dbProxyEndpointName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? ({} as DBProxyEndpointProps))) !==
            (yield* toName(id, news))
          ) {
            return { action: "replace" } as const;
          }
          if (olds?.dbProxyName !== news.dbProxyName) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const dbProxyEndpointName =
            output?.dbProxyEndpointName ??
            (yield* toName(
              id,
              olds ??
                ({
                  dbProxyName: "",
                  vpcSubnetIds: [],
                } as DBProxyEndpointProps),
            ));
          const endpoint = yield* readEndpoint({
            dbProxyName: output?.dbProxyName ?? olds?.dbProxyName ?? "",
            dbProxyEndpointName,
          });
          if (!endpoint?.DBProxyEndpointArn) {
            return undefined;
          }
          return toAttrs({ endpoint, tags: output?.tags ?? {} });
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const dbProxyEndpointName =
            output?.dbProxyEndpointName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — fetch live endpoint state.
          let observed = yield* readEndpoint({
            dbProxyName: output?.dbProxyName ?? news.dbProxyName,
            dbProxyEndpointName,
          });

          // Ensure — create if missing. Tolerate
          // `DBProxyEndpointAlreadyExistsFault` as a race with a peer
          // reconciler.
          if (!observed?.DBProxyEndpointArn) {
            yield* rds
              .createDBProxyEndpoint({
                DBProxyName: news.dbProxyName,
                DBProxyEndpointName: dbProxyEndpointName,
                VpcSubnetIds: news.vpcSubnetIds,
                VpcSecurityGroupIds: news.vpcSecurityGroupIds,
                TargetRole: news.targetRole,
                EndpointNetworkType: news.endpointNetworkType,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag(
                  "DBProxyEndpointAlreadyExistsFault",
                  () => Effect.void,
                ),
              );

            observed = yield* waitForEndpoint({
              dbProxyName: news.dbProxyName,
              dbProxyEndpointName,
            });
          } else {
            // Sync mutable endpoint config — security groups + rename. The
            // rename argument is a no-op when desired matches observed.
            yield* rds.modifyDBProxyEndpoint({
              DBProxyEndpointName: dbProxyEndpointName,
              VpcSecurityGroupIds: news.vpcSecurityGroupIds,
              NewDBProxyEndpointName:
                news.dbProxyEndpointName &&
                news.dbProxyEndpointName !== dbProxyEndpointName
                  ? news.dbProxyEndpointName
                  : undefined,
            });
            observed = yield* waitForEndpoint({
              dbProxyName: observed.DBProxyName ?? news.dbProxyName,
              dbProxyEndpointName:
                news.dbProxyEndpointName &&
                news.dbProxyEndpointName !== dbProxyEndpointName
                  ? news.dbProxyEndpointName
                  : dbProxyEndpointName,
            });
          }

          const dbProxyEndpointArn = observed.DBProxyEndpointArn ?? "";

          // Sync tags — diff prior recorded tags against desired (describe
          // does not surface tags inline).
          const observedTags = output?.tags ?? {};
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0 && dbProxyEndpointArn) {
            yield* rds.addTagsToResource({
              ResourceName: dbProxyEndpointArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0 && dbProxyEndpointArn) {
            yield* rds.removeTagsFromResource({
              ResourceName: dbProxyEndpointArn,
              TagKeys: removed,
            });
          }

          yield* session.note(dbProxyEndpointArn || dbProxyEndpointName);
          return toAttrs({ endpoint: observed, tags: desiredTags });
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* rds
            .deleteDBProxyEndpoint({
              DBProxyEndpointName: output.dbProxyEndpointName,
            })
            .pipe(
              Effect.catchTag(
                "DBProxyEndpointNotFoundFault",
                () => Effect.void,
              ),
            );
        }),
      };
    }),
  );
