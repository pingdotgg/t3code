import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import type { Secret } from "../SecretsManager/Secret.ts";

export interface BeginTransactionOptions {
  secret: Secret;
  database?: string;
  schema?: string;
}

/**
 * Runtime binding for `rds-data:BeginTransaction`.
 */
export class BeginTransaction extends Binding.Service<
  BeginTransaction,
  (
    cluster: DBCluster,
    options: BeginTransactionOptions,
  ) => Effect.Effect<
    () => Effect.Effect<
      rdsdata.BeginTransactionResponse,
      rdsdata.BeginTransactionError
    >
  >
>()("AWS.RDSData.BeginTransaction") {}

export const BeginTransactionLive = Layer.effect(
  BeginTransaction,
  Effect.gen(function* () {
    const Policy = yield* BeginTransactionPolicy;
    const beginTransaction = yield* rdsdata.beginTransaction;

    return Effect.fn(function* (
      cluster: DBCluster,
      options: BeginTransactionOptions,
    ) {
      const resourceArn = yield* cluster.dbClusterArn;
      const secretArn = yield* options.secret.secretArn;
      yield* Policy(cluster, options);
      return Effect.fn(function* () {
        const clusterArn = yield* resourceArn;
        const resolvedSecretArn = yield* secretArn;
        return yield* beginTransaction({
          resourceArn: clusterArn,
          secretArn: resolvedSecretArn,
          database: options.database,
          schema: options.schema,
        });
      });
    });
  }),
);

export class BeginTransactionPolicy extends Binding.Policy<
  BeginTransactionPolicy,
  (cluster: DBCluster, options: BeginTransactionOptions) => Effect.Effect<void>
>()("AWS.RDSData.BeginTransaction") {}

export const BeginTransactionPolicyLive = BeginTransactionPolicy.layer.succeed(
  Effect.fn(function* (host, cluster, options) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.RDSData.BeginTransaction(${cluster}))`(
        {
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["rds-data:BeginTransaction"],
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
        `BeginTransactionPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
