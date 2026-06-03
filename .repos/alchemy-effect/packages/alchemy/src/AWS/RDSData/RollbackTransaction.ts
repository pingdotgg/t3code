import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import type { Secret } from "../SecretsManager/Secret.ts";

export interface RollbackTransactionOptions {
  secret: Secret;
}

export interface RollbackTransactionRequest extends Omit<
  rdsdata.RollbackTransactionRequest,
  "resourceArn" | "secretArn"
> {}

/**
 * Runtime binding for `rds-data:RollbackTransaction`.
 */
export class RollbackTransaction extends Binding.Service<
  RollbackTransaction,
  (
    cluster: DBCluster,
    options: RollbackTransactionOptions,
  ) => Effect.Effect<
    (
      request: RollbackTransactionRequest,
    ) => Effect.Effect<
      rdsdata.RollbackTransactionResponse,
      rdsdata.RollbackTransactionError
    >
  >
>()("AWS.RDSData.RollbackTransaction") {}

export const RollbackTransactionLive = Layer.effect(
  RollbackTransaction,
  Effect.gen(function* () {
    const Policy = yield* RollbackTransactionPolicy;
    const rollbackTransaction = yield* rdsdata.rollbackTransaction;

    return Effect.fn(function* (
      cluster: DBCluster,
      options: RollbackTransactionOptions,
    ) {
      const resourceArn = yield* cluster.dbClusterArn;
      const secretArn = yield* options.secret.secretArn;
      yield* Policy(cluster, options);
      return Effect.fn(function* (request: RollbackTransactionRequest) {
        const clusterArn = yield* resourceArn;
        const resolvedSecretArn = yield* secretArn;
        return yield* rollbackTransaction({
          ...request,
          resourceArn: clusterArn,
          secretArn: resolvedSecretArn,
        });
      });
    });
  }),
);

export class RollbackTransactionPolicy extends Binding.Policy<
  RollbackTransactionPolicy,
  (
    cluster: DBCluster,
    options: RollbackTransactionOptions,
  ) => Effect.Effect<void>
>()("AWS.RDSData.RollbackTransaction") {}

export const RollbackTransactionPolicyLive =
  RollbackTransactionPolicy.layer.succeed(
    Effect.fn(function* (host, cluster, options) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.RDSData.RollbackTransaction(${cluster}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["rds-data:RollbackTransaction"],
                Resource: [cluster.dbClusterArn, options.secret.secretArn],
              },
            ],
          },
        );
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
          `RollbackTransactionPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
