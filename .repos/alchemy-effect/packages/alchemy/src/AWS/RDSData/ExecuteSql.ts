import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import type { Secret } from "../SecretsManager/Secret.ts";

export interface ExecuteSqlOptions {
  secret: Secret;
  database?: string;
  schema?: string;
}

export interface ExecuteSqlRequest extends Omit<
  rdsdata.ExecuteSqlRequest,
  "dbClusterOrInstanceArn" | "awsSecretStoreArn" | "database" | "schema"
> {}

/**
 * Runtime binding for the deprecated `rds-data:ExecuteSql` API.
 */
export class ExecuteSql extends Binding.Service<
  ExecuteSql,
  (
    cluster: DBCluster,
    options: ExecuteSqlOptions,
  ) => Effect.Effect<
    (
      request: ExecuteSqlRequest,
    ) => Effect.Effect<rdsdata.ExecuteSqlResponse, rdsdata.ExecuteSqlError>
  >
>()("AWS.RDSData.ExecuteSql") {}

export const ExecuteSqlLive = Layer.effect(
  ExecuteSql,
  Effect.gen(function* () {
    const Policy = yield* ExecuteSqlPolicy;
    const executeSql = yield* rdsdata.executeSql;

    return Effect.fn(function* (
      cluster: DBCluster,
      options: ExecuteSqlOptions,
    ) {
      const clusterArn = yield* cluster.dbClusterArn;
      const secretArn = yield* options.secret.secretArn;
      yield* Policy(cluster, options);
      return Effect.fn(function* (request: ExecuteSqlRequest) {
        return yield* executeSql({
          ...request,
          dbClusterOrInstanceArn: yield* clusterArn,
          awsSecretStoreArn: yield* secretArn,
          database: options.database,
          schema: options.schema,
        });
      });
    });
  }),
);

export class ExecuteSqlPolicy extends Binding.Policy<
  ExecuteSqlPolicy,
  (cluster: DBCluster, options: ExecuteSqlOptions) => Effect.Effect<void>
>()("AWS.RDSData.ExecuteSql") {}

export const ExecuteSqlPolicyLive = ExecuteSqlPolicy.layer.succeed(
  Effect.fn(function* (host, cluster, options) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.RDSData.ExecuteSql(${cluster}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["rds-data:ExecuteSql"],
            Resource: [cluster.dbClusterArn, options.secret.secretArn],
          },
        ],
      });
      yield* host.bind`Allow(${host}, AWS.SecretsManager.GetSecretValue(${options.secret}))`(
        {
          policyStatements: [
            {
              Effect: "Allow",
              Action: [
                "secretsmanager:GetSecretValue",
                "secretsmanager:DescribeSecret",
              ],
              Resource: [options.secret.secretArn],
            },
          ],
        },
      );
    } else {
      return yield* Effect.die(
        `ExecuteSqlPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
