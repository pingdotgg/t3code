import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import type { Secret } from "../SecretsManager/Secret.ts";

export interface ExecuteStatementOptions {
  secret: Secret;
  database?: string;
  schema?: string;
}

export interface ExecuteStatementRequest extends Omit<
  rdsdata.ExecuteStatementRequest,
  "resourceArn" | "secretArn" | "database" | "schema"
> {}

/**
 * Runtime binding for `rds-data:ExecuteStatement`.
 */
export class ExecuteStatement extends Binding.Service<
  ExecuteStatement,
  (
    cluster: DBCluster,
    options: ExecuteStatementOptions,
  ) => Effect.Effect<
    (
      request: ExecuteStatementRequest,
    ) => Effect.Effect<
      rdsdata.ExecuteStatementResponse,
      rdsdata.ExecuteStatementError
    >
  >
>()("AWS.RDSData.ExecuteStatement") {}

export const ExecuteStatementLive = Layer.effect(
  ExecuteStatement,
  Effect.gen(function* () {
    const Policy = yield* ExecuteStatementPolicy;
    const executeStatement = yield* rdsdata.executeStatement;

    return Effect.fn(function* (
      cluster: DBCluster,
      options: ExecuteStatementOptions,
    ) {
      const resourceArn = yield* cluster.dbClusterArn;
      const secretArn = yield* options.secret.secretArn;
      yield* Policy(cluster, options);
      return Effect.fn(function* (request: ExecuteStatementRequest) {
        const clusterArn = yield* resourceArn;
        const resolvedSecretArn = yield* secretArn;
        return yield* executeStatement({
          ...request,
          resourceArn: clusterArn,
          secretArn: resolvedSecretArn,
          database: options.database,
          schema: options.schema,
        });
      });
    });
  }),
);

export class ExecuteStatementPolicy extends Binding.Policy<
  ExecuteStatementPolicy,
  (cluster: DBCluster, options: ExecuteStatementOptions) => Effect.Effect<void>
>()("AWS.RDSData.ExecuteStatement") {}

export const ExecuteStatementPolicyLive = ExecuteStatementPolicy.layer.succeed(
  Effect.fn(function* (host, cluster, options) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.RDSData.ExecuteStatement(${cluster}, ${options.secret}))`(
        {
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["rds-data:ExecuteStatement"],
              Resource: [cluster.dbClusterArn, options.secret.secretArn],
            },
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
        `ExecuteStatementPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
