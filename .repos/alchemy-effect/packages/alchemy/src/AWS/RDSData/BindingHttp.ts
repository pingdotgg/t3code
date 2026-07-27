/**
 * Shared scaffolding for RDS Data API HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, makeRDSDataHttpBinding({ … }))`. Every Data API
 * operation follows the same shape: it is scoped to a Data-API-enabled
 * {@link DBCluster} plus the Secrets Manager {@link Secret} holding the
 * database credentials, the deploy-time half grants the `rds-data:*` action
 * on the cluster + secret ARNs (plus `secretsmanager:GetSecretValue` /
 * `DescribeSecret` on the secret, which the Data API resolves server-side),
 * and the runtime half injects the resolved ARNs (and optional
 * `database`/`schema`) into the wire request. Everything except the
 * operation, the IAM action, and the request shaping is boilerplate.
 */
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import type { Secret } from "../SecretsManager/Secret.ts";

/**
 * The common bind-time options every RDS Data API capability accepts: the
 * credentials secret, plus the optional default `database`/`schema` injected
 * into requests by operations that support them.
 */
export interface RDSDataBindingOptions {
  secret: Secret;
  database?: string;
  schema?: string;
}

/**
 * Build the impl Effect for an RDS Data API operation scoped to a
 * {@link DBCluster} + credentials {@link Secret}: the deploy-time half grants
 * `action` on the cluster and secret ARNs (plus Secrets Manager read on the
 * secret), and the runtime half shapes the wire request via `makeInput` with
 * the resolved ARNs and bind-time `database`/`schema`.
 */
export const makeRDSDataHttpBinding = <Req, I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.RDSData.ExecuteStatement`. */
  tag: string;
  /** IAM action granted on the cluster + secret ARNs, e.g. `rds-data:ExecuteStatement`. */
  action: string;
  /** The distilled operation invoked with the shaped wire request. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /**
   * Shape the wire request from the caller's request plus the resolved
   * cluster/secret ARNs and the bind-time `database`/`schema`.
   */
  makeInput: (
    request: Req,
    context: {
      resourceArn: string;
      secretArn: string;
      database: string | undefined;
      schema: string | undefined;
    },
  ) => I;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (
      cluster: DBCluster,
      bindOptions: RDSDataBindingOptions,
    ) {
      const resourceArn = yield* cluster.dbClusterArn;
      const secretArn = yield* bindOptions.secret.secretArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${cluster}, ${bindOptions.secret}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [options.action],
                  Resource: [
                    cluster.dbClusterArn,
                    bindOptions.secret.secretArn,
                  ],
                },
                {
                  Effect: "Allow",
                  Action: [
                    "secretsmanager:GetSecretValue",
                    "secretsmanager:DescribeSecret",
                  ],
                  Resource: [bindOptions.secret.secretArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`${options.tag}(${cluster.LogicalId})`)(function* (
        // optional so zero-arg callables (`BeginTransaction`) conform to
        // their declared `() => Effect<…>` interface; `makeInput` receives
        // `undefined` there and builds the request from context alone.
        request?: Req,
      ) {
        return yield* op(
          options.makeInput(request as Req, {
            resourceArn: yield* resourceArn,
            secretArn: yield* secretArn,
            database: bindOptions.database,
            schema: bindOptions.schema,
          }),
        );
      });
    });
  });
