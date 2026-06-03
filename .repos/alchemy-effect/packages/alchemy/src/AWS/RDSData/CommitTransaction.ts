import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import type { Secret } from "../SecretsManager/Secret.ts";

export interface CommitTransactionOptions {
  secret: Secret;
}

export interface CommitTransactionRequest extends Omit<
  rdsdata.CommitTransactionRequest,
  "resourceArn" | "secretArn"
> {}

/**
 * Runtime binding for `rds-data:CommitTransaction`.
 */
export class CommitTransaction extends Binding.Service<
  CommitTransaction,
  (
    cluster: DBCluster,
    options: CommitTransactionOptions,
  ) => Effect.Effect<
    (
      request: CommitTransactionRequest,
    ) => Effect.Effect<
      rdsdata.CommitTransactionResponse,
      rdsdata.CommitTransactionError
    >
  >
>()("AWS.RDSData.CommitTransaction") {}

export const CommitTransactionLive = Layer.effect(
  CommitTransaction,
  Effect.gen(function* () {
    const Policy = yield* CommitTransactionPolicy;
    const commitTransaction = yield* rdsdata.commitTransaction;

    return Effect.fn(function* (
      cluster: DBCluster,
      options: CommitTransactionOptions,
    ) {
      const resourceArn = yield* cluster.dbClusterArn;
      const secretArn = yield* options.secret.secretArn;
      yield* Policy(cluster, options);
      return Effect.fn(function* (request: CommitTransactionRequest) {
        const clusterArn = yield* resourceArn;
        const resolvedSecretArn = yield* secretArn;
        return yield* commitTransaction({
          ...request,
          resourceArn: clusterArn,
          secretArn: resolvedSecretArn,
        });
      });
    });
  }),
);

export class CommitTransactionPolicy extends Binding.Policy<
  CommitTransactionPolicy,
  (cluster: DBCluster, options: CommitTransactionOptions) => Effect.Effect<void>
>()("AWS.RDSData.CommitTransaction") {}

export const CommitTransactionPolicyLive =
  CommitTransactionPolicy.layer.succeed(
    Effect.fn(function* (host, cluster, options) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.RDSData.CommitTransaction(${cluster}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["rds-data:CommitTransaction"],
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
          `CommitTransactionPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
