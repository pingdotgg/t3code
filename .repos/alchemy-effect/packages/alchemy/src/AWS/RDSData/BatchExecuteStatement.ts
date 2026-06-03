import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import type { Secret } from "../SecretsManager/Secret.ts";

export interface BatchExecuteStatementOptions {
  secret: Secret;
  database?: string;
  schema?: string;
}

export interface BatchExecuteStatementRequest extends Omit<
  rdsdata.BatchExecuteStatementRequest,
  "resourceArn" | "secretArn" | "database" | "schema"
> {}

/**
 * Runtime binding for `rds-data:BatchExecuteStatement`.
 */
export class BatchExecuteStatement extends Binding.Service<
  BatchExecuteStatement,
  (
    cluster: DBCluster,
    options: BatchExecuteStatementOptions,
  ) => Effect.Effect<
    (
      request: BatchExecuteStatementRequest,
    ) => Effect.Effect<
      rdsdata.BatchExecuteStatementResponse,
      rdsdata.BatchExecuteStatementError
    >
  >
>()("AWS.RDSData.BatchExecuteStatement") {}

export const BatchExecuteStatementLive = Layer.effect(
  BatchExecuteStatement,
  Effect.gen(function* () {
    const Policy = yield* BatchExecuteStatementPolicy;
    const batchExecuteStatement = yield* rdsdata.batchExecuteStatement;

    return Effect.fn(function* (
      cluster: DBCluster,
      options: BatchExecuteStatementOptions,
    ) {
      const resourceArn = yield* cluster.dbClusterArn;
      const secretArn = yield* options.secret.secretArn;
      yield* Policy(cluster, options);
      return Effect.fn(function* (request: BatchExecuteStatementRequest) {
        const clusterArn = yield* resourceArn;
        const resolvedSecretArn = yield* secretArn;
        return yield* batchExecuteStatement({
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

export class BatchExecuteStatementPolicy extends Binding.Policy<
  BatchExecuteStatementPolicy,
  (
    cluster: DBCluster,
    options: BatchExecuteStatementOptions,
  ) => Effect.Effect<void>
>()("AWS.RDSData.BatchExecuteStatement") {}

export const BatchExecuteStatementPolicyLive =
  BatchExecuteStatementPolicy.layer.succeed(
    Effect.fn(function* (host, cluster, options) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.RDSData.BatchExecuteStatement(${cluster}, ${options.secret}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["rds-data:BatchExecuteStatement"],
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
          `BatchExecuteStatementPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
