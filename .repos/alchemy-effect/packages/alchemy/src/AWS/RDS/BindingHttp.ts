import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { DBCluster } from "./DBCluster.ts";
import type { DBInstance } from "./DBInstance.ts";

/**
 * Shared scaffolding for Amazon RDS HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the builders
 * below. Everything except the operation, the identifier resolver, and the
 * IAM action list is boilerplate.
 */

/**
 * Build the impl Effect for an account-level operation (cluster/instance
 * discovery, event history, snapshot administration). The deploy-time half
 * grants `actions` on `*` — these operations span every database in the
 * account and the identifiers they filter on are runtime data.
 */
export const makeRdsAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.RDS.DescribeEvents`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(options.tag)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });

/**
 * Build the impl Effect for a cluster-scoped operation: the runtime callable
 * injects the bound {@link DBCluster}'s identifier as `DBClusterIdentifier`
 * and the deploy-time half grants `actions` on the cluster ARN (plus any
 * `extraResources`, e.g. the `cluster-snapshot` ARN pattern for snapshot
 * creation).
 */
export const makeRdsClusterHttpBinding = <
  I extends { DBClusterIdentifier?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.RDS.FailoverDBCluster`. */
  tag: string;
  /** The distilled operation; `DBClusterIdentifier` is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the cluster ARN. */
  actions: readonly string[];
  /** Additional IAM resource ARNs derived from the cluster ARN. */
  extraResources?: (clusterArn: string) => string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (cluster: DBCluster) {
      const Identifier = yield* cluster.dbClusterIdentifier;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const resources = options.extraResources;
          yield* host.bind`Allow(${host}, ${options.tag}(${cluster}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: resources
                  ? Output.map(cluster.dbClusterArn, (arn) => [
                      arn,
                      ...resources(arn),
                    ])
                  : [Output.interpolate`${cluster.dbClusterArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${cluster.LogicalId})`)(function* (
        request?: Omit<I, "DBClusterIdentifier">,
      ) {
        return yield* op({
          ...request,
          DBClusterIdentifier: yield* Identifier,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an instance-scoped operation: the runtime
 * callable injects the bound {@link DBInstance}'s identifier as
 * `DBInstanceIdentifier` and the deploy-time half grants `actions` on the
 * instance ARN (plus any `extraResources`, e.g. the `snapshot` ARN pattern
 * for snapshot creation).
 */
export const makeRdsInstanceHttpBinding = <
  I extends { DBInstanceIdentifier?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.RDS.RebootDBInstance`. */
  tag: string;
  /** The distilled operation; `DBInstanceIdentifier` is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the instance ARN. */
  actions: readonly string[];
  /** Additional IAM resource ARNs derived from the instance ARN. */
  extraResources?: (instanceArn: string) => string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (instance: DBInstance) {
      const Identifier = yield* instance.dbInstanceIdentifier;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const resources = options.extraResources;
          yield* host.bind`Allow(${host}, ${options.tag}(${instance}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: resources
                  ? Output.map(instance.dbInstanceArn, (arn) => [
                      arn,
                      ...resources(arn),
                    ])
                  : [Output.interpolate`${instance.dbInstanceArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${instance.LogicalId})`)(function* (
        request?: Omit<I, "DBInstanceIdentifier">,
      ) {
        return yield* op({
          ...request,
          DBInstanceIdentifier: yield* Identifier,
        } as I);
      });
    });
  });
